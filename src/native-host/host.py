#!/usr/bin/env python3
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yt_dlp_adapter as _yt_dlp_adapter
from artifacts import (
    build_open_path_command,
    delete_download_artifacts,
    is_dangerous_delete_target,
    open_download_path,
    path_is_relative_to,
    resolve_artifact_path,
    should_delete_parent_folder_for_file,
    unique_delete_targets,
    validate_delete_target,
)
from browser_context import (
    append_browser_context_options,
    canonical_header_name,
    clean_header_value,
    clean_request_headers,
    cookie_header_from_request_headers,
    parse_cookie_header,
    remove_temp_files,
    write_cookie_file_from_headers,
)
from download_task import DownloadTask
from native_paths import default_download_dir, resolve_download_dir, sanitize_filename, validate_download_url
from native_protocol import (
    HostError,
    configure_binary_stdio,
    encode_native_message,
    read_native_message,
    send_native_message,
)
from yt_dlp_adapter import (
    DEFAULT_ARIA2_CONNECTIONS,
    DEFAULT_CONCURRENT_FRAGMENTS,
    DEFAULT_FORMAT_SELECTOR,
    FILEPATH_MARKER,
    MAX_FAST_CONNECTIONS,
    bounded_int,
    build_formats_command,
    build_yt_dlp_command,
    compact_progress_value,
    creation_flags,
    format_label,
    format_selector_for_choice,
    format_sort_key,
    has_yt_dlp,
    human_size,
    is_aria2_access_refusal,
    is_segmented_stream_format,
    iter_process_output_lines,
    latest_output_line,
    parse_aria2_progress_details,
    parse_yt_dlp_line,
    parse_yt_dlp_progress_details,
    require_executable,
    summarize_formats,
    terminate_process_tree,
)


HOST_VERSION = "1.0.0"
ACTIVE_DOWNLOADS = {}
ACTIVE_DOWNLOADS_LOCK = None
LOCAL_ARIA2C = _yt_dlp_adapter.LOCAL_ARIA2C


def get_imageio_ffmpeg_exe():
    return _yt_dlp_adapter.get_imageio_ffmpeg_exe()


def resolve_yt_dlp_command():
    return _yt_dlp_adapter.resolve_yt_dlp_command()


def resolve_ffmpeg_location():
    executable = shutil.which("ffmpeg")
    if executable:
        return executable

    imageio_ffmpeg = get_imageio_ffmpeg_exe()
    if imageio_ffmpeg and Path(imageio_ffmpeg).exists():
        return imageio_ffmpeg

    raise HostError("ffmpeg is not installed. Run scripts\\install.bat, then restart your browser.")


def resolve_aria2c_location():
    original = _yt_dlp_adapter.LOCAL_ARIA2C
    _yt_dlp_adapter.LOCAL_ARIA2C = LOCAL_ARIA2C
    try:
        return _yt_dlp_adapter.resolve_aria2c_location()
    finally:
        _yt_dlp_adapter.LOCAL_ARIA2C = original


def has_ffmpeg():
    imageio_ffmpeg = get_imageio_ffmpeg_exe()
    return bool(shutil.which("ffmpeg") or (imageio_ffmpeg and Path(imageio_ffmpeg).exists()))


def has_aria2c():
    return bool(resolve_aria2c_location())


def _active_downloads_lock():
    global ACTIVE_DOWNLOADS_LOCK
    if ACTIVE_DOWNLOADS_LOCK is None:
        import threading

        ACTIVE_DOWNLOADS_LOCK = threading.Lock()
    return ACTIVE_DOWNLOADS_LOCK


def control_download(message, action):
    request_id = str(message.get("id") or message.get("requestId") or "")
    with _active_downloads_lock():
        task = ACTIVE_DOWNLOADS.get(request_id)

    if not task:
        raise HostError("That download is no longer active. Use Retry to start it again.")

    response = getattr(task, action)()
    send_native_message(response)


def cancel_active_downloads():
    with _active_downloads_lock():
        tasks = list(ACTIVE_DOWNLOADS.values())
    for task in tasks:
        task.cancel()


def run_download(message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    yt_dlp_command = resolve_yt_dlp_command()
    ffmpeg_location = resolve_ffmpeg_location()
    aria2c_location = resolve_aria2c_location()

    download_dir = resolve_download_dir(message.get("downloadFolder"))
    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []
    command = build_yt_dlp_command(
        url=url,
        download_dir=download_dir,
        referer=message.get("pageUrl"),
        user_agent=message.get("userAgent"),
        request_headers=request_headers,
        cookies_file=cookies_file,
        yt_dlp_command=yt_dlp_command,
        ffmpeg_location=ffmpeg_location,
        aria2c_location=aria2c_location,
        selected_format=message.get("formatId"),
    )
    fallback_command = None
    if aria2c_location:
        fallback_command = build_yt_dlp_command(
            url=url,
            download_dir=download_dir,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            aria2c_location=None,
            selected_format=message.get("formatId"),
        )

    task = DownloadTask(
        message=message,
        command=command,
        fallback_command=fallback_command,
        download_dir=download_dir,
        temp_files=temp_files,
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


def run_format_list(message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        command = build_formats_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=resolve_yt_dlp_command(),
            ffmpeg_location=resolve_ffmpeg_location(),
        )
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while asking yt-dlp for available qualities.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc
    finally:
        remove_temp_files(temp_files)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    try:
        info = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HostError("yt-dlp returned invalid format metadata.") from exc

    send_native_message({"type": "formats", "id": request_id, **summarize_formats(info)})


def dependency_status():
    return {
        "ytDlp": has_yt_dlp(),
        "ffmpeg": has_ffmpeg(),
        "aria2c": has_aria2c(),
    }


def handle_message(message):
    message_type = message.get("type")
    request_id = str(message.get("id") or message.get("requestId") or "")

    if message_type == "ping":
        send_native_message(
            {
                "type": "pong",
                "id": request_id,
                "version": HOST_VERSION,
                "dependencies": dependency_status(),
            }
        )
        return

    if message_type == "download":
        run_download(message)
        return

    if message_type in {"pause", "resume", "cancel"}:
        control_download(message, message_type)
        return

    if message_type == "openFile":
        open_download_path(message, reveal=False)
        return

    if message_type == "showFile":
        open_download_path(message, reveal=True)
        return

    if message_type == "deleteArtifacts":
        delete_download_artifacts(message)
        return

    if message_type == "formats":
        run_format_list(message)
        return

    raise HostError(f"Unknown native host request type: {message_type}")


def main():
    configure_binary_stdio()
    while True:
        try:
            message = read_native_message()
        except EOFError:
            cancel_active_downloads()
            return 0
        except Exception as exc:
            print(f"Native messaging protocol error: {exc}", file=sys.stderr)
            return 1

        request_id = ""
        if isinstance(message, dict):
            request_id = str(message.get("id") or message.get("requestId") or "")

        try:
            handle_message(message)
        except HostError as exc:
            send_native_message({"type": "error", "id": request_id, "error": str(exc)})
        except Exception as exc:
            print(f"Unhandled host error: {exc}", file=sys.stderr)
            send_native_message(
                {
                    "type": "error",
                    "id": request_id,
                    "error": f"Unexpected helper error: {exc}",
                }
            )


if __name__ == "__main__":
    raise SystemExit(main())
