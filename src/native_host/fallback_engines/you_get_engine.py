"""you-get fallback download engine for Asian media platforms.

Provides you-get integration for sites such as Bilibili, Douyin/TikTok,
Weibo, AcFun, Niconico, etc. where yt-dlp has limited support.
"""

import importlib.util
import re
import subprocess
import sys
from shutil import which
from threading import Event

from fallback_engines.helpers import _find_latest_file
from native_protocol import HostError
from process_control import creation_flags

_YOU_GET_STREAM_RE = re.compile(
    r"-\s*(format|quality|stream)[:\s]+(.+)", re.IGNORECASE
)


def resolve_you_get_command():
    """Locate the you-get executable (binary or python -m module)."""
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

    Returns a list of format-like dicts compatible with the Qwin format picker,
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

    current_stream = {}
    for line in lines:
        line_stripped = line.strip()
        if line_stripped.startswith("-"):
            if current_stream and current_stream.get("format"):
                _add_you_get_format(formats, title, current_stream)
            current_stream = {"lines": [line_stripped]}
            _parse_you_get_line(current_stream, line_stripped)
        elif current_stream:
            current_stream.setdefault("lines", []).append(line_stripped)
            _parse_you_get_line(current_stream, line_stripped)

    if current_stream and current_stream.get("format"):
        _add_you_get_format(formats, title, current_stream)

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

    Returns path to the downloaded file, or None on cancellation.
    Raises HostError if you-get is not installed or download fails.
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
