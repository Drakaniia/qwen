import html
import re
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

import curl_cffi_adapter as _curl_cffi_adapter
from browser_context import clean_request_headers
from media_candidates import classify_media_url, is_reusable_media_url


# ── SW data enhancement ──────────────────────────────────────────────────────

def enhance_with_sw_data(candidates: list[dict], sw_segments: list[dict]) -> list[dict]:
    """Merge SW-captured media response data into media candidates list.

    When the Service Worker captures a media response, it has the actual
    body and Content-Type. This function enriches the media candidates
    with SW data, or adds new candidates for URLs the page scanner missed.
    """
    sw_urls = {s.get("url", "") for s in sw_segments if s.get("url")}
    seen_urls = {c.get("url", "") for c in candidates}

    enriched = list(candidates)
    for seg in sw_segments:
        url = seg.get("url", "")
        if url in sw_urls and url not in seen_urls:
            enriched.append({
                "url": url,
                "format": _detect_format_from_url(url),
                "mimeType": seg.get("contentType", ""),
                "source": "sw-capture",
                "bodyLength": seg.get("bodyLength", 0),
                "bodyB64": seg.get("bodyB64", ""),
            })
            seen_urls.add(url)

    return enriched


def _detect_format_from_url(url: str) -> str:
    if re.search(r"\.(?:m3u8|mpd)(?:\?|$)", url, re.IGNORECASE):
        return "manifest"
    elif re.search(r"\.(?:ts|m4s|cmfv|cmfa)(?:\?|$)", url, re.IGNORECASE):
        return "segment"
    elif re.search(r"\.(?:mp4|webm|mkv|mov|avi)(?:\?|$)", url, re.IGNORECASE):
        return "direct"
    return "unknown"
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message

MAX_RESOLVER_BYTES = 1_500_000
RESOLVER_TIMEOUT_SECONDS = 12
MEDIA_URL_RE = re.compile(
    r"(?:(?:https?:)?(?:\\?/\\?/)|/)[^\"'`<>\s]+(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^\"'`<>\s]*)?|\.ism(?:\\?/Manifest)?(?:[?#][^\"'`<>\s]*)?)",
    re.IGNORECASE,
)
# Broader pattern to catch .m3u8/.mpd URLs that may appear in unusual contexts —
# e.g., partial URLs in JS strings, config blobs, or escaped JSON where the
# strict MEDIA_URL_RE yields a partial match that gets dropped by is_reusable_media_url.
BROAD_M3U8_RE = re.compile(
    r"https?://[^\"'`<>\s]*?\.m3u8[^\"'`<>\s]*",
    re.IGNORECASE,
)
BROAD_MPD_RE = re.compile(
    r"https?://[^\"'`<>\s]*?\.mpd[^\"'`<>\s]*",
    re.IGNORECASE,
)
# Data-attribute patterns common for HLS config (e.g., data-hls, data-video-url, data-file).
DATA_ATTR_M3U8_RE = re.compile(
    r'data-(?:hls[-_]?src|video[-_]?url|file[-_]?src|stream[-_]?url|manifest[-_]?url|source[-_]?url)\s*=\s*["\']([^"\']*?\.m3u8[^"\']*)["\']',
    re.IGNORECASE,
)
# JSON-like value patterns in script configs: "file":"...", "url":"...", "src":"..."
JSON_VALUE_M3U8_RE = re.compile(
    r'["\'](?:file|url|src|source|manifest|playlist|hls|stream)["\']\s*:\s*["\']([^"\']*?\.m3u8[^"\']*)["\']',
    re.IGNORECASE,
)
JS_STRING_RE = r"[`'\"]([^`'\"]+)[`'\"]"


def decode_candidate_url(value):
    text = str(value or "").strip().replace("\\/", "/")
    text = html.unescape(text).replace("\\u0026", "&")
    text = re.sub(r"[),.;]+$", "", text)
    for _index in range(2):
        decoded = unquote(text)
        if decoded == text:
            break
        text = decoded
    return text


def absolute_candidate_url(value, base_url):
    candidate = decode_candidate_url(value)
    if candidate.startswith("//"):
        parsed_base = urlparse(base_url)
        candidate = f"{parsed_base.scheme or 'https'}:{candidate}"
    return urljoin(base_url, candidate)


def extract_media_candidates_from_text(text, base_url, source="page-scan"):
    candidates = []
    seen = set()
    decoded_text = decode_candidate_url(text)

    # 1. Strict URL matching (existing)
    for match in MEDIA_URL_RE.finditer(decoded_text):
        url = absolute_candidate_url(match.group(0), base_url)
        if not is_reusable_media_url(url) or url in seen:
            continue
        seen.add(url)
        candidates.append(
            {
                "url": url,
                "format": classify_media_url(url),
                "source": source,
                "confidence": 90 if classify_media_url(url) in {"M3U8", "MPD", "ISM"} else 80,
            }
        )

    # 2. Broader m3u8/mpd URL matching — catches URLs the strict regex might fragment
    for broad_re in (BROAD_M3U8_RE, BROAD_MPD_RE):
        for match in broad_re.finditer(decoded_text):
            url = absolute_candidate_url(match.group(0), base_url)
            if not is_reusable_media_url(url) or url in seen:
                continue
            seen.add(url)
            candidates.append(
                {
                    "url": url,
                    "format": classify_media_url(url),
                    "source": source,
                    "confidence": 85,
                }
            )

    # 3. Data-attribute HLS references (e.g., data-hls-src="https://...")
    for match in DATA_ATTR_M3U8_RE.finditer(decoded_text):
        raw_url = decode_candidate_url(match.group(1))
        url = absolute_candidate_url(raw_url, base_url)
        if not is_reusable_media_url(url) or url in seen:
            continue
        seen.add(url)
        candidates.append(
            {
                "url": url,
                "format": "M3U8",
                "source": "data-attribute",
                "confidence": 92,
            }
        )

    # 4. JSON config value matching ("file":"...m3u8", "url":"...m3u8")
    for match in JSON_VALUE_M3U8_RE.finditer(decoded_text):
        raw_url = decode_candidate_url(match.group(1))
        url = absolute_candidate_url(raw_url, base_url)
        if not is_reusable_media_url(url) or url in seen:
            continue
        seen.add(url)
        candidates.append(
            {
                "url": url,
                "format": "M3U8",
                "source": "json-config",
                "confidence": 88,
            }
        )

    # 5. Dynamic loader / video ID reconstruction (existing)
    candidates.extend(extract_dynamic_loader_candidates(decoded_text, base_url, seen))
    return candidates


def extract_dynamic_loader_candidates(text, base_url, seen=None):
    seen_urls = seen if seen is not None else set()
    candidates = []

    # Identify potential loader base URLs and video IDs by scanning all string literals in the script.
    # We look for strings that look like partial loader paths and strings that look like alphanumeric IDs.
    strings = re.findall(JS_STRING_RE, text)
    loaders = []
    ids = []

    for s in strings:
        decoded = decode_candidate_url(s)
        # Loader bases often contain tokens like 'm3u8', 'loader', 'playlist', or 'xs1.php' (generic pattern).
        # They usually end with a parameter marker like 'data=' or a path separator.
        if decoded.startswith(("http", "//", "/")) and any(
            token in decoded.lower() for token in ["loader", "m3u8", "playlist", "manifest", "xs1.php", "stream"]
        ):
            loaders.append(decoded)
        # Video IDs are typically 10-64 characters of alphanumeric or safe characters.
        elif re.fullmatch(r"[a-zA-Z0-9_-]{10,64}", decoded):
            ids.append(decoded)

    if not loaders or not ids:
        return candidates

    for loader in loaders:
        loader_url = absolute_candidate_url(loader, base_url)
        for video_id in ids:
            url = (
                urljoin(loader_url, video_id) if not loader_url.endswith(("=", "/", "?")) else f"{loader_url}{video_id}"
            )
            if url in seen_urls:
                continue
            try:
                parsed = urlparse(url)
            except ValueError:
                continue
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                continue

            seen_urls.add(url)
            candidates.append(
                {
                    "url": url,
                    "format": "M3U8",
                    "source": "player-config",
                    "confidence": 96,
                }
            )

    return candidates


def content_type_from_response(response):
    try:
        return str(response.headers.get("Content-Type") or response.headers.get("content-type") or "").lower()
    except AttributeError:
        return ""


def decode_response_body(response):
    content = response.read(MAX_RESOLVER_BYTES + 1)
    if len(content) > MAX_RESOLVER_BYTES:
        content = content[:MAX_RESOLVER_BYTES]
    return content.decode("utf-8", errors="replace")


def request_headers_for_resolver(message):
    headers = {}
    for header in clean_request_headers(message.get("requestHeaders")):
        name = header["name"]
        if name.lower() in {
            "accept",
            "accept-language",
            "cookie",
            "origin",
            "referer",
            "user-agent",
            "x-requested-with",
        }:
            headers[name] = header["value"]

    user_agent = str(message.get("userAgent") or "").strip()
    if user_agent and "User-Agent" not in headers and "user-agent" not in {name.lower() for name in headers}:
        headers["User-Agent"] = user_agent
    page_url = str(message.get("pageUrl") or "").strip()
    if page_url and "Referer" not in headers and "referer" not in {name.lower() for name in headers}:
        headers["Referer"] = page_url
    if "Accept" not in headers and "accept" not in {name.lower() for name in headers}:
        headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    return headers


def fetch_resolver_text(url, message, urlopen_fn=urlopen):
    headers = request_headers_for_resolver(message)

    # Try curl_cffi first for TLS impersonation (bypasses WAF/CDN blocking)
    if _curl_cffi_adapter.curl_cffi_available():
        text = _curl_cffi_adapter.fetch_page_text(url, headers, impersonate="chrome")
        if text:
            return text

    # Fall back to urllib
    request = Request(url, headers=headers)
    with urlopen_fn(request, timeout=RESOLVER_TIMEOUT_SECONDS) as response:
        content_type = content_type_from_response(response)
        if content_type and not any(
            token in content_type for token in ["text/", "html", "javascript", "json", "xml", "mpegurl", "dash+xml"]
        ):
            return ""
        return decode_response_body(response)


def resolve_media_candidates(message, send=send_native_message, urlopen_fn=urlopen):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    try:
        text = fetch_resolver_text(url, message, urlopen_fn=urlopen_fn)
    except Exception as exc:
        raise HostError(f"Could not inspect player page for media URLs: {exc}") from exc

    candidates = extract_media_candidates_from_text(text, url, source="player-config")
    send({"type": "mediaCandidates", "id": request_id, "candidates": candidates})
