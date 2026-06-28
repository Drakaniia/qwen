"""BitTorrent download functions for magnet links and .torrent files.

This module owns the shared ACTIVE_DOWNLOADS state dict and provides
the download lifecycle functions for magnet and .torrent downloads
via aria2c and Gopeed backends.
"""

import threading

from aria2c_commands import build_aria2c_magnet_command, build_aria2c_torrent_command
from gopeed_adapter import build_gopeed_magnet_command, build_gopeed_torrent_command

from download_task import DownloadTask
from native_paths import resolve_download_dir, validate_magnet_url, validate_torrent_file
from native_protocol import HostError, send_native_message
from yt_dlp_dependencies import require_aria2c_location, require_gopeed_location

# ── Shared mutable state ────────────────────────────────────────────

ACTIVE_DOWNLOADS = {}
ACTIVE_DOWNLOADS_LOCK = None


def _active_downloads_lock():
    """Return (creating on first call) the threading lock for ACTIVE_DOWNLOADS."""
    global ACTIVE_DOWNLOADS_LOCK
    if ACTIVE_DOWNLOADS_LOCK is None:
        ACTIVE_DOWNLOADS_LOCK = threading.Lock()
    return ACTIVE_DOWNLOADS_LOCK


# ── Download control ────────────────────────────────────────────────


def control_download(message, action, send=send_native_message):
    """Look up an active download by request ID and invoke the given action on it."""
    request_id = str(message.get("id") or message.get("requestId") or "")
    with _active_downloads_lock():
        task = ACTIVE_DOWNLOADS.get(request_id)

    if not task:
        raise HostError("That download is no longer active. Use Retry to start it again.")

    response = getattr(task, action)()
    send(response)


def cancel_active_downloads():
    """Cancel all currently active downloads."""
    with _active_downloads_lock():
        tasks = list(ACTIVE_DOWNLOADS.values())
    for task in tasks:
        task.cancel()


# ── Magnet link download via aria2c ─────────────────────────────────


def run_magnet_download(
    message,
    task_class=DownloadTask,
    aria2c_location_resolver=require_aria2c_location,
):
    """Run a magnet link download directly through aria2c."""
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_magnet_url(url)

    aria2c_location = aria2c_location_resolver()
    if not aria2c_location:
        raise HostError(
            "aria2c is not installed. It is required for magnet link downloads. "
            "Run scripts\\install.bat, then restart your browser."
        )

    download_dir = resolve_download_dir(message.get("downloadFolder"))

    command = build_aria2c_magnet_command(
        url=url,
        download_dir=download_dir,
        aria2c_location=aria2c_location,
    )

    task = task_class(
        message=message,
        command=command,
        fallback_command=None,
        fallback_commands=[],
        download_dir=download_dir,
        temp_files=[],
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


# ── Torrent file download via aria2c ────────────────────────────────


def run_torrent_download(
    message,
    task_class=DownloadTask,
    aria2c_location_resolver=require_aria2c_location,
):
    """Run a download from a local .torrent file directly through aria2c."""
    request_id = str(message.get("id") or message.get("requestId") or "")
    torrent_path = validate_torrent_file(message.get("path"))

    aria2c_location = aria2c_location_resolver()
    if not aria2c_location:
        raise HostError(
            "aria2c is not installed. It is required for .torrent file downloads. "
            "Run scripts\\install.bat, then restart your browser."
        )

    download_dir = resolve_download_dir(message.get("downloadFolder"))

    command = build_aria2c_torrent_command(
        torrent_path=torrent_path,
        download_dir=download_dir,
        aria2c_location=aria2c_location,
    )

    task = task_class(
        message=message,
        command=command,
        fallback_command=None,
        fallback_commands=[],
        download_dir=download_dir,
        temp_files=[],
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


# ── Magnet link download via Gopeed ─────────────────────────────────


def run_gopeed_magnet_download(
    message,
    task_class=DownloadTask,
    gopeed_location_resolver=require_gopeed_location,
):
    """Run a magnet link download through Gopeed."""
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_magnet_url(url)

    gopeed_location = gopeed_location_resolver()
    if not gopeed_location:
        raise HostError(
            "gopeed is not installed. It is required for magnet link downloads. "
            "Run scripts\\install.bat, then restart your browser."
        )

    download_dir = resolve_download_dir(message.get("downloadFolder"))

    command = build_gopeed_magnet_command(
        url=url,
        download_dir=download_dir,
        gopeed_location=gopeed_location,
    )

    task = task_class(
        message=message,
        command=command,
        fallback_command=None,
        fallback_commands=[],
        download_dir=download_dir,
        temp_files=[],
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


# ── Torrent file download via Gopeed ────────────────────────────────


def run_gopeed_torrent_download(
    message,
    task_class=DownloadTask,
    gopeed_location_resolver=require_gopeed_location,
):
    """Run a download from a local .torrent file through Gopeed."""
    request_id = str(message.get("id") or message.get("requestId") or "")
    torrent_path = validate_torrent_file(message.get("path"))

    gopeed_location = gopeed_location_resolver()
    if not gopeed_location:
        raise HostError(
            "gopeed is not installed. It is required for .torrent file downloads. "
            "Run scripts\\install.bat, then restart your browser."
        )

    download_dir = resolve_download_dir(message.get("downloadFolder"))

    command = build_gopeed_torrent_command(
        torrent_path=torrent_path,
        download_dir=download_dir,
        gopeed_location=gopeed_location,
    )

    task = task_class(
        message=message,
        command=command,
        fallback_command=None,
        fallback_commands=[],
        download_dir=download_dir,
        temp_files=[],
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()
