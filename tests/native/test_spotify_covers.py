"""Per-track cover art for Spotify playlists (the collection's one shared image is not enough).

A collection embed page carries ONE image, so every track normalized from it was stamped
with the playlist's art. The oEmbed endpoint answers per track, which is the only
credential-free source for it.
"""

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

COLLECTION_ART = "https://i.scdn.co/image/collection"
TRACK_ART = {"a": "https://i.scdn.co/image/track-a", "b": "https://i.scdn.co/image/track-b"}


def _collection_track(track_id, art=COLLECTION_ART):
    """One track as `_normalize_collection_track` leaves it: shared art, no `id` key."""
    return meta._normalize_collection_track({"uri": f"spotify:track:{track_id}"}, 0, [art] if art else [])


def test_track_cover_overrides_the_shared_collection_art():
    tracks = [_collection_track("a"), _collection_track("b")]
    meta.apply_track_covers(tracks, fetch=lambda track_id: TRACK_ART[track_id])
    assert [t["thumbnailUrl"] for t in tracks] == [TRACK_ART["a"], TRACK_ART["b"]]
    # The ladder, not just the head: `playlist_helpers.ts:itemArtwork` reads both keys.
    assert [t["thumbnailCandidates"] for t in tracks] == [[TRACK_ART["a"]], [TRACK_ART["b"]]]


def test_failed_lookup_leaves_the_collection_art_as_the_fallback():
    """The fallback contract: a dead lookup must not blank a row that already had art."""
    tracks = [_collection_track("a"), _collection_track("b")]
    meta.apply_track_covers(tracks, fetch=lambda track_id: TRACK_ART[track_id] if track_id == "a" else "")
    assert tracks[0]["thumbnailUrl"] == TRACK_ART["a"]
    assert tracks[1]["thumbnailUrl"] == COLLECTION_ART
    assert tracks[1]["thumbnailCandidates"] == [COLLECTION_ART]


def test_track_without_a_resolvable_id_is_skipped_not_crashed():
    idless = _collection_track("", art="")
    assert idless["url"] == "" and idless["spotifyUrl"] == ""
    meta.apply_track_covers([idless], fetch=lambda track_id: TRACK_ART["a"])
    assert "thumbnailUrl" not in idless
    assert "thumbnailCandidates" not in idless


def test_explicit_id_beats_the_url():
    track = {"id": "a", "url": "https://open.spotify.com/track/b"}
    meta.apply_track_covers([track], fetch=lambda track_id: TRACK_ART[track_id])
    assert track["thumbnailUrl"] == TRACK_ART["a"]


class _OembedResp:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._payload.encode("utf-8")


def test_fetch_track_cover_reads_the_oembed_thumbnail():
    payload = json.dumps({"title": "Never Gonna Give You Up", "thumbnail_url": TRACK_ART["a"]})
    with patch.object(meta.urllib.request, "urlopen", return_value=_OembedResp(payload)) as urlopen:
        assert meta.fetch_track_cover("4cOdK2wGLETKBW3PvgPWqT") == TRACK_ART["a"]
    # The track URL must be percent-encoded into the query, or oEmbed 404s.
    assert "https%3A%2F%2Fopen.spotify.com%2Ftrack%2F4cOdK2wGLETKBW3PvgPWqT" in urlopen.call_args[0][0].full_url


def test_fetch_track_cover_rejects_a_data_url():
    """These keys ride into synced history; a base64 JPEG per row would blow the ~100KB budget."""
    payload = json.dumps({"thumbnail_url": "data:image/jpeg;base64,AAA"})
    with patch.object(meta.urllib.request, "urlopen", return_value=_OembedResp(payload)):
        assert meta.fetch_track_cover("4cOdK2wGLETKBW3PvgPWqT") == ""


def test_fetch_track_cover_swallows_a_network_failure():
    with patch.object(meta.urllib.request, "urlopen", side_effect=OSError("no route to host")):
        assert meta.fetch_track_cover("4cOdK2wGLETKBW3PvgPWqT") == ""


def test_fetch_track_cover_swallows_a_non_json_answer():
    with patch.object(meta.urllib.request, "urlopen", return_value=_OembedResp("<html>captcha</html>")):
        assert meta.fetch_track_cover("4cOdK2wGLETKBW3PvgPWqT") == ""


def test_collection_fetch_routes_tracks_through_the_cover_pass():
    """End of the pipeline: `fetch_spotify_collection_tracks` upgrades the rows itself."""
    entity = {
        "name": "Cover Mix",
        "visualIdentity": {"image": [{"url": COLLECTION_ART}]},
        "trackList": [{"uri": "spotify:track:a", "title": "One", "subtitle": "Band X"}],
    }
    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": {"state": {"data": {"entity": entity}}}}})
        + "</script>"
    )

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return ("<html>" + page + "</html>").encode("utf-8")

    with patch.object(meta.urllib.request, "urlopen", return_value=_Resp()):
        with patch.object(meta, "apply_track_covers") as covers:
            result = meta.fetch_spotify_collection_tracks("cover", "playlist")
    covers.assert_called_once_with(result["tracks"])
    # The collection's own art still rides out for the playlist folder.
    assert result["thumbnail"] == COLLECTION_ART


def test_resolver_exposes_the_collection_thumbnail():
    from spotify_resolver import resolve_spotify_playlist

    fake = {
        "title": "Big",
        "tracks": [{"title": "a"}],
        "totalItems": 300,
        "truncated": True,
        "thumbnail": COLLECTION_ART,
    }
    with patch("spotify_metadata.fetch_spotify_collection_tracks", return_value=fake):
        out = resolve_spotify_playlist("https://open.spotify.com/playlist/big1")
    assert out["playlistThumbnailUrl"] == COLLECTION_ART


def test_resolver_thumbnail_is_empty_without_collection_art():
    from spotify_resolver import resolve_spotify_playlist

    fake = {"title": "Bare", "tracks": [{"title": "a"}], "totalItems": 1, "truncated": False}
    with patch("spotify_metadata.fetch_spotify_collection_tracks", return_value=fake):
        out = resolve_spotify_playlist("https://open.spotify.com/playlist/bare1")
    assert out["playlistThumbnailUrl"] == ""