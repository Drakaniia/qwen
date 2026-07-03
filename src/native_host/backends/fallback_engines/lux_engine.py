"""lux fallback download engine for Asian media platforms.

Provides lux (Go-based) integration for sites such as Bilibili,
Douyin/TikTok, etc. where yt-dlp has limited support.
"""

import re
import subprocess
from shutil import which
from threading import Event

from fallback_engines.helpers import _find_latest_file
from native_protocol import HostError
from process_control import creation_flags

_LUX_QUALITY_RE = re.compile(r"Quality[\s:]+(.+)", re.IGNORECASE)
_LUX_SIZE_RE = re.compile(r"Size[\s:]+([\d.]+)\s*(MiB|GiB|KB|MB|GB)?", re.IGNORECASE)
_LUX_TYPE_RE = re.compile(r"Type[\s:]+(.+)", re.IGNORECASE)


def resolve_lux_command():
    """Locate the lux executable binary."""
    executable = which("lux")
    if executable:
        return [executable]
    return None


def has_lux():
    """Check whether lux is available."""
    return resolve_lux_command() is not None


def list_formats_lux(url, timeout=30):
    """Query lux for downloadable formats.

    Returns a list of format-like dicts compatible with the Qwin format picker,
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
        formats.append(
            {
                "id": "lx_default",
                "label": title,
                "ext": "mp4",
                "size": "",
                "note": "lux",
                "url": url,
            }
        )

    return formats


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

    formats.append(
        {
            "id": f"lx_{quality.lower().replace(' ', '_')}",
            "label": f"{title} [{quality}]",
            "ext": ext,
            "size": stream.get("size", ""),
            "note": "lux",
        }
    )


def download_with_lux(
    url,
    download_dir,
    cancel_event=None,
    progress_callback=None,
    quality=None,
):
    """Download a URL using lux.

    Returns path to the downloaded file, or None on cancellation.
    Raises HostError if lux is not installed or download fails.
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
        if "downloading" in stripped.lower() and str(download_dir) in stripped:
            parts = stripped.split("'")
            if len(parts) >= 2:
                last_path = parts[1]

    exit_code = process.wait()
    if exit_code != 0:
        raise HostError(f"lux exited with status {exit_code}.")

    if not last_path:
        last_path = _find_latest_file(download_dir)

    return last_path
