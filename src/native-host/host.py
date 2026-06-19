#!/usr/bin/env python3
from urllib.request import urlopen

import capture_manager as _capture_manager

import download_manager as _download_manager
import format_list as _format_list
import host_dispatch as _host_dispatch
import media_resolver as _media_resolver
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
        "send_native_message": send_native_message,
        "unexpected_error_response": unexpected_error_response,
    }
    if include_dispatch:
        values["handle_message"] = handle_message
    return _host_dispatch.namespace(**values)


if __name__ == "__main__":
    raise SystemExit(main())
