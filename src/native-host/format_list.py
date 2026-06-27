import json
import subprocess

from fallback_engines import list_formats_gallery_dl, list_formats_lux, list_formats_you_get
from spotify_resolver import is_spotify_url, resolve_spotify_formats

from browser_context import remove_temp_files, write_cookie_file_from_headers
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message
from process_control import creation_flags
from yt_dlp_command import (
    build_flat_playlist_command,
    build_formats_command,
    summarize_audio_formats,
    summarize_formats,
)
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

    def execute_yt_dlp(nocheckcertificate=False):
        command = build_formats_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command_resolver(),
            ffmpeg_location=ffmpeg_location_resolver(),
            nocheckcertificate=nocheckcertificate,
        )
        return subprocess.run(
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

    try:
        completed = execute_yt_dlp(nocheckcertificate=False)
        if completed.returncode != 0:
            details = (completed.stderr or completed.stdout or "").strip()
            if "CERTIFICATE_VERIFY_FAILED" in details:
                completed = execute_yt_dlp(nocheckcertificate=True)
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while asking yt-dlp for available qualities.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc
    finally:
        remove_temp_files(temp_files)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()

        # -- Spotify DRM fallback --------------------------------------------------
        # yt-dlp hard-blocks Spotify with [DRM]. Use the Spotify resolver to fetch
        # metadata from Spotify's embed page, search YouTube, and return YouTube audio
        # formats instead.
        if is_spotify_url(url) and "DRM" in details:
            try:
                result = resolve_spotify_formats(
                    url,
                    yt_dlp_command=yt_dlp_command_resolver(),
                    ffmpeg_location=ffmpeg_location_resolver(),
                )
                send({"type": "formats", "id": request_id, **result})
                return
            except HostError:
                # Propagate the resolver's error message (e.g. "only tracks
                # supported") instead of the raw yt-dlp DRM error — it is more
                # actionable for the user.
                raise

        # -- gallery-dl fallback ----------------------------------------------------
        # For image/gallery sites that yt-dlp doesn't handle, try gallery-dl
        gallery_formats = list_formats_gallery_dl(url)
        if gallery_formats:
            send(
                {
                    "type": "formats",
                    "id": request_id,
                    "title": "Media",
                    "webpageUrl": url,
                    "formats": gallery_formats,
                }
            )
            return

        # -- you-get fallback ---------------------------------------------------------
        # For Asian media platforms (Bilibili, Douyin, Weibo, AcFun, Niconico)
        # that yt-dlp may not support well, try you-get
        you_get_formats = list_formats_you_get(url)
        if you_get_formats:
            send(
                {
                    "type": "formats",
                    "id": request_id,
                    "title": "Media",
                    "webpageUrl": url,
                    "formats": you_get_formats,
                }
            )
            return

        # -- lux fallback -------------------------------------------------------------
        # For sites that lux handles better (Bilibili, Douyin, etc.),
        # try lux as another alternative
        lux_formats = list_formats_lux(url)
        if lux_formats:
            send(
                {
                    "type": "formats",
                    "id": request_id,
                    "title": "Media",
                    "webpageUrl": url,
                    "formats": lux_formats,
                }
            )
            return

        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    try:
        info = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HostError("yt-dlp returned invalid format metadata.") from exc

    music_mode = bool(message.get("musicMode") or message.get("music_mode") or False)
    if music_mode:
        send({"type": "formats", "id": request_id, **summarize_audio_formats(info)})
    else:
        send({"type": "formats", "id": request_id, **summarize_formats(info)})


def run_playlist_enumeration(
    message,
    send=send_native_message,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
):
    """Enumerate items in a playlist via yt-dlp --flat-playlist --dump-json.

    Returns a JSON array of playlist items, each containing:
      - id (str): The video ID
      - url (str): The video URL
      - title (str): The video title
      - duration (int, optional): Duration in seconds (may not be available with flat-playlist)

    Sends a message with type ``playlistItems``.
    """
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []

    def execute_yt_dlp(nocheckcertificate=False):
        command = build_flat_playlist_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command_resolver(),
            ffmpeg_location=ffmpeg_location_resolver(),
            nocheckcertificate=nocheckcertificate,
        )
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=creation_flags(),
        )

    try:
        completed = execute_yt_dlp(nocheckcertificate=False)
        if completed.returncode != 0:
            details = (completed.stderr or completed.stdout or "").strip()
            if "CERTIFICATE_VERIFY_FAILED" in details:
                completed = execute_yt_dlp(nocheckcertificate=True)
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while enumerating playlist items.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc
    finally:
        remove_temp_files(temp_files)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    # Parse each line as a JSON entry (--dump-json outputs one JSON line per item)
    items = []
    playlist_title = ""
    for line in completed.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Capture playlist-level info from the first entry
        if not playlist_title:
            playlist_title = entry.get("playlist_title") or entry.get("playlist") or ""

        # Each entry represents one item in the playlist
        item_id = str(entry.get("id") or "").strip()
        item_url = str(entry.get("url") or "").strip() or entry.get("webpage_url") or ""
        item_title = str(entry.get("title") or "").strip()
        item_duration = entry.get("duration") or 0

        if not item_id and not item_url:
            continue

        items.append(
            {
                "id": item_id,
                "url": item_url,
                "title": item_title or f"Item {len(items) + 1}",
                "duration": int(item_duration) if item_duration else 0,
            }
        )

    send(
        {
            "type": "playlistItems",
            "id": request_id,
            "ok": True,
            "items": items,
            "playlistTitle": playlist_title,
            "totalItems": len(items),
        }
    )
