"""gallery-dl fallback download engine for image/gallery sites.

Provides gallery-dl support for sites that yt-dlp cannot handle,
such as Pixiv, DeviantArt, Danbooru, and other image/gallery platforms.
"""

import importlib.util
import json
import subprocess
import sys
from shutil import which
from threading import Event

from fallback_engines.helpers import _find_latest_file, _human_size
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
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if completed.returncode != 0:
        return None  # gallery-dl doesn't support this URL

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
        if "saved" in stripped.lower() and str(download_dir) in stripped:
            parts = stripped.split("'")
            if len(parts) >= 2:
                last_path = parts[1]

    exit_code = process.wait()
    if exit_code != 0:
        raise HostError(f"gallery-dl exited with status {exit_code}.")

    if not last_path:
        last_path = _find_latest_file(download_dir)

    return last_path
