#!/usr/bin/env python3
# Add all native_host subdirectories to sys.path so flat imports still work
# after the Phase 3 structural refactoring moved files into subdirectories.
import sys
from pathlib import Path
from urllib.request import urlopen

_host_dir = Path(__file__).resolve().parent
for _root, _dirs, _files in _host_dir.walk():
    if _root.name == "__pycache__" or _root.name.startswith("_"):
        continue
    _path = str(_root)
    if _path not in sys.path:
        sys.path.insert(0, _path)

import capture_manager as _capture_manager
import cdm_capture as _cdm_capture
import download_manager as _download_manager
import download_task as _download_task
import format_list as _format_list
import host_dispatch as _host_dispatch
import media_resolver as _media_resolver
import process_control as _process_control
import yt_dlp_adapter as _yt_dlp_adapter
from artifacts import (
    delete_download_artifacts,
    open_download_path,
)
from folder_picker import (
    choose_download_folder,
    choose_torrent_file,
)
from native_protocol import (
    HostError,
    configure_binary_stdio,
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
from yt_dlp_adapter import (
    has_yt_dlp,
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


def has_gopeed():
    return _yt_dlp_adapter.has_gopeed()


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
    """Assemble decrypted segments into a single output file.

    Passes initSegPaths from the message to enable fMP4 analysis
    (CMAF detection, track gap reporting).
    """
    import time as _t

    request_id = f"assemble_{int(_t.time() * 1000)}"
    try:
        result = _cdm_capture.assemble_segments(
            job_id=message.get("jobId", ""),
            file_paths=message.get("filePaths", []),
            output_path=message.get("outputPath", "output.mp4"),
            init_seg_paths=message.get("initSegPaths"),
        )
        response = {
            "type": "assembleResult",
            "id": request_id,
            "ok": result.get("ok", False),
            "jobId": result.get("jobId", ""),
            "filePath": result.get("filePath", ""),
            "error": result.get("error", ""),
        }
        fmp4_analysis = result.get("fmp4_analysis")
        if fmp4_analysis is not None:
            response["fmp4Analysis"] = fmp4_analysis
        return response
    except Exception as exc:
        return {
            "type": "assembleResult",
            "id": request_id,
            "ok": False,
            "error": str(exc),
        }


def run_analyze_segments(message):
    """Analyze fMP4 segments for CMAF detection and track gaps.

    Standalone analysis endpoint — reads init segment and media segment
    files from disk and returns CMAF/gap info without assembling.

    Message format:
        - initSegPaths: Optional list of init segment file paths.
        - mediaSegPaths: List of media segment file paths.

    Returns:
        analyzeResult message with fmp4Analysis dict.
    """
    import time as _t

    request_id = f"analyze_{int(_t.time() * 1000)}"
    try:
        analysis = _cdm_capture.analyze_segments_files(
            init_seg_paths=message.get("initSegPaths"),
            media_seg_paths=message.get("mediaSegPaths"),
        )
        return {
            "type": "analyzeResult",
            "id": request_id,
            "ok": True,
            "fmp4Analysis": analysis,
        }
    except Exception as exc:
        return {
            "type": "analyzeResult",
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


def run_playlist_enumeration(message):
    return _format_list.run_playlist_enumeration(
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


def run_write_data(message):
    """Write base64-encoded segment data to a file on disk.

    Receives a message with:
        - data: base64-encoded binary content
        - outputPath: absolute path to the output file

    Returns a response with success/failure status.
    """
    import base64 as _base64
    from pathlib import Path as _Path

    data_b64 = message.get("data", "")
    output_path = message.get("outputPath", "")
    request_id = message.get("id", "write_data")

    if not data_b64:
        return {
            "type": "writeDataResult",
            "id": request_id,
            "ok": False,
            "error": "No base64 data provided.",
        }

    if not output_path:
        return {
            "type": "writeDataResult",
            "id": request_id,
            "ok": False,
            "error": "No output path provided.",
        }

    try:
        decoded = _base64.b64decode(data_b64)
        output = _Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(decoded)
        return {
            "type": "writeDataResult",
            "id": request_id,
            "ok": True,
            "bytesWritten": len(decoded),
            "outputPath": str(output.resolve()),
        }
    except Exception as exc:
        return {
            "type": "writeDataResult",
            "id": request_id,
            "ok": False,
            "error": f"Failed to write data: {exc}",
        }


def run_debug_log(message):
    """Write debug log entries to a local file for troubleshooting.

    Receives a message with:
        - entries: list of {timestamp, level, message, details} objects

    Writes a formatted log to <project-root>/logs/debug.log.
    Creates the logs/ directory if it doesn't exist.
    """
    from pathlib import Path as _Path

    entries = message.get("entries", [])
    msg_id = message.get("id", "debug_log")

    if not entries:
        return {"type": "debugLogResult", "id": msg_id, "ok": True, "count": 0}

    # Resolve logs directory relative to this script's project root
    script_dir = _Path(__file__).resolve().parent  # src/native_host/
    log_dir = script_dir.parent / "logs"  # <project>/logs/
    log_dir.mkdir(parents=True, exist_ok=True)

    log_file = log_dir / "debug.log"
    lines = []
    for entry in entries:
        ts = entry.get("timestamp", 0)
        level = (entry.get("level", "info") or "info").upper()
        msg = entry.get("message", "")
        details = entry.get("details", "")
        line = f"[{ts}] [{level}] {msg}"
        if details:
            line += f"\n  -> {details[:2000]}"
        lines.append(line)

    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return {"type": "debugLogResult", "id": msg_id, "ok": True, "count": len(entries)}
    except Exception as exc:
        return {"type": "debugLogResult", "id": msg_id, "ok": False, "error": str(exc)}


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
        "has_gopeed": has_gopeed,
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
        "run_playlist_enumeration": run_playlist_enumeration,
        "run_magnet_download": run_magnet_download,
        "run_torrent_download": run_torrent_download,
        "run_gopeed_magnet_download": _download_manager.run_gopeed_magnet_download,
        "run_gopeed_torrent_download": _download_manager.run_gopeed_torrent_download,
        "run_resolve_media_candidates": run_resolve_media_candidates,
        "run_write_data": run_write_data,
        "run_cdm_init": run_cdm_init,
        "run_extract_keys": run_extract_keys,
        "run_decrypt_segments": run_decrypt_segments,
        "run_assemble_segments": run_assemble_segments,
        "run_analyze_segments": run_analyze_segments,
        "run_debug_log": run_debug_log,
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
