import re
from pathlib import Path
from urllib.parse import urlparse

from browser_context import clean_request_headers


STREAM_URL_RE = re.compile(r"(?:\.m3u8|\.mpd|\.ism(?:/Manifest)?)(?:$|[?#])", re.IGNORECASE)
RETRYABLE_BACKEND_ERROR_RE = re.compile(
    r"Unsupported URL|did not find any downloadable video formats|No video formats|Requested format is not available|Invalid data found when processing input|HTTP Error\s+(?:401|403|404|410|451)|CERTIFICATE_VERIFY_FAILED",
    re.IGNORECASE,
)


def is_stream_manifest_url(url, media_format=""):
    format_text = str(media_format or "").upper()
    if format_text in {"M3U8", "MPD", "ISM"}:
        return True
    return bool(STREAM_URL_RE.search(str(url or "")))


def is_retryable_backend_error(details):
    return bool(RETRYABLE_BACKEND_ERROR_RE.search(str(details or "")))


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
        "16",
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
        "--hls-segment-attempts",
        "5",
        "--hls-segment-timeout",
        "15",
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


def source_host(url):
    try:
        return urlparse(str(url or "")).hostname or ""
    except ValueError:
        return ""
