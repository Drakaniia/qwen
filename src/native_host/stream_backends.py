import re
from pathlib import Path
from urllib.parse import urlparse

from browser_context import clean_request_headers

STREAM_URL_RE = re.compile(r"(?:\.m3u8|\.mpd|\.ism(?:/Manifest)?)(?:$|[?#])", re.IGNORECASE)

# ─── LL-HLS & CMAF Detection (GAP 10) ────────────────────────────────────────

# Low-Latency HLS signs use `.m3u8?` with specific query parameters
# indicating block-download mode, partial segments, or delta playlists.
# Examples:
#   - playlist.m3u8?_HLS_ms=... (block-download mode)
#   - playlist.m3u8?delta=... (delta playlist)
#   - playlist.m3u8?part=... (partial segment)
LL_HLS_RE = re.compile(r"\.m3u8(?:$|[?#]).*?(?:_HLS_ms|delta|skip|part=|_HLS_part)", re.IGNORECASE)

# CMAF (Common Media Application Format) uses `.cmf` or `.cmfa` / `.cmfv`
# extensions for audio/video fragments, or `cmaf` in the URL path.
CMAF_RE = re.compile(r"(?:\.cmf(?:a|v)?(?:$|[?#])|/cmaf/)", re.IGNORECASE)

RETRYABLE_BACKEND_ERROR_RE = re.compile(
    r"Unsupported URL|did not find any downloadable video formats|No video formats|"
    r"Requested format is not available|Invalid data found when processing input|"
    r"HTTP Error\s+(?:401|403|404|410|451)|CERTIFICATE_VERIFY_FAILED|"
    r"ConnectionResetError|TransportError|RemoteDisconnected|Connection aborted|connection.*reset|10054",
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
        "--hls-segment-attempts",
        "5",
        "--hls-segment-timeout",
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

    command.extend([
        "-i",
        str(url),
        "-c",
        "copy",
        "-y",
        str(output_path),
    ])
    return command


def build_mp4decrypt_command(
    input_path,
    output_path,
    key,
    mp4decrypt_location=None,
):
    """Build an mp4decrypt command for CENC-decrypting a DASH segment.

    Produces::

        mp4decrypt --key 1:XXXX --key 2:YYYY <input> <output>

    ``mp4decrypt`` is part of the Bento4 suite and is the gold standard
    for decrypting Common Encryption (cenc / cbcs) MP4 segments after
    CDM key extraction.

    Args:
        input_path: Path to the encrypted segment file.
        output_path: Path for the decrypted output file.
        key: A single key string (e.g. "1:XXXXXXXX") or a list of keys.
        mp4decrypt_location: Path to mp4decrypt binary; defaults to
                             "mp4decrypt".

    Returns:
        List of command-line arguments suitable for subprocess.Popen.
    """
    command = [str(mp4decrypt_location or "mp4decrypt")]

    keys = key if isinstance(key, list) else [key]
    for k in keys:
        command.extend(["--key", str(k)])

    command.extend([str(input_path), str(output_path)])
    return command


# ─── LL-HLS / CMAF helpers (GAP 10) ─────────────────────────────────────────────


def is_ll_hls_url(url, media_format=""):
    """Check if a URL is a Low-Latency HLS stream.

    LL-HLS uses partial segments, delta playlists, and block-download
    mode. Standard HLS downloaders may not handle these correctly.

    Args:
        url: The URL to check.
        media_format: Optional format hint (e.g., 'M3U8').

    Returns:
        True if the URL looks like an LL-HLS stream.
    """
    if media_format and media_format.upper() not in {"M3U8", ""}:
        return False
    return bool(LL_HLS_RE.search(str(url or "")))


def is_cmaf_url(url):
    """Check if a URL is a CMAF (Common Media Application Format) stream.

    CMAF uses fragmented MP4 with `.cmfa` (audio) and `.cmfv` (video)
    extensions, or `/cmaf/` in the URL path.

    Args:
        url: The URL to check.

    Returns:
        True if the URL looks like a CMAF stream.
    """
    return bool(CMAF_RE.search(str(url or "")))


def is_low_latency_stream(url, media_format=""):
    """Check if a URL is any kind of low-latency streaming format
    (LL-HLS or CMAF).

    Args:
        url: The URL to check.
        media_format: Optional format hint.

    Returns:
        True if the URL is an LL-HLS or CMAF stream.
    """
    return is_ll_hls_url(url, media_format) or is_cmaf_url(url)


def source_host(url):
    try:
        return urlparse(str(url or "")).hostname or ""
    except ValueError:
        return ""
