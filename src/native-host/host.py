#!/usr/bin/env python3
import importlib
import os
import shutil
import sys
from urllib.request import urlopen

import capture_manager as _capture_manager
import download_manager as _download_manager
import format_list as _format_list
import host_dispatch as _host_dispatch
import media_resolver as _media_resolver
import process_control as _process_control
import yt_dlp_adapter as _yt_dlp_adapter
import download_task as _download_task

from artifacts import (
    build_open_path_command,
    delete_download_artifacts,
    open_download_path,
)
from browser_context import (
    clean_request_headers,
    write_cookie_file_from_headers,
)
from folder_picker import (
    choose_download_folder,
    choose_torrent_file,
)
from native_paths import (
    default_download_dir,
    sanitize_filename,
    validate_download_url,
)
from native_protocol import (
    HostError,
    configure_binary_stdio,
    encode_native_message,
    error_response,
    file_response,
    folder_response,
    pong_response,
    read_native_message,
    request_id,
    request_type,
    send_native_message,
    unexpected_error_response,
)
from progress_parser import (
    iter_process_output_lines,
    parse_yt_dlp_line,
)
from stream_backends import (
    build_n_m3u8dl_re_command,
    build_streamlink_command,
)
from yt_dlp_adapter import (
    has_yt_dlp,
)
from yt_dlp_command import (
    MAX_FAST_CONNECTIONS,
    MAX_ARIA2_CONNECTIONS,
    build_formats_command,
    build_yt_dlp_command,
    summarize_formats,
)

DownloadTask = _download_task.DownloadTask
creation_flags = _process_control.creation_flags
extract_media_candidates_from_text = _media_resolver.extract_media_candidates_from_text

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


def has_capture_binary():
    return _capture_manager.capture_available()


def capture_status():
    return _capture_manager.capture_status()


def get_pending_cdp_forward(block=False, timeout=1.0):
    return _capture_manager.get_pending_cdp_forward(block=block, timeout=timeout)


def send_cdp_relay_result(forward_id, result=None, error=""):
    return _capture_manager.send_cdp_relay_result(forward_id, result=result, error=error)


def run_cdm_init(message):
    """Initialize the Widevine CDM with the path from the message."""
    cdm_path = message.get("cdmPath", "")
    import time as _t
    request_id = f"cdm_init_{int(_t.time() * 1000)}"
    try:
        result = _capture_manager.cdm_init(cdm_path)
        return {
            "type": "cdmInitResult",
            "id": request_id,
            "ok": result.get("ok", False),
            "cdmVersion": result.get("cdmVersion", ""),
            "l1Only": result.get("l1Only", False),
            "cdmPath": result.get("cdmPath", ""),
            "error": result.get("error", ""),
        }
    except Exception as exc:
        return {
            "type": "cdmInitResult",
            "id": request_id,
            "ok": False,
            "error": str(exc),
        }


def run_extract_keys(message):
    """Extract decryption keys from a captured Widevine license response."""
    import time as _t
    request_id = f"extract_keys_{int(_t.time() * 1000)}"
    try:
        result = _capture_manager.extract_keys(
            session_id=message.get("sessionId", ""),
            response_b64=message.get("responseB64", ""),
            challenge_b64=message.get("challengeB64", ""),
            init_data_b64=message.get("initDataB64", ""),
        )
        return {
            "type": "keysExtracted",
            "id": request_id,
            "ok": result.get("ok", False),
            "sessionId": result.get("sessionId", ""),
            "keys": result.get("keys", []),
            "l1Only": result.get("l1Only", False),
            "error": result.get("error", ""),
        }
    except Exception as exc:
        return {
            "type": "keysExtracted",
            "id": request_id,
            "ok": False,
            "error": str(exc),
        }


def run_decrypt_segments(message):
    """Decrypt encrypted media segments with the provided keys."""
    import time as _t
    request_id = f"decrypt_seg_{int(_t.time() * 1000)}"
    try:
        result = _capture_manager.decrypt_segments(
            job_id=message.get("jobId", ""),
            segments=message.get("segments", []),
            keys=message.get("keys", []),
            output_dir=message.get("outputDir", ""),
        )
        return {
            "type": "decryptResult",
            "id": request_id,
            "ok": result.get("ok", False),
            "jobId": result.get("jobId", ""),
            "decrypted": result.get("decrypted", 0),
            "segmentPaths": result.get("segmentPaths", []),
            "error": result.get("error", ""),
        }
    except Exception as exc:
        return {
            "type": "decryptResult",
            "id": request_id,
            "ok": False,
            "error": str(exc),
        }


def run_assemble_segments(message):
    """Assemble decrypted segments into a single output file."""
    import time as _t
    request_id = f"assemble_{int(_t.time() * 1000)}"
    try:
        result = _capture_manager.assemble_segments(
            job_id=message.get("jobId", ""),
            file_paths=message.get("filePaths", []),
            output_path=message.get("outputPath", "output.mp4"),
        )
        return {
            "type": "assembleResult",
            "id": request_id,
            "ok": result.get("ok", False),
            "jobId": result.get("jobId", ""),
            "filePath": result.get("filePath", ""),
            "error": result.get("error", ""),
        }
    except Exception as exc:
        return {
            "type": "assembleResult",
            "id": request_id,
            "ok": False,
            "error": str(exc),
        }


def _active_downloads_lock():
    return _download_manager._active_downloads_lock()


def control_download(message, action):
    return _download_manager.control_download(message, action, send=send_native_message)


def cancel_active_downloads():
    return _download_manager.cancel_active_downloads()


def run_magnet_download(message):
    return _download_manager.run_magnet_download(
        message,
        aria2c_location_resolver=_yt_dlp_adapter.require_aria2c_location,
    )


def run_torrent_download(message):
    return _download_manager.run_torrent_download(
        message,
        aria2c_location_resolver=_yt_dlp_adapter.require_aria2c_location,
    )


def run_download(message):
    return _download_manager.run_download(
        message,
        yt_dlp_command_resolver=resolve_yt_dlp_command,
        ffmpeg_location_resolver=resolve_ffmpeg_location,
        aria2c_location_resolver=_yt_dlp_adapter.require_aria2c_location,
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
    selected = choose_download_folder(message.get("initialFolder"))
    send_native_message(folder_response(message, selected))


def run_choose_torrent_file(message):
    selected = choose_torrent_file(message.get("initialFolder"))
    send_native_message(file_response(message, selected))


def run_resolve_media_candidates(message):
    return _media_resolver.resolve_media_candidates(message, send=send_native_message, urlopen_fn=urlopen)


def dependency_status():
    return _host_dispatch.dependency_status(_dispatch_deps(include_dispatch=False))


def handle_message(message):
    return _host_dispatch.handle_message(message, _dispatch_deps())


def main():
    return _host_dispatch.main(_dispatch_deps())


def _dispatch_deps(include_dispatch=True):
    values = {
        "HostError": HostError,
        "configure_binary_stdio": configure_binary_stdio,
        "control_download": control_download,
        "capture_status": capture_status,
        "delete_download_artifacts": delete_download_artifacts,
        "dependency_status": dependency_status,
        "error_response": error_response,
        "has_aria2c": has_aria2c,
        "has_capture_binary": has_capture_binary,
        "has_ffmpeg": has_ffmpeg,
        "has_n_m3u8dl_re": has_n_m3u8dl_re,
        "has_streamlink": has_streamlink,
        "has_yt_dlp": has_yt_dlp,
        "host_version": HOST_VERSION,
        "open_download_path": open_download_path,
        "pong_response": pong_response,
        "read_native_message": read_native_message,
        "request_id": request_id,
        "request_type": request_type,
        "run_choose_folder": run_choose_folder,
        "run_choose_torrent_file": run_choose_torrent_file,
        "run_download": run_download,
        "run_format_list": run_format_list,
        "run_magnet_download": run_magnet_download,
        "run_torrent_download": run_torrent_download,
        "run_resolve_media_candidates": run_resolve_media_candidates,
        "run_cdm_init": run_cdm_init,
        "run_extract_keys": run_extract_keys,
        "run_decrypt_segments": run_decrypt_segments,
        "run_assemble_segments": run_assemble_segments,
        "send_native_message": send_native_message,
        "send_cdp_relay_result": send_cdp_relay_result,
        "get_pending_cdp_forward": get_pending_cdp_forward,
        "unexpected_error_response": unexpected_error_response,
    }
    if include_dispatch:
        values["handle_message"] = handle_message
    return _host_dispatch.namespace(**values)


if __name__ == "__main__":
    raise SystemExit(main())
