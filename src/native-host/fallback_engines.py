"""Fallback download engines for sites yt-dlp cannot handle.

Provides gallery-dl support for image/gallery sites and a direct HTTP
downloader for explicit media URLs (direct .mp4 / .webm / .mp3 links).
"""

import importlib.util
import json
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
