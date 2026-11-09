"""Tests for the byte-level media probe (`probeMediaUrls`).

This module exists so the extension has a way to classify a URL that matches none of its
pattern tables. Two properties matter and are the point of the file:

  1. **Content-Type is server truth and wins.** A `video/mp4` answer costs one HEAD and
     settles the question without reading a byte.
  2. **Bytes decide when the header says nothing.** `application/octet-stream` — the most
     common shape for a stream URL with no extension — is answered by the same 512-byte
     peek yt-dlp's GenericIE performs.

Everything that goes wrong (a HEAD that hangs, a server that ignores `Range`, a 403) has
to collapse into that URL being `"unknown"` rather than raising: the caller is already
reporting a failed enumeration and has nowhere to put a second error.
"""

import sys
from pathlib import Path

_NATIVE_HOST = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

import media_probe  # noqa: E402

# (first bytes, expected kind). Each is a real container header.
MAGIC_CASES = [
    (b"#EXTM3U\n#EXT-X-VERSION:3\n", "hls"),
    (b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00", "mp4"),
    (b"\x00\x00\x00\x1cstypmsdh\x00\x00\x00\x00", "mp4"),
    (b"\x1a\x45\xdf\xa3\x01\x00\x00\x00", "webm"),
    (b"OggS\x00\x02\x00\x00", "ogv"),
    (b"FLV\x01\x05\x00\x00\x00\x09", "flv"),
    (b'<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', "dash"),
    (b"ID3\x04\x00\x00\x00\x00\x00\x00", "audio"),
    (b"fLaC\x00\x00\x00\x22", "audio"),
    (b"RIFF\x24\x08\x00\x00WAVEfmt ", "audio"),
    (b"<!DOCTYPE html><html><body>", "page"),
    (b"\n  <html lang=en>", "page"),
    (b"not a media file at all", "unknown"),
    (b"", "unknown"),
]


class _FakeResponse:
    """The slice of `http.client.HTTPResponse` this module touches."""

    def __init__(self, content_type="", payload=b"", status=200):
        self.headers = {"Content-Type": content_type} if content_type else {}
        self.status = status
        self._payload = payload
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        if size is None or size < 0:
            return self._payload
        return self._payload[:size]

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _fake_urlopen(routes):
    """A `urlopen` replacement that answers from `{(url, method): response or Exception}`.

    Records every request as `(url, method, headers, timeout)` so a test can assert how
    many round trips a classification cost and what it asked with.

    `get_method()` rather than `.method`: `urllib` leaves `.method` as `None` on a
    Request built without one, even though it goes out as a GET.
    """
    calls = []
    routes = dict(routes)

    def _open(request, timeout=None):
        method = request.get_method()
        calls.append((request.full_url, method, dict(request.headers), timeout))
        key = (request.full_url, method)
        if key not in routes:
            raise OSError(f"no route for {method} {request.full_url}")
        result = routes[key]
        if isinstance(result, Exception):
            raise result
        return result

    return _open, calls


def _headers_of(call):
    """Request headers, lowercased — `Request.add_header` normalizes the casing."""
    return {str(name).lower(): value for name, value in call[2].items()}


def _probe(urls, routes, request_id="probe_1"):
    sent = []
    _open, calls = _fake_urlopen(routes)
    media_probe.probe_media_urls({"id": request_id, "urls": urls}, send=sent.append, urlopen_fn=_open)
    return sent[0], calls


# ── The classifier ─────────────────────────────────────────────────────────


def test_magic_bytes_name_the_container():
    for payload, expected in MAGIC_CASES:
        assert media_probe.classify_bytes(payload) == expected, payload[:16]


def test_content_type_wins_over_bytes():
    """A `video/mp4` that opens with an `mdat` box is still an mp4 — the header is truth,
    and a partially-read body is not always enough to say so."""
    assert media_probe.classify_probe("video/mp4", b"\x00\x00\x0cmdat\x00\x00") == "mp4"
    assert media_probe.classify_probe("application/vnd.apple.mpegurl", b"nothing") == "hls"
    assert media_probe.classify_probe("application/x-mpegURL", b"") == "hls"
    assert media_probe.classify_probe("application/dash+xml", b"") == "dash"
    assert media_probe.classify_probe("video/x-matroska", b"") == "mkv"
    assert media_probe.classify_probe("video/mp2t", b"") == "ts"
    assert media_probe.classify_probe("video/webm;codecs=vp9", b"") == "webm"
    assert media_probe.classify_probe("audio/mpeg", b"") == "audio"
    assert media_probe.classify_probe("text/html; charset=utf-8", b"") == "page"


def test_opaque_binary_falls_through_to_the_bytes():
    """The case the module was written for: a stream URL with no extension."""
    assert media_probe.classify_probe("application/octet-stream", b"#EXTM3U\n") == "hls"
    assert media_probe.classify_probe("application/octet-stream", b"\x00\x00\x00\x18ftypmp42") == "mp4"
    assert media_probe.classify_probe("", b"\x00\x00\x00\x18ftypmp42") == "mp4"
    assert media_probe.classify_probe("application/octet-stream", b"{}") == "unknown"


# ── URL selection ──────────────────────────────────────────────────────────


def test_probe_urls_drops_unfetchable_schemes_and_dedupes():
    """`blob:` and relative URLs are not errors for the call — the caller handed over a
    candidate list, and only one of its entries being unusable is normal."""
    urls = media_probe.probe_urls(
        [
            "blob:https://site.example/uuid",
            "/relative/manifest",
            "https://cdn.example/a",
            "https://cdn.example/a",
            "https://cdn.example/b#fragment",
        ]
    )
    assert urls == ["https://cdn.example/a", "https://cdn.example/b"]


def test_probe_urls_caps_the_list():
    urls = media_probe.probe_urls([f"https://cdn.example/{i}" for i in range(50)])
    assert len(urls) == media_probe.MAX_PROBE_URLS


def test_probe_urls_tolerates_a_missing_or_wrong_typed_list():
    assert media_probe.probe_urls(None) == []
    assert media_probe.probe_urls("https://cdn.example/a") == []


# ── The handler ────────────────────────────────────────────────────────────


def test_media_content_type_costs_one_request():
    sent, calls = _probe(
        ["https://cdn.example/master"],
        {("https://cdn.example/master", "HEAD"): _FakeResponse("application/vnd.apple.mpegurl")},
    )

    assert sent == {
        "type": "mediaProbes",
        "id": "probe_1",
        "results": [
            {"url": "https://cdn.example/master", "kind": "hls", "contentType": "application/vnd.apple.mpegurl"}
        ],
    }
    assert len(calls) == 1, "a named media type must not need the ranged GET"
    assert calls[0][1] == "HEAD"


def test_opaque_bytes_peek_exactly_512_bytes():
    """The same peek yt-dlp's GenericIE performs, so the two agree about a URL."""
    payload = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 600
    sent, calls = _probe(
        ["https://cdn.example/play"],
        {
            ("https://cdn.example/play", "HEAD"): _FakeResponse("application/octet-stream"),
            ("https://cdn.example/play", "GET"): _FakeResponse("application/octet-stream", payload),
        },
    )

    assert sent["results"][0]["kind"] == "mp4"
    assert len(calls) == 2
    assert _headers_of(calls[1]).get("range") == f"bytes=0-{media_probe.PEEK_BYTES - 1}"


def test_a_failed_head_is_just_an_unknown_url():
    """No reply-side error: the caller is already explaining a failed enumeration."""
    sent, _calls = _probe(["https://cdn.example/gone"], {("https://cdn.example/gone", "HEAD"): OSError("refused")})

    assert sent["results"] == [{"url": "https://cdn.example/gone", "kind": "unknown", "contentType": ""}]


def test_a_page_url_is_reported_as_a_page():
    """Not downloadable, but a real answer — it is what says \"that is the player page,
    not the stream\" rather than leaving the caller to guess."""
    sent, _calls = _probe(
        ["https://player.example/embed/1"],
        {("https://player.example/embed/1", "HEAD"): _FakeResponse("text/html; charset=utf-8")},
    )
    assert sent["results"][0]["kind"] == "page"


def test_results_keep_the_caller_s_order_and_one_record_per_url():
    sent, _calls = _probe(
        ["https://cdn.example/a", "https://cdn.example/b"],
        {
            ("https://cdn.example/a", "HEAD"): _FakeResponse("video/mp4"),
            ("https://cdn.example/b", "HEAD"): OSError("nope"),
        },
    )
    assert [record["url"] for record in sent["results"]] == ["https://cdn.example/a", "https://cdn.example/b"]
    assert [record["kind"] for record in sent["results"]] == ["mp4", "unknown"]


def test_sends_the_captured_referer_with_every_probe():
    """A hotlink-protected CDN answers the request the same way it answered the page's."""
    sent = []
    _open, calls = _fake_urlopen({("https://cdn.example/a", "HEAD"): _FakeResponse("video/mp4")})
    media_probe.probe_media_urls(
        {
            "id": "probe_2",
            "urls": ["https://cdn.example/a"],
            "pageUrl": "https://site.example/watch",
            "userAgent": "Mozilla/5.0",
        },
        send=sent.append,
        urlopen_fn=_open,
    )

    headers = _headers_of(calls[0])
    assert headers.get("referer") == "https://site.example/watch"
    assert headers.get("user-agent") == "Mozilla/5.0"
    assert sent[0]["id"] == "probe_2"
