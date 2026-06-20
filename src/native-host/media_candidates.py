import re
from urllib.parse import urlparse

HLS_RE = re.compile(r"\.m3u8(?:$|[?#])", re.IGNORECASE)
DASH_RE = re.compile(r"\.mpd(?:$|[?#])", re.IGNORECASE)
ISM_RE = re.compile(r"\.ism(?:/manifest)?(?:$|[?#])", re.IGNORECASE)
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
STATIC_PAGE_ASSET_RE = re.compile(r"/(?:stylesheet|theme-color|browserconfig)(?:$|[?#])", re.IGNORECASE)
WEB_APP_MANIFEST_RE = re.compile(
    r"(?:\.webmanifest|(?:^|[/?#._-])manifest\.(?:json|webm)(?:$|[?#]))",
    re.IGNORECASE,
)


def is_ephemeral_media_url(url):
    try:
        parsed = urlparse(str(url or ""))
    except ValueError:
        return False

    host = (parsed.hostname or "").lower()
    return (host == "googlevideo.com" or host.endswith(".googlevideo.com")) and parsed.path == "/videoplayback"


def classify_media_url(url, content_type=""):
    text = str(url or "").lower()
    media_type = str(content_type or "").lower()
    if HLS_RE.search(text):
        return "M3U8"
    if DASH_RE.search(text):
        return "MPD"
    if ISM_RE.search(text):
        return "ISM"
    if re.search(r"\.webm(?:$|[?#])", text):
        return "WEBM"
    if re.search(r"\.(?:mp4|m4v)(?:$|[?#])", text):
        return "MP4"
    if "mpegurl" in media_type or "x-mpegurl" in media_type:
        return "M3U8"
    if "dash+xml" in media_type:
        return "MPD"
    if "video/webm" in media_type:
        return "WEBM"
    if "video/mp4" in media_type:
        return "MP4"
    if media_type.startswith("video/"):
        return media_type.replace("video/", "", 1).upper()
    return "VIDEO"


def is_reusable_media_url(url, content_type=""):
    try:
        parsed = urlparse(str(url or ""))
    except ValueError:
        return False

    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False

    text = parsed.geturl()
    media_type = str(content_type or "").lower()
    if text.startswith(("blob:", "data:", "file:")):
        return False
    if (
        AD_RE.search(text)
        or GIF_RE.search(text)
        or SEGMENT_RE.search(text)
        or STATIC_ASSET_RE.search(text)
        or STATIC_PAGE_ASSET_RE.search(text)
        or WEB_APP_MANIFEST_RE.search(text)
        or "manifest+json" in media_type
        or "webmanifest" in media_type
        or is_ephemeral_media_url(text)
    ):
        return False
    return classify_media_url(text, media_type) != "VIDEO"
