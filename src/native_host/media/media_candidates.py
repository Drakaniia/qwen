import re
from urllib.parse import urlparse

VIDEO_EXTENSION_RE = re.compile(
    r"(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])|\.ism(?:/manifest)?(?:$|[?#]))", re.IGNORECASE
)
HLS_RE = re.compile(r"\.m3u8(?:$|[?#])", re.IGNORECASE)
DASH_RE = re.compile(r"\.mpd(?:$|[?#])", re.IGNORECASE)
ISM_RE = re.compile(r"\.ism(?:/manifest)?(?:$|[?#])", re.IGNORECASE)
AD_RE = re.compile(
    r"(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|/ads?/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola|adnxs|clmbtech|crwdcntrl|chartbeat|adobedtm|ensighten|fwmrm\.net|spotx(?:cdn)?\.(?:tv|com)|smartclip|adaptv\.advertising|2mdn\.net|youbora(?:nqs01)?\.com|popads\.net)",
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

# Phase A.3 — Streaming platform host patterns (block page URLs, allow stream URLs)
VIDEO_HOSTING_SITES_RE = re.compile(
    r"(?:^|[\\/.])(?:flashx|thevideo|hdvid|vidoza|powvideo|vidtech|streamplay|fileone|beeg)\.(?:pw|tv|to|net|pro|com)(?:$|[\\/?#])",
    re.IGNORECASE,
)
P2P_STREAMING_HOSTS_RE = re.compile(
    r"(?:^|[\\/.])(?:douyu|huya)\.(?:com|cn)(?:$|[\\/?#])",
    re.IGNORECASE,
)
LIVE_STREAMING_HOSTS_RE = re.compile(
    r"(?:^|[\\/.])(?:twitch|trovo|dlive|kick)\.(?:tv|com|live)(?:$|[\\/?#])",
    re.IGNORECASE,
)

# Phase A.4 — STATIC_ASSET refinements
AD_SDK_RE = re.compile(r"(?:/vast\\.js|/ad-plugin/|ad-manager|admanager)/[^/]+\\.js", re.IGNORECASE)

# Phase A.6 — P2P / Chinese streaming patterns
CHINESE_STREAMING_CDN_RE = re.compile(r"(?:douyucdn\\.cn|msstatic\\.com|huya\\.com/.*p2p)", re.IGNORECASE)
CHINESE_STREAMING_P2P_RE = re.compile(r"/front-publish/stream-sdk-lib-master/", re.IGNORECASE)

# Phase A.7 — Service Worker & WebSocket stream detection
SERVICE_WORKER_SCOPE_RE = re.compile(
    r"(?:^|[/?#._-])(?:sw(?:\.js|\b)|serviceworker(?:\.js|\b)|service-worker(?:\.js|\b)|worker\.js)(?:$|[?#])",
    re.IGNORECASE,
)
WEBSOCKET_RE = re.compile(r"^wss?://", re.IGNORECASE)


# ── Tiered confidence scoring constants ──────────────────────────────────

TIER_ALLOW = 4
TIER_PROBABLE = 3
TIER_UNKNOWN = 2
TIER_SUSPICIOUS = 1
TIER_BLOCK = 0


def classify_media_candidate(url, content_type=""):
    """Classify a URL into a tiered confidence score.

    Instead of a binary blocked/allowed classification, this function
    assigns a tier and confidence score that reflects how likely the
    URL is to be downloadable video content.

    Parameters
    ----------
    url : str
        The URL to classify.
    content_type : str
        Optional HTTP Content-Type header value.

    Returns
    -------
    dict
        With keys:
        - tier (int): TIER_ALLOW (4) through TIER_BLOCK (0)
        - confidence (int): 0-100 score
        - reason (str): Human-readable explanation
    """
    text = str(url or "").lower()
    media_type = str(content_type or "").lower()

    # ── Quick kills: definitely not video ────────────────────────

    # Non-HTTP protocols: blob, data, file, ftp — not downloadable via HTTP clients
    if text.startswith(("blob:", "data:", "file:", "ftp:")):
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": f"Non-HTTP protocol ({text.split(':')[0]}:) — not downloadable via HTTP"}

    # Static assets: JS, CSS, maps, fonts
    if STATIC_ASSET_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": "Static asset (JS/CSS/map)"}
    if STATIC_PAGE_ASSET_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": "Static page asset path"}
    if WEB_APP_MANIFEST_RE.search(text) or "manifest+json" in media_type or "webmanifest" in media_type:
        return {"tier": TIER_BLOCK, "confidence": 1, "reason": "Web app manifest"}

    # GIF and animated images
    if GIF_RE.search(text) or "image/gif" in media_type:
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": "GIF/animated image"}

    # Ad network URLs
    if AD_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 1, "reason": "Ad network URL"}

    # Chinese streaming P2P SDK paths
    if CHINESE_STREAMING_P2P_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": "P2P streaming SDK"}

    # Ad SDK paths
    if AD_SDK_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 0, "reason": "Ad SDK path"}

    # Ephemeral Google Video (googlevideo.com/videoplayback with byte ranges)
    if is_ephemeral_media_url(text):
        return {"tier": TIER_BLOCK, "confidence": 2, "reason": "Ephemeral stream URL (googlevideo)"}

    # Video hosting site page URLs (no video extension)
    if VIDEO_HOSTING_SITES_RE.search(text) and not VIDEO_EXTENSION_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 3, "reason": "Video hosting site page URL"}
    if P2P_STREAMING_HOSTS_RE.search(text) and not VIDEO_EXTENSION_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 3, "reason": "P2P streaming platform page URL"}
    if LIVE_STREAMING_HOSTS_RE.search(text) and not VIDEO_EXTENSION_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 3, "reason": "Live streaming platform page URL"}

    # Chinese streaming CDN segment URLs
    if CHINESE_STREAMING_CDN_RE.search(text) and (not VIDEO_EXTENSION_RE.search(text) or SEGMENT_RE.search(text)):
        return {"tier": TIER_BLOCK, "confidence": 2, "reason": "Chinese streaming CDN P2P segment"}

    # HLS/DASH segments (.ts, .m4s, .cmfv, .cmfa)
    if SEGMENT_RE.search(text):
        return {"tier": TIER_BLOCK, "confidence": 2, "reason": "Media segment (HLS/DASH fragment)"}

    # ── High confidence: clearly video ───────────────────────────

    # YouTube video page URLs (no file extension, but yt-dlp can handle them)
    if re.search(r"(?:^|[\/.])(?:youtube|youtu\.be)\.(?:com|be)(?:$|[\/?#])", text):
        return {"tier": TIER_ALLOW, "confidence": 99, "reason": "YouTube video page URL"}

    if HLS_RE.search(text):
        return {"tier": TIER_ALLOW, "confidence": 98, "reason": "HLS manifest (.m3u8)"}
    if DASH_RE.search(text):
        return {"tier": TIER_ALLOW, "confidence": 98, "reason": "DASH manifest (.mpd)"}
    if ISM_RE.search(text):
        return {"tier": TIER_ALLOW, "confidence": 98, "reason": "Smooth Streaming manifest (.ism)"}

    # Direct video file extensions
    if re.search(r"\.(?:mp4|m4v)(?:$|[?#])", text):
        return {"tier": TIER_ALLOW, "confidence": 97, "reason": "Direct MP4/M4V URL"}
    if re.search(r"\.webm(?:$|[?#])", text):
        return {"tier": TIER_ALLOW, "confidence": 96, "reason": "Direct WebM URL"}

    # Content-Type based classification
    if "mpegurl" in media_type or "x-mpegurl" in media_type:
        return {"tier": TIER_ALLOW, "confidence": 95, "reason": "HLS content type"}
    if "dash+xml" in media_type:
        return {"tier": TIER_ALLOW, "confidence": 95, "reason": "DASH content type"}
    if "video/mp4" in media_type:
        return {"tier": TIER_ALLOW, "confidence": 94, "reason": "MP4 content type"}
    if "video/webm" in media_type:
        return {"tier": TIER_ALLOW, "confidence": 94, "reason": "WebM content type"}
    if media_type.startswith("video/"):
        return {"tier": TIER_ALLOW, "confidence": 90, "reason": f"Video content type ({media_type})"}

    # ── Probable: likely video but needs confirmation ────────────

    # CDN hint patterns
    if re.search(r"(?:video|hls|dash|manifest|playlist|stream)", text):
        return {"tier": TIER_PROBABLE, "confidence": 80, "reason": "CDN/video keyword in URL"}
    if re.search(r"(?:videoplayback|playlist|master\.m3u8|akamai|cloudfront)", text):
        return {"tier": TIER_PROBABLE, "confidence": 75, "reason": "Video CDN hint in URL"}

    # ── Suspicious: no clear video signals ───────────────────────

    # Has HTTP/HTTPS scheme but no video indicators
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https") and parsed.netloc:
            return {"tier": TIER_SUSPICIOUS, "confidence": 10, "reason": "URL without video indicators"}
    except Exception:
        pass

    return {"tier": TIER_BLOCK, "confidence": 0, "reason": "Unrecognized or invalid URL"}


def is_service_worker_scope(initiator_url):
    """Check if a URL corresponds to a Service Worker script scope.

    Service Workers are commonly registered at paths like:
    - /sw.js
    - /serviceworker.js
    - /service-worker.js
    - /worker.js

    When a network request has its initiator set to one of these URLs,
    the response may be proxied through the Service Worker's cache,
    which can deliver video content through SW-managed streaming.

    Args:
        initiator_url: The URL of the script that initiated the request
                       (typically the Service Worker script URL).

    Returns:
        True if the URL matches a known Service Worker script path.
    """
    return bool(SERVICE_WORKER_SCOPE_RE.search(str(initiator_url or "")))


def is_websocket_url(url):
    """Check if a URL uses the WebSocket protocol (ws:// or wss://).

    Many modern streaming platforms deliver video frames through
    WebSocket connections rather than traditional HTTP streaming.
    Detected WebSocket upgrade URLs can be flagged for further
    inspection or capture.

    Args:
        url: The URL to check.

    Returns:
        True if the URL starts with ws:// or wss://.
    """
    return bool(WEBSOCKET_RE.match(str(url or "")))


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
    # Check ad SDK paths
    if AD_SDK_RE.search(text):
        return False

    # Check Chinese streaming P2P SDK paths
    if CHINESE_STREAMING_P2P_RE.search(text):
        return False

    # Check video hosting page URLs (block if no video extension)
    if VIDEO_HOSTING_SITES_RE.search(text) and not VIDEO_EXTENSION_RE.search(text):
        return False

    # Check Chinese streaming CDN segment URLs (block segments, allow manifests)
    if CHINESE_STREAMING_CDN_RE.search(text) and (not VIDEO_EXTENSION_RE.search(text) or SEGMENT_RE.search(text)):
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
