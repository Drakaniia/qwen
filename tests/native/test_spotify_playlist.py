"""Spotify playlist/album expansion (playlist parallel download)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

_NH = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_to_path():
    for root, dirs, _ in _NH.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))


_add_to_path()

import spotify_metadata as meta  # noqa: E402

NEXT_DATA = (
    '<script id="__NEXT_DATA__" type="application/json">'
    '{"props": {"pageProps": {"state": {"data": {"entity": {'
    '"name": "My Mix", "tracks": {"items": ['
    '{"name": "Song A", "artists": [{"name": "Band X"}]},'
    '{"name": "Song B", "artists": [{"name": "Singer Y"}]}'
    "]}}}}}}}</script>"
)
PAGE = "<html><head>" + NEXT_DATA + "</head><body></body></html>"


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return PAGE.encode("utf-8")


def _collection_page(name, item_count):
    parts = ['{"name": "T%d", "artists": [{"name": "A%d"}]}' % (i, i) for i in range(item_count)]
    return (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": {'
        '"name": "%s", "tracks": {"items": [' % name + ",".join(parts) + "]}}}}}}}</script>"
    )


class _CollectionResp(_Resp):
    def __init__(self, page):
        self._page = page

    def read(self):
        return ("<html>" + self._page + "</html>").encode("utf-8")


def test_collection_parse_returns_tracks():
    with patch.object(meta.urllib.request, "urlopen", return_value=_Resp()):
        result = meta.fetch_spotify_collection_tracks("abc123", "playlist")
    assert result["title"] == "My Mix"
    assert [(t["artist"], t["title"]) for t in result["tracks"]] == [
        ("Band X", "Song A"),
        ("Singer Y", "Song B"),
    ]


def test_collection_parse_caps_at_limit():
    with patch.object(meta.urllib.request, "urlopen", return_value=_CollectionResp(_collection_page("Big", 150))):
        result = meta.fetch_spotify_collection_tracks("big1", "playlist")
    assert len(result["tracks"]) == meta.PLAYLIST_ITEM_LIMIT
    assert result["totalItems"] == 150
    assert result["truncated"] is True


def test_collection_exactly_at_limit_is_not_truncated():
    """The boundary the old `len(tracks) >= LIMIT` got wrong: 100 tracks is all of them."""
    with patch.object(
        meta.urllib.request,
        "urlopen",
        return_value=_CollectionResp(_collection_page("Exact", meta.PLAYLIST_ITEM_LIMIT)),
    ):
        result = meta.fetch_spotify_collection_tracks("exact", "playlist")
    assert len(result["tracks"]) == meta.PLAYLIST_ITEM_LIMIT
    assert result["totalItems"] == meta.PLAYLIST_ITEM_LIMIT
    assert result["truncated"] is False


def test_short_collection_is_not_truncated():
    with patch.object(meta.urllib.request, "urlopen", return_value=_Resp()):
        result = meta.fetch_spotify_collection_tracks("abc123", "playlist")
    assert result["totalItems"] == 2
    assert result["truncated"] is False


def test_resolver_carries_truncation_and_total_through():
    from spotify_resolver import resolve_spotify_playlist

    fake = {"title": "Big", "tracks": [{"name": "a"}], "totalItems": 300, "truncated": True}
    with patch("spotify_metadata.fetch_spotify_collection_tracks", return_value=fake):
        out = resolve_spotify_playlist("https://open.spotify.com/playlist/big1")
    assert out["playlistTitle"] == "Big"
    assert out["totalItems"] == 300
    assert out["truncated"] is True


def test_collection_with_null_artists_does_not_crash():
    """`get(key, default)` does not cover a present-but-null key."""
    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": {'
        '"name": "Nulls", "tracks": {"items": ['
        '{"name": "Song A", "artists": null},'
        '{"name": "Song B"}'
        "]}}}}}}}</script>"
    )
    with patch.object(meta.urllib.request, "urlopen", return_value=_CollectionResp(page)):
        result = meta.fetch_spotify_collection_tracks("nulls", "playlist")
    assert [t["artist"] for t in result["tracks"]] == ["Unknown Artist", "Unknown Artist"]


def test_track_metadata_rejects_non_dict_entity():
    from native_protocol import HostError
    import pytest

    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": ["not", "a", "dict"]}}}}}'
        "</script>"
    )

    class _Bad(_Resp):
        def read(self):
            return ("<html>" + page + "</html>").encode("utf-8")

    with patch.object(meta.urllib.request, "urlopen", return_value=_Bad()):
        with pytest.raises(HostError, match="did not describe a track"):
            meta.fetch_spotify_track_metadata("abc123")


def test_collection_rejects_non_dict_entity():
    from native_protocol import HostError
    import pytest

    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": 7}}}}}'
        "</script>"
    )
    with patch.object(meta.urllib.request, "urlopen", return_value=_CollectionResp(page)):
        with pytest.raises(HostError, match="did not describe a collection"):
            meta.fetch_spotify_collection_tracks("weird", "playlist")


def test_resolver_rejects_single_track_sentinel():
    import pytest
    from spotify_resolver import resolve_spotify_playlist

    from native_protocol import HostError

    with pytest.raises(HostError, match="__QWIN_SINGLE_TRACK__"):
        resolve_spotify_playlist("https://open.spotify.com/track/abc123")


def test_enumerate_playlist_spotify_branch():
    """A Spotify playlist URL must not go near yt-dlp -- it hard-blocks with [DRM]."""
    import format_list

    messages = []
    fake = {
        "playlistTitle": "My Mix",
        "items": [{"title": "Song A", "url": "https://open.spotify.com/track/1"}],
        "totalItems": 1,
        "truncated": False,
    }
    with patch("spotify_resolver.resolve_spotify_playlist", return_value=fake) as mocked:
        format_list.run_playlist_enumeration(
            {"id": "pl_1", "url": "https://open.spotify.com/playlist/abc123"},
            send=messages.append,
        )
    mocked.assert_called_once()
    assert messages[0]["type"] == "playlistItems"
    assert messages[0]["items"][0]["title"] == "Song A"
    # A playlist/album URL is always a real collection, whatever its length.
    assert messages[0]["isCollection"] is True


def _run_generic_enumeration(stdout):
    """Drive the yt-dlp branch of run_playlist_enumeration over a canned --dump-json stream."""
    import format_list

    class _Completed:
        returncode = 0

        def __init__(self, text):
            self.stdout = text
            self.stderr = ""

    messages = []
    original = format_list.subprocess.run
    format_list.subprocess.run = lambda *a, **k: _Completed(stdout)
    try:
        format_list.run_playlist_enumeration(
            {"id": "pl_2", "url": "https://example.com/watch?v=abc"},
            send=messages.append,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "",
        )
    finally:
        format_list.subprocess.run = original
    return messages


def test_collection_parse_reads_track_list_shape():
    """Live shape (2026-10): `entity.trackList` holds `{uri, title, subtitle}`, no `tracks` key."""
    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": {'
        '"name": "Daily Mix", "trackList": ['
        '{"uri": "spotify:track:3ssTtSdEIKuuTC8BV1OaTg", "title": "All of the Stars", "subtitle": "Hayd"},'
        '{"uri": "spotify:track:2luM65sD7j1L4aOyhskNBY", "title": "Windowsill", "subtitle": "Sky McCreery"}'
        "]}}}}}}</script>"
    )
    with patch.object(meta.urllib.request, "urlopen", return_value=_CollectionResp(page)):
        result = meta.fetch_spotify_collection_tracks("mix4", "playlist")
    assert result["title"] == "Daily Mix"
    assert [(t["artist"], t["title"]) for t in result["tracks"]] == [
        ("Hayd", "All of the Stars"),
        ("Sky McCreery", "Windowsill"),
    ]
    assert result["tracks"][0]["url"] == "https://open.spotify.com/track/3ssTtSdEIKuuTC8BV1OaTg"


def test_plain_video_url_is_not_reported_as_a_collection():
    """`--flat-playlist` answers an ordinary video URL with one entry and no playlist
    title. Reporting that as a collection is what cost a plain paste its quality sheet."""
    line = json.dumps({"id": "abc", "url": "https://example.com/watch?v=abc", "title": "One Video"})
    messages = _run_generic_enumeration(line)
    assert len(messages[0]["items"]) == 1
    assert messages[0]["isCollection"] is False


def test_real_playlist_url_is_reported_as_a_collection():
    lines = "\n".join(
        json.dumps({"id": str(i), "url": f"https://example.com/w?v={i}", "playlist_title": "My Mix"}) for i in range(3)
    )
    messages = _run_generic_enumeration(lines)
    assert messages[0]["playlistTitle"] == "My Mix"
    assert messages[0]["isCollection"] is True
