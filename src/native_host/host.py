#!/usr/bin/env python3
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

import download_manager as _download_manager  # noqa: I001 - imports must follow the sys.path walk above
import download_task as _download_task
import format_list as _format_list
import media_resolver as _media_resolver
import process_control as _process_control
from artifacts import (
    delete_download_artifacts,
    open_download_path,
)
from folder_picker import (
    choose_download_folder,
)
from native_protocol import (
    HostError,
    configure_binary_stdio,
    error_response,
    folder_response,
    pong_response,
    read_native_message,
    request_id,
    request_type,
    send_native_message,
    unexpected_error_response,
)
from yt_dlp_dependencies import (
    has_aria2c,
    has_ffmpeg,
    has_n_m3u8dl_re,
    has_streamlink,
    has_yt_dlp,
    require_aria2c_location,
    resolve_ffmpeg_location,
    resolve_n_m3u8dl_re_location,
    resolve_streamlink_command,
    resolve_yt_dlp_command,
)

DownloadTask = _download_task.DownloadTask
creation_flags = _process_control.creation_flags
extract_media_candidates_from_text = _media_resolver.extract_media_candidates_from_text

HOST_VERSION = "1.0.0"


def control_download(message, action):
    return _download_manager.control_download(message, action, send=send_native_message)


def cancel_active_downloads():
    return _download_manager.cancel_active_downloads()


def run_download(message):
    return _download_manager.run_download(
        message,
        yt_dlp_command_resolver=resolve_yt_dlp_command,
        ffmpeg_location_resolver=resolve_ffmpeg_location,
        aria2c_location_resolver=require_aria2c_location,
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
    message_type = request_type(message)

    match message_type:
        case "ping":
            send_native_message(pong_response(message, HOST_VERSION, dependency_status()))
        case "download":
            run_download(message)
        case "pause" | "resume" | "cancel":
            control_download(message, message_type)
        case "openFile":
            open_download_path(message, reveal=False)
        case "showFile":
            open_download_path(message, reveal=True)
        case "deleteArtifacts":
            delete_download_artifacts(message)
        case "formats":
            run_format_list(message)
        case "enumeratePlaylist":
            run_playlist_enumeration(message)
        case "resolveMediaCandidates":
            run_resolve_media_candidates(message)
        case "chooseFolder":
            run_choose_folder(message)
        case _:
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

        request_id_value = request_id(message)

        try:
            handle_message(message)
        except HostError as exc:
            send_native_message(error_response(request_id_value, exc))
        except Exception as exc:
            print(f"Unhandled host error: {exc}", file=sys.stderr)
            send_native_message(unexpected_error_response(request_id_value, exc))


if __name__ == "__main__":
    raise SystemExit(main())
