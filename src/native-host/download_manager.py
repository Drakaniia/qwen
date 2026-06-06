import threading

from browser_context import write_cookie_file_from_headers
from download_task import DownloadTask
from native_paths import resolve_download_dir, validate_download_url
from native_protocol import HostError, send_native_message
from stream_backends import (
    build_n_m3u8dl_re_command,
    build_streamlink_command,
    is_stream_manifest_url,
    stream_output_path,
)
from yt_dlp_command import build_yt_dlp_command
from yt_dlp_dependencies import (
    resolve_aria2c_location,
    resolve_ffmpeg_location,
    resolve_n_m3u8dl_re_location,
    resolve_streamlink_command,
    resolve_yt_dlp_command,
)


ACTIVE_DOWNLOADS = {}
ACTIVE_DOWNLOADS_LOCK = None


def _active_downloads_lock():
    global ACTIVE_DOWNLOADS_LOCK
    if ACTIVE_DOWNLOADS_LOCK is None:
        ACTIVE_DOWNLOADS_LOCK = threading.Lock()
    return ACTIVE_DOWNLOADS_LOCK


def control_download(message, action, send=send_native_message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    with _active_downloads_lock():
        task = ACTIVE_DOWNLOADS.get(request_id)

    if not task:
        raise HostError("That download is no longer active. Use Retry to start it again.")

    response = getattr(task, action)()
    send(response)


def cancel_active_downloads():
    with _active_downloads_lock():
        tasks = list(ACTIVE_DOWNLOADS.values())
    for task in tasks:
        task.cancel()


def run_download(
    message,
    task_class=DownloadTask,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
    aria2c_location_resolver=resolve_aria2c_location,
    n_m3u8dl_re_location_resolver=resolve_n_m3u8dl_re_location,
    streamlink_command_resolver=resolve_streamlink_command,
):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    yt_dlp_command = yt_dlp_command_resolver()
    ffmpeg_location = ffmpeg_location_resolver()
    aria2c_location = aria2c_location_resolver()
    n_m3u8dl_re_location = n_m3u8dl_re_location_resolver()
    streamlink_command = streamlink_command_resolver()

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

    fallback_commands = []
    # Add an SSL fallback that disables certificate verification if the primary attempts fail.
    fallback_commands.append(
        {
            "command": build_yt_dlp_command(
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
                nocheckcertificate=True,
            ),
            "label": "yt-dlp (no SSL check)",
        }
    )

    requested_backend = str(message.get("backend") or "auto").lower()
    if requested_backend in {"auto", "n_m3u8dl-re", "n_m3u8dl_re", "n-m3u8dl-re"} and n_m3u8dl_re_location and is_stream_manifest_url(url, message.get("format")):
        final_path = stream_output_path(download_dir, message.get("title") or "Video")
        fallback_commands.append(
            {
                "command": build_n_m3u8dl_re_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                    ffmpeg_location=ffmpeg_location,
                ),
                "label": "N_m3u8DL-RE",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    if requested_backend in {"auto", "streamlink"} and streamlink_command and is_stream_manifest_url(url, message.get("format")):
        final_path = stream_output_path(download_dir, message.get("title") or "Video")
        fallback_commands.append(
            {
                "command": build_streamlink_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                    streamlink_command=streamlink_command,
                    ffmpeg_location=ffmpeg_location,
                ),
                "label": "Streamlink",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    task = task_class(
        message=message,
        command=command,
        fallback_command=fallback_command,
        fallback_commands=fallback_commands,
        download_dir=download_dir,
        temp_files=temp_files,
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()
