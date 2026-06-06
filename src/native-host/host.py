#!/usr/bin/env python3
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

import download_manager as _download_manager
import format_list as _format_list
import media_resolver as _media_resolver
import stream_backends as _stream_backends
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
from folder_picker import (
    choose_download_folder,
    choose_download_folder_with_powershell,
    choose_download_folder_with_tk,
    initial_folder_for_picker,
)
from native_paths import default_download_dir, resolve_download_dir, sanitize_filename, validate_download_url
from native_protocol import (
    HostError,
    configure_binary_stdio,
    encode_native_message,
    read_native_message,
    send_native_message,
)
from media_resolver import extract_media_candidates_from_text, resolve_media_candidates
from stream_backends import (
    build_n_m3u8dl_re_command,
    build_streamlink_command,
    is_retryable_backend_error,
    is_stream_manifest_url,
    stream_output_path,
)
from yt_dlp_adapter import (
    DEFAULT_ARIA2_CONNECTIONS,
    DEFAULT_CONCURRENT_FRAGMENTS,
    DEFAULT_FORMAT_SELECTOR,
    FILEPATH_MARKER,
    MAX_ARIA2_CONNECTIONS,
    MAX_FAST_CONNECTIONS,
    append_youtube_ejs_options,
    bounded_int,
    build_formats_command,
    build_yt_dlp_command,
    compact_progress_value,
    creation_flags,
    format_label,
    format_selector_for_choice,
    format_sort_key,
    has_n_m3u8dl_re,
    has_streamlink,
    has_yt_dlp,
    human_size,
    is_aria2_access_refusal,
    is_segmented_stream_format,
    is_youtube_url,
    iter_process_output_lines,
    latest_output_line,
    parse_aria2_progress_details,
    parse_yt_dlp_line,
    parse_yt_dlp_progress_details,
    require_executable,
    resolve_n_m3u8dl_re_location,
    resolve_streamlink_command,
    summarize_formats,
    terminate_process_tree,
)


HOST_VERSION = "1.0.0"
ACTIVE_DOWNLOADS = _download_manager.ACTIVE_DOWNLOADS
ACTIVE_DOWNLOADS_LOCK = _download_manager.ACTIVE_DOWNLOADS_LOCK
LOCAL_ARIA2C = _yt_dlp_adapter.LOCAL_ARIA2C
LOCAL_N_M3U8DL_RE = _yt_dlp_adapter.LOCAL_N_M3U8DL_RE


def get_imageio_ffmpeg_exe():
    return _yt_dlp_adapter.get_imageio_ffmpeg_exe()


def resolve_yt_dlp_command():
    return _yt_dlp_adapter.resolve_yt_dlp_command()


def resolve_ffmpeg_location():
    return _yt_dlp_adapter.resolve_ffmpeg_location(imageio_resolver=get_imageio_ffmpeg_exe)


def resolve_aria2c_location():
    return _yt_dlp_adapter.resolve_aria2c_location(local_aria2c=LOCAL_ARIA2C)


def resolve_n_m3u8dl_re_location():
    return _yt_dlp_adapter.resolve_n_m3u8dl_re_location(local_n_m3u8dl_re=LOCAL_N_M3U8DL_RE)


def resolve_streamlink_command():
    return _yt_dlp_adapter.resolve_streamlink_command()


def has_ffmpeg():
    return _yt_dlp_adapter.has_ffmpeg(imageio_resolver=get_imageio_ffmpeg_exe)


def has_aria2c():
    return bool(resolve_aria2c_location())


def has_n_m3u8dl_re():
    return bool(resolve_n_m3u8dl_re_location())


def has_streamlink():
    return bool(resolve_streamlink_command())


def _active_downloads_lock():
    return _download_manager._active_downloads_lock()


def control_download(message, action):
    return _download_manager.control_download(message, action, send=send_native_message)


def cancel_active_downloads():
    return _download_manager.cancel_active_downloads()


def run_download(message):
    return _download_manager.run_download(
        message,
        yt_dlp_command_resolver=resolve_yt_dlp_command,
        ffmpeg_location_resolver=resolve_ffmpeg_location,
        aria2c_location_resolver=resolve_aria2c_location,
        n_m3u8dl_re_location_resolver=resolve_n_m3u8dl_re_location,
        streamlink_command_resolver=resolve_streamlink_command,
    )


def run_format_list(message):
    return _format_list.run_format_list(
        message,
        send=send_native_message,
        yt_dlp_command_resolver=resolve_yt_dlp_command,
        ffmpeg_location_resolver=resolve_ffmpeg_location,
    )


def run_choose_folder(message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    selected = choose_download_folder(message.get("initialFolder"))
    if selected:
        send_native_message({"type": "folder", "id": request_id, "path": str(selected)})
    else:
        send_native_message({"type": "folder", "id": request_id, "canceled": True})


def run_resolve_media_candidates(message):
    return _media_resolver.resolve_media_candidates(message, send=send_native_message, urlopen_fn=urlopen)


def dependency_status():
    return {
        "ytDlp": has_yt_dlp(),
        "ffmpeg": has_ffmpeg(),
        "aria2c": has_aria2c(),
        "nM3u8DlRe": has_n_m3u8dl_re(),
        "streamlink": has_streamlink(),
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

    if message_type == "resolveMediaCandidates":
        run_resolve_media_candidates(message)
        return

    if message_type == "chooseFolder":
        run_choose_folder(message)
        return

    raise HostError(f"Unknown native host request type: {message_type}")


def main():
    configure_binary_stdio()
    while True:
        try:
            message = read_native_message()
        except EOFError:
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
