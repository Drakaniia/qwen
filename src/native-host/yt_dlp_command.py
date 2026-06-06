from pathlib import Path
from urllib.parse import urlparse

from browser_context import append_browser_context_options
from native_paths import sanitize_filename
from progress_parser import FILEPATH_MARKER


DEFAULT_FORMAT_SELECTOR = "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b"
YOUTUBE_REMOTE_COMPONENTS = "ejs:github"
GENERIC_EXTRACTOR_ARGS = "generic:impersonate"
MAX_FAST_CONNECTIONS = 32
MAX_ARIA2_CONNECTIONS = 16
DEFAULT_CONCURRENT_FRAGMENTS = MAX_FAST_CONNECTIONS
DEFAULT_ARIA2_CONNECTIONS = MAX_ARIA2_CONNECTIONS


def bounded_int(value, default, minimum=1, maximum=MAX_FAST_CONNECTIONS):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def is_youtube_url(url):
    try:
        host = urlparse(str(url or "")).hostname or ""
    except Exception:
        return False
    host = host.lower()
    return host == "youtu.be" or host.endswith(".youtube.com") or host.endswith(".youtube-nocookie.com")


def append_youtube_ejs_options(command, url):
    if is_youtube_url(url):
        command.extend(["--remote-components", YOUTUBE_REMOTE_COMPONENTS])


def append_generic_impersonation_options(command):
    command.extend(["--extractor-args", GENERIC_EXTRACTOR_ARGS])


def format_selector_for_choice(selected_format):
    selected = str(selected_format or "").strip()
    if not selected or selected == "best":
        return DEFAULT_FORMAT_SELECTOR
    if any(separator in selected for separator in ["+", "/", ","]):
        return selected
    return f"{selected}+bestaudio/best"


def build_yt_dlp_command(
    url,
    download_dir,
    referer=None,
    user_agent=None,
    request_headers=None,
    cookies_file=None,
    yt_dlp_command=None,
    ffmpeg_location=None,
    aria2c_location=None,
    selected_format=None,
    concurrent_fragments=None,
    aria2_connections=None,
):
    download_root = str(Path(download_dir))
    output_template = "%(title).180B/%(title).180B [%(id)s].%(ext)s"
    format_selector = format_selector_for_choice(selected_format)
    fragment_count = bounded_int(concurrent_fragments, DEFAULT_CONCURRENT_FRAGMENTS)
    command = [
        *(yt_dlp_command or ["yt-dlp"]),
        "--ignore-config",
        "--newline",
        "--no-color",
        "--progress",
        "--windows-filenames",
        "--restrict-filenames",
        "--trim-filenames",
        "180",
        "--paths",
        f"home:{download_root}",
        # Leave temp unset so HLS/DASH fragments are written beside the templated output.
        "--concurrent-fragments",
        str(fragment_count),
        "--no-keep-fragments",
        "--no-playlist",
        "-f",
        format_selector,
        "--merge-output-format",
        "mp4",
        "--recode-video",
        "mp4",
        "--print",
        f"after_move:{FILEPATH_MARKER}%(filepath)s",
        "-o",
        output_template,
    ]
    append_youtube_ejs_options(command, url)
    append_generic_impersonation_options(command)

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])
    if aria2c_location:
        connection_count = bounded_int(
            aria2_connections,
            DEFAULT_ARIA2_CONNECTIONS,
            maximum=MAX_ARIA2_CONNECTIONS,
        )
        aria2_args = " ".join(
            [
                f"--max-connection-per-server={connection_count}",
                f"--split={connection_count}",
                "--min-split-size=1M",
                "--continue=true",
                "--file-allocation=none",
                "--max-tries=8",
                "--retry-wait=2",
                "--summary-interval=1",
            ]
        )
        command.extend(
            [
                "--downloader",
                str(aria2c_location),
                "--downloader",
                "dash,m3u8:native",
                "--downloader-args",
                f"aria2c:{aria2_args}",
            ]
        )
    append_browser_context_options(
        command,
        referer=referer,
        user_agent=user_agent,
        request_headers=request_headers,
        cookies_file=cookies_file,
    )

    command.append(url)
    return command


def build_formats_command(
    url,
    referer=None,
    user_agent=None,
    request_headers=None,
    cookies_file=None,
    yt_dlp_command=None,
    ffmpeg_location=None,
):
    command = [
        *(yt_dlp_command or ["yt-dlp"]),
        "--ignore-config",
        "--dump-single-json",
        "--no-warnings",
        "--no-color",
        "--no-playlist",
        "--skip-download",
    ]
    append_youtube_ejs_options(command, url)
    append_generic_impersonation_options(command)

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])
    append_browser_context_options(
        command,
        referer=referer,
        user_agent=user_agent,
        request_headers=request_headers,
        cookies_file=cookies_file,
    )

    command.append(url)
    return command


def human_size(num_bytes):
    if not num_bytes:
        return ""
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return ""


def format_label(item):
    height = item.get("height")
    width = item.get("width")
    ext = str(item.get("ext") or "").upper()
    note = str(item.get("format_note") or "").strip()
    fps = item.get("fps")

    if height:
        label = f"{int(height)}p"
    elif width:
        label = f"{int(width)}w"
    elif note:
        label = note
    else:
        label = str(item.get("format_id") or "format")

    if ext:
        label = f"{label} {ext}"
    if fps and float(fps) > 30:
        label = f"{label} {int(float(fps))}fps"
    return label


def format_sort_key(item):
    return (
        int(item.get("height") or 0),
        float(item.get("tbr") or 0),
        int(item.get("width") or 0),
    )


def is_segmented_stream_format(item):
    protocol = str(item.get("protocol") or "").lower()
    url = str(item.get("url") or "").lower()
    manifest_url = str(item.get("manifest_url") or "").lower()
    format_note = str(item.get("format_note") or "").lower()

    if any(token in protocol for token in ["m3u8", "hls", "dash"]):
        return True
    if any(value.endswith((".m3u8", ".mpd")) for value in [url.split("?", 1)[0], manifest_url.split("?", 1)[0]]):
        return True
    if item.get("fragments") and any(token in format_note for token in ["hls", "dash", "fragment"]):
        return True
    return False


def summarize_formats(info):
    title = sanitize_filename(info.get("title") or info.get("fulltitle") or "Video")
    webpage_url = info.get("webpage_url") or info.get("original_url") or ""
    raw_formats = info.get("formats") or []
    seen_ids = set()
    choices = []

    video_formats = []
    for item in raw_formats:
        format_id = str(item.get("format_id") or "").strip()
        if not format_id or format_id in seen_ids:
            continue
        if str(item.get("vcodec") or "none").lower() == "none":
            continue
        if is_segmented_stream_format(item):
            continue
        seen_ids.add(format_id)
        video_formats.append(item)

    if video_formats:
        choices.append(
            {
                "id": "best",
                "label": "Best available MP4",
                "ext": "mp4",
                "height": None,
                "size": "",
                "note": "Recommended",
            }
        )

    for item in sorted(video_formats, key=format_sort_key, reverse=True)[:25]:
        choices.append(
            {
                "id": str(item.get("format_id")),
                "label": format_label(item),
                "ext": item.get("ext") or "",
                "height": item.get("height"),
                "width": item.get("width"),
                "fps": item.get("fps"),
                "vcodec": item.get("vcodec") or "",
                "acodec": item.get("acodec") or "",
                "tbr": item.get("tbr"),
                "size": human_size(item.get("filesize") or item.get("filesize_approx")),
                "note": item.get("format_note") or "",
            }
        )

    return {
        "title": title,
        "webpageUrl": webpage_url,
        "formats": choices,
    }
