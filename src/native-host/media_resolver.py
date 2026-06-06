import html
import re
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen

from browser_context import clean_request_headers
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message


MAX_RESOLVER_BYTES = 1_500_000
RESOLVER_TIMEOUT_SECONDS = 12
MEDIA_URL_RE = re.compile(
    r"(?:(?:https?:)?(?:\\?/\\?/)|/)[^\"'`<>\s]+(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^\"'`<>\s]*)?|\.ism(?:\\?/Manifest)?(?:[?#][^\"'`<>\s]*)?)",
    re.IGNORECASE,
)
JS_STRING_RE = r"[`'\"]([^`'\"]+)[`'\"]"
AD_RE = re.compile(
    r"(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|/ads?/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola)",
    re.IGNORECASE,
)
GIF_RE = re.compile(r"\.(?:gif|gifv)(?:$|[?#])", re.IGNORECASE)
SEGMENT_RE = re.compile(
    r"(?:\.(?:ts|m4s|cmfv|cmfa)(?:$|[?#])|(?:^|[/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part)[._-]?\d+(?:[/?#._-]|$))",
    re.IGNORECASE,
)
STATIC_ASSET_RE = re.compile(r"\.(?:hlsjs|js|mjs|cjs|css|map)(?:$|[?#])", re.IGNORECASE)


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


def classify_media_url(url):
    text = str(url or "").lower()
    if ".m3u8" in text:
        return "M3U8"
    if ".mpd" in text:
        return "MPD"
    if re.search(r"\.ism(?:/manifest)?(?:$|[?#])", text):
        return "ISM"
    if ".webm" in text:
        return "WEBM"
    if ".mp4" in text or ".m4v" in text:
        return "MP4"
    return "VIDEO"


def is_reusable_media_url(url):
    try:
        parsed = urlparse(str(url or ""))
    except ValueError:
        return False

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False

    text = parsed.geturl()
    if text.startswith(("blob:", "data:", "file:")):
        return False
    if AD_RE.search(text) or GIF_RE.search(text) or SEGMENT_RE.search(text) or STATIC_ASSET_RE.search(text):
        return False
    return classify_media_url(text) != "VIDEO"


def extract_media_candidates_from_text(text, base_url, source="page-scan"):
    candidates = []
    seen = set()
    decoded_text = decode_candidate_url(text)
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
            url = urljoin(loader_url, video_id) if not loader_url.endswith(("=", "/", "?")) else f"{loader_url}{video_id}"
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
        if name.lower() in {"accept", "accept-language", "cookie", "origin", "referer", "user-agent", "x-requested-with"}:
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
    request = Request(url, headers=request_headers_for_resolver(message))
    with urlopen_fn(request, timeout=RESOLVER_TIMEOUT_SECONDS) as response:
        content_type = content_type_from_response(response)
        if content_type and not any(
            token in content_type
            for token in ["text/", "html", "javascript", "json", "xml", "mpegurl", "dash+xml"]
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
