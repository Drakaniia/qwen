"""Classify URLs by what the server actually sends — no URL patterns.

The extension's last rung before it tells the user a page cannot be downloaded. Every
other detection layer asks what a URL *looks like*: `shared/media_patterns.ts`'s rule
tables, `shared/streaming_patterns.ts`'s ~50 host shapes, the shared block list. Those
tables only ever grow, and a stream from `/opaque/a1b2c3` or `/play?t=<token>` is
invisible to all of them.

This asks the server instead, the way yt-dlp's `GenericIE` does: a `HEAD`, then a
`Range: bytes=0-511` GET, classified by `Content-Type` first and the first 512 bytes
second. `#EXTM3U` is HLS whatever the URL is called; a `ftyp` box at offset 4 is MP4.
No host list, no extension list, no new pattern to maintain.

Called only when native enumeration *and* the detected candidates both came up empty,
capped per call, and handed a pre-filtered URL list — the extension's own block list runs
first, so an ad or infra URL never reaches this module.

There is deliberately no cross-request cache: `background/native_requests.ts` opens one
host process per request and disconnects it, so an in-process cache here would die with
the call that filled it. De-duplication within a call is the whole optimization.
"""

from urllib.parse import urlparse
from urllib.request import Request, urlopen

from registry import register_handler

from media_resolver import request_headers_for_resolver
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message

# One or two HTTP requests per URL, so the cap is what keeps a tab with a hundred
# resource-timing entries from turning a failed enumeration into a slow one.
MAX_PROBE_URLS = 12

# Shorter than the page resolver's 12s: this runs *after* a failed enumeration, already
# on the user's critical path, and a URL that will not answer a HEAD in 8s is not one we
# are going to download from either.
PROBE_TIMEOUT_SECONDS = 8

# The same 512-byte peek yt-dlp's GenericIE performs, so the two agree about a URL.
PEEK_BYTES = 512


def _is_progressive_mp4(head):
    """A size field followed by a known box type — `ftyp`, `moof`, `mdat` and friends."""
    return head[4:8] in {b"ftyp", b"styp", b"moof", b"moov", b"mdat"}


def _is_riff_wave(head):
    return head.startswith(b"RIFF") and head[8:12] == b"WAVE"


def _is_html(head):
    return head.lstrip()[:16].lower().startswith((b"<!doctype html", b"<html"))


# Magic bytes → kind, in test order. A table rather than an if/else chain so a new
# container is one row. Each rule reads at most the first PEEK_BYTES.
MAGIC_RULES = (
    ("hls", lambda head: head.startswith(b"#EXTM3U")),
    ("mp4", _is_progressive_mp4),
    ("webm", lambda head: head.startswith(b"\x1a\x45\xdf\xa3")),
    ("ogv", lambda head: head.startswith(b"OggS")),
    ("flv", lambda head: head.startswith(b"FLV\x01")),
    # Ahead of the HTML rule because an MPD *is* XML: `<MPD` turns up inside a 512-byte
    # peek even when the document opens with a `<?xml` declaration or a BOM.
    ("dash", lambda head: b"<mpd" in head[:PEEK_BYTES].lower()),
    ("audio", lambda head: head.startswith((b"ID3", b"fLaC"))),
    ("audio", _is_riff_wave),
    ("page", _is_html),
)

# `video/<subtype>` → the kind vocabulary the extension's own format labels use.
VIDEO_SUBTYPE_KINDS = {
    "mp4": "mp4",
    "webm": "webm",
    "x-matroska": "mkv",
    "x-flv": "flv",
    "mp2t": "ts",
    "ogg": "ogv",
}


def classify_bytes(payload):
    """The kind a 512-byte peek implies, or `"unknown"` when nothing matches."""
    head = bytes(payload or b"")
    if not head:
        return "unknown"
    for kind, matches in MAGIC_RULES:
        if matches(head):
            return kind
    return "unknown"


def classify_probe(content_type, payload=b""):
    """The kind for a `(Content-Type, first bytes)` pair.

    Content-Type wins whenever it names a media type: it is server truth, and the bytes
    of a body are not always enough on their own. The bytes are the fallback for the
    headers that name nothing — `application/octet-stream`, `text/plain`, or no header
    at all — which is exactly the case this module exists for.
    """
    lowered = str(content_type or "").lower()
    if "mpegurl" in lowered or "m3u8" in lowered:
        return "hls"
    if "dash+xml" in lowered:
        return "dash"
    if "text/html" in lowered or "xhtml" in lowered:
        return "page"
    if lowered.startswith("video/"):
        subtype = lowered.split(";", 1)[0].split("/", 1)[1].strip()
        return VIDEO_SUBTYPE_KINDS.get(subtype, "video")
    if lowered.startswith("audio/"):
        return "audio"
    return classify_bytes(payload)


def _content_type_of(response):
    try:
        return str(response.headers.get("Content-Type") or response.headers.get("content-type") or "")
    except AttributeError:
        return ""


def _head_content_type(url, headers, urlopen_fn):
    request = Request(url, headers=headers, method="HEAD")
    with urlopen_fn(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
        return _content_type_of(response)


def _peek(url, headers, urlopen_fn):
    """`(Content-Type, first PEEK_BYTES)` from a ranged GET.

    A server that ignores `Range` and answers 200 is fine: the read is capped, so the
    cost is one buffer rather than one download.
    """
    peek_headers = dict(headers)
    peek_headers["Range"] = f"bytes=0-{PEEK_BYTES - 1}"
    request = Request(url, headers=peek_headers)
    with urlopen_fn(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
        return _content_type_of(response), response.read(PEEK_BYTES)


def _probe_one(url, headers, urlopen_fn):
    """One result record. Every failure collapses into this URL being unclassifiable."""
    content_type = ""
    try:
        content_type = _head_content_type(url, headers, urlopen_fn)
    except Exception:
        content_type = ""

    kind = classify_probe(content_type)
    if kind != "unknown":
        return {"url": url, "kind": kind, "contentType": content_type}

    try:
        peek_type, payload = _peek(url, headers, urlopen_fn)
    except Exception:
        return {"url": url, "kind": "unknown", "contentType": content_type}

    return {
        "url": url,
        "kind": classify_probe(peek_type or content_type, payload),
        "contentType": peek_type or content_type,
    }


def probe_urls(values):
    """The URLs worth asking about: http(s), de-duplicated, fragment-stripped, capped."""
    urls = []
    seen = set()
    for value in values if isinstance(values, (list, tuple)) else ():
        url = str(value or "").strip()
        if not url or url in seen:
            continue
        try:
            validate_download_url(url)
        except HostError:
            # A `blob:` handle or a relative URL is not an error for the whole call —
            # the caller handed over a candidate list, not one address.
            continue
        if urlparse(url).fragment:
            url = url.split("#", 1)[0]
        seen.add(url)
        urls.append(url)
        if len(urls) >= MAX_PROBE_URLS:
            break
    return urls


@register_handler("probeMediaUrls")
def probe_media_urls(message, send=send_native_message, urlopen_fn=urlopen):
    request_id = str(message.get("id") or message.get("requestId") or "")
    headers = request_headers_for_resolver(message)
    results = [_probe_one(url, headers, urlopen_fn) for url in probe_urls(message.get("urls"))]
    send({"type": "mediaProbes", "id": request_id, "results": results})
