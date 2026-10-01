import re
from pathlib import Path

from browser_context import clean_request_headers

STREAM_URL_RE = re.compile(r"(?:\.m3u8|\.mpd|\.ism(?:/Manifest)?)(?:$|[?#])", re.IGNORECASE)


def is_stream_manifest_url(url, media_format=""):
    format_text = str(media_format or "").upper()
    if format_text in {"M3U8", "MPD", "ISM"}:
        return True
    return bool(STREAM_URL_RE.search(str(url or "")))


def stream_output_path(download_dir, title, suffix="mp4"):
    safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", str(title or "Video"))
    safe_title = re.sub(r"\s+", " ", safe_title).strip(" .") or "Video"
    safe_title = safe_title[:120]
    folder = Path(download_dir) / safe_title
    return folder / f"{safe_title}.{suffix}"


def header_args_for_n_m3u8dl_re(request_headers):
    args = []
    for header in clean_request_headers(request_headers):
        if header["name"].lower() in {"cookie", "referer", "origin", "user-agent", "accept", "accept-language"}:
            args.extend(["-H", f"{header['name']}: {header['value']}"])
    return args


def header_args_for_streamlink(request_headers):
    args = []
    for header in clean_request_headers(request_headers):
        name = header["name"].lower()
        if name == "cookie":
            continue
        if name in {"referer", "origin", "user-agent", "accept", "accept-language"}:
            args.extend(["--http-header", f"{header['name']}={header['value']}"])
    return args


def build_n_m3u8dl_re_command(
    url,
    output_path,
    request_headers=None,
    n_m3u8dl_re_location=None,
    ffmpeg_location=None,
):
    output = Path(output_path)
    command = [
        str(n_m3u8dl_re_location or "N_m3u8DL-RE"),
        "--auto-select",
        "--thread-count",
        "32",
        "--download-retry-count",
        "8",
        "--save-dir",
        str(output.parent),
        "--save-name",
        output.stem,
        "-M",
        "format=mp4",
    ]
    if ffmpeg_location:
        command.extend(["--ffmpeg-binary-path", str(ffmpeg_location)])
    command.extend(header_args_for_n_m3u8dl_re(request_headers))
    command.append(str(url))
    return command


def build_streamlink_command(
    url,
    output_path,
    request_headers=None,
    cookies_file=None,
    streamlink_command=None,
    ffmpeg_location=None,
):
    command = [
        *(streamlink_command or ["streamlink"]),
        "--retry-streams",
        "2",
        "--retry-max",
        "3",
        "--stream-segment-attempts",
        "5",
        "--stream-segment-timeout",
        "15",
        "--stream-segment-threads",
        "4",
        "--ringbuffer-size",
        "128M",
        "--force",
        "-o",
        str(output_path),
    ]
    if ffmpeg_location:
        command.extend(["--ffmpeg-ffmpeg", str(ffmpeg_location), "--ffmpeg-fout", "mp4"])
    if cookies_file:
        command.extend(["--http-cookies-file", str(cookies_file)])
    command.extend(header_args_for_streamlink(request_headers))
    command.extend([str(url), "best"])
    return command


def build_ffmpeg_direct_command(
    url,
    output_path,
    request_headers=None,
    ffmpeg_location=None,
):
    """Build an ffmpeg command for direct HLS/DASH stream copying.

    Produces::

        ffmpeg -headers <k:v pairs> -i <url> -c copy -y <output>

    This is the simplest, most reliable way to download an HLS or DASH
    stream once the manifest URL has been intercepted. Used as a fallback
    before gallery-dl / yt-dlp-native steps.

    Args:
        url: The stream manifest URL (m3u8, mpd, etc.).
        output_path: Full path for the output file (parent dir must exist).
        request_headers: Optional list of {"name": ..., "value": ...} dicts
                         to forward as custom HTTP headers.
        ffmpeg_location: Path to ffmpeg binary; defaults to "ffmpeg".

    Returns:
        List of command-line arguments suitable for subprocess.Popen.
    """
    command = [str(ffmpeg_location or "ffmpeg")]

    # Build custom header string (ffmpeg accepts -headers for HTTP headers)
    headers_parts = []
    if request_headers:
        for h in clean_request_headers(request_headers):
            name = h["name"]
            value = h["value"]
            headers_parts.append(f"{name}: {value}")

    if headers_parts:
        command.extend(["-headers", "\r\n".join(headers_parts)])

    command.extend(
        [
            "-i",
            str(url),
            "-c",
            "copy",
            "-y",
            str(output_path),
        ]
    )
    return command
