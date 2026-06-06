import json
import subprocess

from browser_context import remove_temp_files, write_cookie_file_from_headers
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message
from process_control import creation_flags
from yt_dlp_command import build_formats_command, summarize_formats
from yt_dlp_dependencies import resolve_ffmpeg_location, resolve_yt_dlp_command


def run_format_list(
    message,
    send=send_native_message,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []
    try:
        command = build_formats_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command_resolver(),
            ffmpeg_location=ffmpeg_location_resolver(),
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
            creationflags=creation_flags(),
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

    send({"type": "formats", "id": request_id, **summarize_formats(info)})
