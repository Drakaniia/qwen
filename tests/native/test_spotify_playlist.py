"""Spotify playlist/album expansion (playlist parallel download)."""
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


def test_collection_parse_returns_tracks():
    with patch.object(meta.urllib.request, "urlopen", return_value=_Resp()):
        title, tracks = meta.fetch_spotify_collection_tracks("abc123", "playlist")
    assert title == "My Mix"
    assert [(t["artist"], t["title"]) for t in tracks] == [
        ("Band X", "Song A"),
        ("Singer Y", "Song B"),
    ]


def test_collection_parse_caps_at_limit():
    parts = []
    for i in range(150):
        parts.append('{"name": "T%d", "artists": [{"name": "A%d"}]}' % (i, i))
    many = ",".join(parts)
    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": {'
        '"name": "Big", "tracks": {"items": ['
        + many
        + "]}}}}}}}</script>"
    )

    class _Big(_Resp):
        def read(self):
            return ("<html>" + page + "</html>").encode("utf-8")

    with patch.object(meta.urllib.request, "urlopen", return_value=_Big()):
        _, tracks = meta.fetch_spotify_collection_tracks("big1", "playlist")
    assert len(tracks) == meta.PLAYLIST_ITEM_LIMIT


def test_resolver_rejects_single_track_sentinel():
    import pytest
    from spotify_resolver import resolve_spotify_playlist

    from native_protocol import HostError

    with pytest.raises(HostError, match="__QWIN_SINGLE_TRACK__"):
        resolve_spotify_playlist("https://open.spotify.com/track/abc123")
