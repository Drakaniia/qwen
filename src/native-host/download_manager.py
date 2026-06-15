import threading

from fallback_engines import resolve_gallery_dl_command
from spotify_resolver import (
    build_youtube_download_command,
    fetch_spotify_track_metadata,
    is_spotify_url,
    parse_spotify_url,
    search_youtube,
)

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
from yt_dlp_command import build_yt_dlp_command, build_yt_dlp_fallback_variants
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
    extract_audio = bool(message.get("musicMode") or message.get("extractAudio") or False)
    audio_format = str(message.get("audioFormat") or "mp3").strip().lower() if extract_audio else None

    # ---- Spotify YouTube fallback ------------------------------------------------
    # When the URL is a Spotify track, yt-dlp cannot download it directly (DRM).
    # Instead we fetch metadata from Spotify, search YouTube for a match, and
    # download the audio from YouTube with proper Spotify metadata tagging.
    if is_spotify_url(url):
        _run_spotify_fallback_download(
            message,
            url,
            download_dir,
            yt_dlp_command,
            ffmpeg_location,
            aria2c_location,
            request_headers,
            cookies_file,
            temp_files,
            task_class,
        )
        return

    def build_command_kwargs(extra=None):
        kwargs = dict(
            url=url,
            download_dir=download_dir,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            selected_format=message.get("formatId"),
            extract_audio=extract_audio,
            audio_format=audio_format,
        )
        if extra:
            kwargs.update(extra)
        return kwargs

    command = build_yt_dlp_command(**build_command_kwargs({"aria2c_location": aria2c_location}))
    fallback_command = None
    if aria2c_location:
        fallback_command = build_yt_dlp_command(**build_command_kwargs({"aria2c_location": None}))

    # ---- Fallback chain: multiple strategies exhaustively tried -------------------
    fallback_commands = []

    # 1. yt-dlp strategy variants (SSL, geo, retries, etc.)
    fallback_commands.extend(build_yt_dlp_fallback_variants(**build_command_kwargs()))

    # 2. N_m3u8DL-RE for HLS/DASH manifest URLs
    requested_backend = str(message.get("backend") or "auto").lower()
    if (
        requested_backend in {"auto", "n_m3u8dl-re", "n_m3u8dl_re", "n-m3u8dl-re"}
        and n_m3u8dl_re_location
        and is_stream_manifest_url(url, message.get("format"))
    ):
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

    # 3. Streamlink for live-stream / HLS manifest URLs
    if (
        requested_backend in {"auto", "streamlink"}
        and streamlink_command
        and is_stream_manifest_url(url, message.get("format"))
    ):
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

    # 4. gallery-dl for image/gallery sites (if available)
    gallery_dl_cmd = resolve_gallery_dl_command()
    if gallery_dl_cmd:
        fallback_commands.append(
            {
                "command": [
                    *gallery_dl_cmd,
                    "--directory",
                    str(download_dir),
                    "--no-colors",
                    "--no-mtime",
                    str(url),
                ],
                "label": "gallery-dl",
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


def _run_spotify_fallback_download(
    message,
    url,
    download_dir,
    yt_dlp_command,
    ffmpeg_location,
    aria2c_location,
    request_headers,
    cookies_file,
    temp_files,
    task_class,
):
    """Run a Spotify→YouTube fallback download.

    Resolves the Spotify URL through the multi-stage pipeline:
        1. Fetch track metadata from Spotify embed page.
        2. Search YouTube for a matching video.
        3. Build a yt-dlp command that downloads audio from YouTube
           and tags it with Spotify metadata.
    """
    request_id = str(message.get("id") or message.get("requestId") or "")
    selected_format = str(message.get("formatId") or "best").strip()
    content_type, track_id = parse_spotify_url(url)

    if content_type != "track":
        raise HostError(f"Qwin can only resolve individual Spotify tracks. {content_type}s are not yet supported.")

    # Stage 1: Fetch Spotify metadata
    metadata = fetch_spotify_track_metadata(track_id)
    display_title = f"{metadata['artist']} — {metadata['title']}"

    # Stage 2: Search YouTube for matching audio
    youtube_entry = search_youtube(metadata["artist"], metadata["title"], yt_dlp_command)
    if not youtube_entry:
        raise HostError(
            f'Could not find "{display_title}" on YouTube. '
            "The track may be too new, region-restricted, or available only on Spotify."
        )

    youtube_url = youtube_entry.get("url") or (f"https://www.youtube.com/watch?v={youtube_entry['id']}")

    # Stage 3: Build YouTube download command with audio extraction
    # If user selected "best", use bestaudio; otherwise use the selected format_id
    fmt_id = "bestaudio/best" if selected_format == "best" else selected_format

    command = build_youtube_download_command(
        youtube_url=youtube_url,
        format_id=fmt_id,
        download_dir=download_dir,
        spotify_metadata=metadata,
        yt_dlp_command=yt_dlp_command,
        ffmpeg_location=ffmpeg_location,
        aria2c_location=aria2c_location,
    )

    # Build fallback command without aria2c
    fallback_command = None
    if aria2c_location:
        fallback_command = build_youtube_download_command(
            youtube_url=youtube_url,
            format_id=fmt_id,
            download_dir=download_dir,
            spotify_metadata=metadata,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            aria2c_location=None,
        )

    # Build fallback variants for the YouTube URL
    fallback_commands = []

    def _yt_base():
        return build_youtube_download_command(
            youtube_url=youtube_url,
            format_id="bestaudio/best",
            download_dir=download_dir,
            spotify_metadata=metadata,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
        )

    # 1 — No SSL check
    no_ssl = _yt_base()
    no_ssl.insert(no_ssl.index("--ignore-config") + 1, "--no-check-certificate")
    fallback_commands.append({"command": no_ssl, "label": "yt-dlp (YouTube, no SSL check)"})

    # 2 — Geo bypass
    geo = _yt_base()
    geo.insert(geo.index("--ignore-config") + 1, "--geo-bypass")
    fallback_commands.append({"command": geo, "label": "yt-dlp (YouTube, geo bypass)"})

    # 3 — Max retries
    retry = _yt_base()
    retry.extend(["--retries", "infinite", "--fragment-retries", "infinite", "--extractor-retries", "10"])
    fallback_commands.append({"command": retry, "label": "yt-dlp (YouTube, max retries)"})

    # 4 — Single fragment
    single = _yt_base()
    idx = single.index("--ignore-config") + 1
    single.insert(idx, "1")
    single.insert(idx, "--concurrent-fragments")
    fallback_commands.append({"command": single, "label": "yt-dlp (YouTube, single fragment)"})

    task = task_class(
        message={**message, "url": youtube_url, "spotifyMetadata": metadata},
        command=command,
        fallback_command=fallback_command,
        fallback_commands=fallback_commands,
        download_dir=download_dir,
        temp_files=temp_files,
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task

    # Notify the popup that we're using YouTube fallback
    task.send_message(
        {
            "type": "progress",
            "stage": "log",
            "line": f"Spotify track resolved to YouTube: {youtube_entry.get('title', '')}",
        }
    )

    task.start()
