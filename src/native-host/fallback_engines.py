"""Fallback download engines for sites yt-dlp cannot handle.

Provides gallery-dl support for image/gallery sites and a direct HTTP
downloader for explicit media URLs (direct .mp4 / .webm / .mp3 links).
"""

import importlib.util
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from shutil import which
from threading import Event

from native_protocol import HostError
from process_control import creation_flags


def resolve_gallery_dl_command():
    """Locate the gallery-dl executable (binary or python -m module)."""
    executable = which("gallery-dl")
    if executable:
        return [executable]

    if importlib.util.find_spec("gallery_dl") is not None:
        return [sys.executable, "-m", "gallery_dl"]

    return None


def has_gallery_dl():
    """Check whether gallery-dl is available."""
    return resolve_gallery_dl_command() is not None


def list_formats_gallery_dl(url, timeout=45):
    """Query gallery-dl for downloadable formats.

    Returns a list of format-like dicts that can be surfaced in
    the Qwin format picker, or None if gallery-dl is unavailable
    or does not support the URL.

    The returned dicts use the same shape as yt-dlp summaries:
      { "id": …, "label": …, "ext": …, "size": …, "note": … }

    May raise HostError on unexpected gallery-dl failures.
    """
    cmd = resolve_gallery_dl_command()
    if not cmd:
        return None

    command = [
        *cmd,
        "--dump-json",
        "--no-colors",
        "--no-mtime",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creation_flags(),
        )
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return None

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        if "Unsupported URL" in stderr or "no extractor" in stderr.lower():
            return None  # gallery-dl doesn't support this URL
        return None

    # gallery-dl --dump-json outputs one JSON object per found item
    formats = []
    for line in (completed.stdout or "").strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        title = entry.get("title") or entry.get("filename") or "Media"
        ext = entry.get("extension") or "jpg"
        filesize = entry.get("filesize") or entry.get("filesize_approx") or 0

        # Build a format entry for each direct URL in the entry
        urls = []
        if entry.get("url"):
            urls.append(("direct", entry["url"], ext))
        for url_entry in entry.get("urls") or []:
            if isinstance(url_entry, dict):
                u = url_entry.get("url") or ""
                e = url_entry.get("ext") or ext
                if u:
                    urls.append((url_entry.get("name") or "stream", u, e))

        for name, direct_url, fmt_ext in urls:
            fmt_id = f"gd_{entry.get('id', '0')}_{name}"
            size_str = _human_size(filesize) if filesize else ""
            formats.append(
                {
                    "id": fmt_id,
                    "label": f"{title} [{name}]" if name != "direct" else title,
                    "ext": fmt_ext,
                    "size": size_str,
                    "note": "gallery-dl",
                    "url": direct_url,
                    "_gallery_dl_entry": entry,
                }
            )

    return formats or None


def download_with_gallery_dl(
    url,
    download_dir,
    cancel_event=None,
    progress_callback=None,
    entry_id=None,
):
    """Download a URL using gallery-dl.

    Runs gallery-dl in the background, optionally reporting progress
    and checking for cancellation.

    Returns the path to the downloaded file/directory, or None on
    cancellation. Raises HostError on failure.
    """
    cmd = resolve_gallery_dl_command()
    if not cmd:
        raise HostError("gallery-dl is not installed.")

    command = [
        *cmd,
        "--directory",
        str(download_dir),
        "--no-colors",
        "--no-mtime",
    ]
    if entry_id:
        command.extend(["--filter", f"id == '{entry_id}'"])

    command.append(str(url))

    cancel = cancel_event or Event()
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creation_flags(),
        )
    except OSError as exc:
        raise HostError(f"Could not start gallery-dl: {exc}") from exc

    last_path = None
    assert process.stdout is not None
    for line in iter(process.stdout.readline, ""):
        if cancel.is_set():
            process.kill()
            process.wait()
            return None
        stripped = line.rstrip("\n\r")
        if progress_callback:
            progress_callback(stripped)
        # gallery-dl prints "Saved ..." lines with the output path
        if "saved" in stripped.lower() and download_dir in stripped:
            # Try to extract the file path from the output
            parts = stripped.split("'")
            if len(parts) >= 2:
                last_path = parts[1]

    exit_code = process.wait()
    if exit_code != 0:
        raise HostError(f"gallery-dl exited with status {exit_code}.")

    # If we didn't capture the path from output, scan the download dir
    if not last_path:
        last_path = _find_latest_file(download_dir)

    return last_path


# ---------------------------------------------------------------------------
# you-get — video downloader with strong Asian platform support
# ---------------------------------------------------------------------------


_YOU_GET_STREAM_RE = re.compile(
    r"-\s*(format|quality|stream)[:\s]+(.+)", re.IGNORECASE
)


def resolve_you_get_command():
    """Locate the you-get executable (binary or python -m module).

    you-get is a Python-based video downloader that supports many
    Asian media platforms (Bilibili, Douyin/TikTok, Weibo, AcFun,
    Niconico, etc.) better than yt-dlp.

    Returns:
        List of command arguments, or None if not found.
    """
    executable = which("you-get")
    if executable:
        return [executable]

    if importlib.util.find_spec("you_get") is not None:
        return [sys.executable, "-m", "you_get"]

    return None


def has_you_get():
    """Check whether you-get is available."""
    return resolve_you_get_command() is not None


def list_formats_you_get(url, timeout=30):
    """Query you-get for downloadable formats.

    you-get outputs stream information when given --info or --json.
    We parse its output to produce a list of format-like dicts
    compatible with the Qwin format picker.

    Args:
        url: Video URL to query.
        timeout: Seconds to wait for you-get to respond.

    Returns:
        List of dicts with id, label, ext, size, note keys,
        or None if you-get is unavailable or doesn't support the URL.
    """
    cmd = resolve_you_get_command()
    if not cmd:
        return None

    command = [
        *cmd,
        "--info",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creation_flags(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        if "unsupported" in stderr.lower() or "not supported" in stderr.lower():
            return None
        return None

    output = (completed.stdout or "") + (completed.stderr or "")
    return _parse_you_get_output(output, url)


def _parse_you_get_output(output, url):
    """Parse you-get --info output into a list of format entries."""
    formats = []
    lines = output.strip().splitlines()

    title = "Video"
    for line in lines:
        if line.startswith("Title:"):
            title = line.split(":", 1)[1].strip()
            break

    # Parse stream entries (you-get shows multiple streams with --info)
    current_stream = {}
    for line in lines:
        line_stripped = line.strip()
        if line_stripped.startswith("-"):
            # Save previous stream if we have one
            if current_stream and current_stream.get("format"):
                _add_you_get_format(formats, title, current_stream)
            current_stream = {"lines": [line_stripped]}
            _parse_you_get_line(current_stream, line_stripped)
        elif current_stream:
            current_stream.setdefault("lines", []).append(line_stripped)
            _parse_you_get_line(current_stream, line_stripped)

    # Save last stream
    if current_stream and current_stream.get("format"):
        _add_you_get_format(formats, title, current_stream)

    # If no streams parsed, create a default entry
    if not formats:
        formats.append({
            "id": "yg_default",
            "label": title,
            "ext": "mp4",
            "size": "",
            "note": "you-get",
            "url": url,
        })

    return formats


def _parse_you_get_line(state, line):
    """Parse a single line from you-get output into the stream state dict."""
    match = _YOU_GET_STREAM_RE.search(line)
    if match:
        key = match.group(1).lower().strip()
        value = match.group(2).strip()
        state[key] = value

    # Extract size information
    size_match = re.search(r"size[\s:]+([\d.]+)\s*(MiB|GiB|KB|MB|GB)?", line, re.IGNORECASE)
    if size_match:
        size_val = float(size_match.group(1))
        unit = (size_match.group(2) or "MiB").upper()
        state["size_raw"] = (size_val, unit)


def _add_you_get_format(formats, title, stream):
    """Add a format entry from a parsed you-get stream."""
    fmt = stream.get("format") or stream.get("quality") or "default"
    ext = "mp4"
    if "container" in stream or "ext" in stream:
        ext = stream.get("container") or stream.get("ext") or "mp4"

    size_str = ""
    if "size_raw" in stream:
        val, unit = stream["size_raw"]
        size_str = f"{val:.1f} {unit}"

    formats.append({
        "id": f"yg_{fmt.lower().replace(' ', '_')}",
        "label": f"{title} [{fmt}]",
        "ext": ext,
        "size": size_str,
        "note": "you-get",
    })


def download_with_you_get(
    url,
    download_dir,
    cancel_event=None,
    progress_callback=None,
    format_id=None,
):
    """Download a URL using you-get.

    you-get supports many Asian media platforms better than yt-dlp.
    Best used as a fallback when yt-dlp fails for Bilibili, Douyin,
    Weibo, AcFun, Niconico, etc.

    Args:
        url: Video URL to download.
        download_dir: Directory to save the download.
        cancel_event: Threading.Event for cancellation.
        progress_callback: Callable for progress lines.
        format_id: Optional format ID to select (e.g., "dash-hd").

    Returns:
        Path to the downloaded file, or None on cancellation.

    Raises:
        HostError: If you-get is not installed or download fails.
    """
    cmd = resolve_you_get_command()
    if not cmd:
        raise HostError("you-get is not installed. Install with: pip install you-get")

    command = [
        *cmd,
        "--output-dir",
        str(download_dir),
    ]
    if format_id:
        command.extend(["--format", str(format_id)])
    command.append(str(url))

    cancel = cancel_event or Event()
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creation_flags(),
        )
    except OSError as exc:
        raise HostError(f"Could not start you-get: {exc}") from exc

    last_path = None
    assert process.stdout is not None
    for line in iter(process.stdout.readline, ""):
        if cancel.is_set():
            process.kill()
            process.wait()
            return None
        stripped = line.rstrip("\n\r")
        if progress_callback:
            progress_callback(stripped)
        # you-get prints "Downloading ..." or "Saving ..." with the file path
        if "saving" in stripped.lower() or "download" in stripped.lower():
            parts = stripped.split("'")
            if len(parts) >= 2:
                last_path = parts[1]

    exit_code = process.wait()
    if exit_code != 0:
        raise HostError(f"you-get exited with status {exit_code}.")

    if not last_path:
        last_path = _find_latest_file(download_dir)

    return last_path


# ---------------------------------------------------------------------------
# lux — Go-based video downloader with Asian platform support
# ---------------------------------------------------------------------------


def resolve_lux_command():
    """Locate the lux executable binary.

    lux is a Go-based video downloader that supports many Asian
    media platforms (Bilibili, Douyin/TikTok, etc.) as well as
    general video sites. It is installed as a single binary.

    Returns:
        List with the single command path, or None if not found.
    """
    executable = which("lux")
    if executable:
        return [executable]
    return None


def has_lux():
    """Check whether lux is available."""
    return resolve_lux_command() is not None


def list_formats_lux(url, timeout=30):
    """Query lux for downloadable formats.

    lux outputs stream information when given --info.
    We parse its output to produce a list of format-like dicts.

    Args:
        url: Video URL to query.
        timeout: Seconds to wait for lux to respond.

    Returns:
        List of dicts with id, label, ext, size, note keys,
        or None if lux is unavailable or doesn't support the URL.
    """
    cmd = resolve_lux_command()
    if not cmd:
        return None

    command = [
        *cmd,
        "--info",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creation_flags(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if completed.returncode != 0:
        return None

    output = (completed.stdout or "") + (completed.stderr or "")
    return _parse_lux_output(output, url)


def _parse_lux_output(output, url):
    """Parse lux --info output into a list of format entries."""
    formats = []
    lines = output.strip().splitlines()

    title = "Video"
    for line in lines:
        if line.startswith("Title:"):
            title = line.split(":", 1)[1].strip()
            break

    # Parse stream sections from lux output
    current_stream = {}
    for line in lines:
        line_stripped = line.strip()
        if line_stripped.startswith("-") or line_stripped.startswith("Stream"):
            if current_stream and current_stream.get("quality"):
                _add_lux_format(formats, title, current_stream)
            current_stream = {"raw": line_stripped}
            _parse_lux_line(current_stream, line_stripped)
        elif current_stream:
            _parse_lux_line(current_stream, line_stripped)

    if current_stream and current_stream.get("quality"):
        _add_lux_format(formats, title, current_stream)

    if not formats:
        formats.append({
            "id": "lx_default",
            "label": title,
            "ext": "mp4",
            "size": "",
            "note": "lux",
            "url": url,
        })

    return formats


_LUX_QUALITY_RE = re.compile(r"Quality[\s:]+(.+)", re.IGNORECASE)
_LUX_SIZE_RE = re.compile(r"Size[\s:]+([\d.]+)\s*(MiB|GiB|KB|MB|GB)?", re.IGNORECASE)
_LUX_TYPE_RE = re.compile(r"Type[\s:]+(.+)", re.IGNORECASE)


def _parse_lux_line(state, line):
    """Parse a single line from lux output into the stream state dict."""
    quality_match = _LUX_QUALITY_RE.search(line)
    if quality_match:
        state["quality"] = quality_match.group(1).strip()

    size_match = _LUX_SIZE_RE.search(line)
    if size_match:
        size_val = float(size_match.group(1))
        unit = (size_match.group(2) or "MiB").upper()
        state["size"] = f"{size_val:.1f} {unit}"

    type_match = _LUX_TYPE_RE.search(line)
    if type_match:
        state["type"] = type_match.group(1).strip()


def _add_lux_format(formats, title, stream):
    """Add a format entry from a parsed lux stream."""
    quality = stream.get("quality", "default")
    ext = "mp4"
    if "type" in stream:
        type_val = stream["type"].lower()
        if "flv" in type_val:
            ext = "flv"
        elif "webm" in type_val:
            ext = "webm"

    formats.append({
        "id": f"lx_{quality.lower().replace(' ', '_')}",
        "label": f"{title} [{quality}]",
        "ext": ext,
        "size": stream.get("size", ""),
        "note": "lux",
    })


def download_with_lux(
    url,
    download_dir,
    cancel_event=None,
    progress_callback=None,
    quality=None,
):
    """Download a URL using lux.

    lux is a Go-based video downloader that supports many Asian
    media platforms. Best used as a fallback when yt-dlp fails.

    Args:
        url: Video URL to download.
        download_dir: Directory to save the download.
        cancel_event: Threading.Event for cancellation.
        progress_callback: Callable for progress lines.
        quality: Optional quality/format to select (e.g., "1080p").

    Returns:
        Path to the downloaded file, or None on cancellation.

    Raises:
        HostError: If lux is not installed or download fails.
    """
    cmd = resolve_lux_command()
    if not cmd:
        raise HostError("lux is not installed.")

    command = [
        *cmd,
        "-o",
        str(download_dir),
    ]
    if quality:
        command.extend(["-f", str(quality)])
    command.append(str(url))

    cancel = cancel_event or Event()
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creation_flags(),
        )
    except OSError as exc:
        raise HostError(f"Could not start lux: {exc}") from exc

    last_path = None
    assert process.stdout is not None
    for line in iter(process.stdout.readline, ""):
        if cancel.is_set():
            process.kill()
            process.wait()
            return None
        stripped = line.rstrip("\n\r")
        if progress_callback:
            progress_callback(stripped)
        if "downloading" in stripped.lower() and download_dir in stripped:
            parts = stripped.split("'")
            if len(parts) >= 2:
                last_path = parts[1]

    exit_code = process.wait()
    if exit_code != 0:
        raise HostError(f"lux exited with status {exit_code}.")

    if not last_path:
        last_path = _find_latest_file(download_dir)

    return last_path


def is_direct_media_url(url):
    """Check whether a URL likely points directly at a media file."""
    path = str(url or "").split("?", 1)[0].split("#", 1)[0].lower()
    return any(
        path.endswith(ext)
        for ext in [
            ".mp4",
            ".webm",
            ".mkv",
            ".avi",
            ".mov",
            ".flv",
            ".wmv",
            ".mp3",
            ".m4a",
            ".aac",
            ".ogg",
            ".opus",
            ".flac",
            ".wav",
            ".m3u8",
            ".mpd",
        ]
    )


_SUPPORTED_DIRECT_EXTS = frozenset(
    {
        ".mp4",
        ".webm",
        ".mkv",
        ".avi",
        ".mov",
        ".flv",
        ".wmv",
        ".mp3",
        ".m4a",
        ".aac",
        ".ogg",
        ".opus",
        ".flac",
        ".wav",
    }
)


def download_direct(
    url,
    output_path,
    cancel_event=None,
    progress_callback=None,
    chunk_size=1048576,
):
    """Download a direct media URL to a local file using Python urllib.

    Supports pause/cancel via the cancel_event. Reports progress as
    bytes downloaded via progress_callback(bytes_downloaded, total_bytes).

    Returns the output_path on success. Raises HostError on failure.
    """
    from urllib.parse import urlparse

    parsed = urlparse(str(url))
    if parsed.scheme not in {"http", "https"}:
        raise HostError(f"Unsupported URL scheme for direct download: {parsed.scheme}")

    cancel = cancel_event or Event()
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    req = urllib.request.Request(
        str(url),
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0

            with open(str(output), "wb") as f:
                while True:
                    if cancel.is_set():
                        f.close()
                        if output.exists():
                            output.unlink()
                        return None

                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total)
    except urllib.error.HTTPError as exc:
        raise HostError(f"Direct download failed: HTTP {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise HostError(f"Direct download failed: {exc.reason}") from exc
    except OSError as exc:
        raise HostError(f"Direct download failed: {exc}") from exc

    return str(output)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _human_size(num_bytes):
    if not num_bytes:
        return ""
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return ""


def _find_latest_file(directory):
    """Find the most recently modified file in a directory tree."""
    directory = Path(directory)
    if not directory.is_dir():
        return None
    files = [f for f in directory.rglob("*") if f.is_file()]
    if not files:
        return None
    latest = max(files, key=lambda f: f.stat().st_mtime)
    return str(latest)
