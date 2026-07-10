"""Spotify→YouTube fallback download pipeline.

When the URL is a Spotify track, yt-dlp cannot download it directly (DRM).
This module resolves the Spotify URL through a multi-stage pipeline:
    1. Fetch track metadata from Spotify embed page.
    2. Search YouTube for a matching video.
    3. Build a yt-dlp command that downloads audio from YouTube
       and tags it with Spotify metadata.
"""

from spotify_metadata import fetch_spotify_track_metadata, parse_spotify_url
from spotify_youtube import build_youtube_download_command, search_youtube

from download_task import DownloadTask
from native_protocol import HostError


def run_spotify_fallback_download(
    message,
    url,
    download_dir,
    yt_dlp_command,
    ffmpeg_location,
    aria2c_location,
    request_headers,
    cookies_file,
    temp_files,
    task_class=DownloadTask,
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

    # aria2c is required — no fallback without it
    fallback_command = None

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

    from download_manager import ACTIVE_DOWNLOADS, _active_downloads_lock

    # Notify the popup that we're using YouTube fallback
    task.send_message(
        {
            "type": "progress",
            "stage": "log",
            "line": f"Spotify track resolved to YouTube: {youtube_entry.get('title', '')}",
        }
    )

    task.start()
