"""YouTube / YouTube Music collection detection + playlist artwork (format_list.enumeratePlaylist).

The `isCollection` flag is the host's only trustworthy answer to "was this really a list?"
(`background/playlist_helpers.ts`), because `--flat-playlist --dump-json` answers an ordinary
video URL with exactly one entry. These tests pin both halves of the signal: a URL shape that
is a list even when yt-dlp's flat entry is mute, and a plain video URL that must stay a video.
"""

import json
import sys
from pathlib import Path

_NH = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_to_path():
    for root, dirs, _ in _NH.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))


_add_to_path()


def _enumerate(url, entries):
    """Drive the yt-dlp branch of run_playlist_enumeration over a canned --dump-json stream."""
    import format_list

    class _Completed:
        returncode = 0
        stdout = "\n".join(json.dumps(e) for e in entries)
        stderr = ""

    messages = []
    original = format_list.subprocess.run
    format_list.subprocess.run = lambda *a, **k: _Completed()
    try:
        format_list.run_playlist_enumeration(
            {"id": "pl_1", "url": url},
            send=messages.append,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "",
        )
    finally:
        format_list.subprocess.run = original
    return messages[0]


def _flat_entry(video_id, **extra):
    return {
        "id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": f"Track {video_id}",
        **extra,
    }


# ── isCollection ──────────────────────────────────────────────────────────────────────────


def test_youtube_music_playlist_url_is_a_collection():
    """The reported bug: a music.youtube.com playlist whose flat entries carry no
    `playlist_title` and where a short/odd playlist shape yields one entry."""
    message = _enumerate(
        "https://music.youtube.com/playlist?list=OLAK5uy_abc123",
        [_flat_entry("aaa", playlist_title="")],
    )
    assert message["isCollection"] is True


def test_youtube_playlist_url_with_watch_list_param_is_a_collection():
    message = _enumerate(
        "https://www.youtube.com/watch?v=aaa&list=PL123",
        [_flat_entry("aaa"), _flat_entry("bbb")],
    )
    assert message["isCollection"] is True


def test_youtube_album_url_is_a_collection():
    message = _enumerate(
        "https://music.youtube.com/playlist?list=OLAK5uy_zzz",
        [_flat_entry("zzz", playlist_title="")],
    )
    assert message["isCollection"] is True


def test_single_item_collection_shaped_url_is_a_collection():
    """A one-track playlist is still a playlist — the count alone cannot say so."""
    message = _enumerate(
        "https://www.youtube.com/playlist?list=PLsingle",
        [_flat_entry("only")],
    )
    assert message["isCollection"] is True


def test_plain_watch_url_is_not_a_collection():
    message = _enumerate(
        "https://www.youtube.com/watch?v=abc",
        [_flat_entry("abc")],
    )
    assert len(message["items"]) == 1
    assert message["isCollection"] is False


def test_non_youtube_url_keeps_the_yt_dlp_only_signal():
    """Other extractors are untouched: count/title only, as before."""
    single = _enumerate("https://example.com/watch?v=abc", [{"id": "abc", "title": "One"}])
    assert single["isCollection"] is False

    titled = _enumerate(
        "https://example.com/list",
        [{"id": "a", "title": "A"}, {"id": "b", "title": "B", "playlist_title": "Mix"}],
    )
    assert titled["isCollection"] is True


# ── URL-shape helper ───────────────────────────────────────────────────────────────────────


def test_collection_url_shapes():
    from yt_dlp_command import is_youtube_collection_url as shaped

    assert shaped("https://www.youtube.com/playlist?list=PL1") is True
    assert shaped("https://music.youtube.com/playlist?list=OLAK5uy_1") is True
    assert shaped("https://music.youtube.com/browse/MPREb_1") is True
    assert shaped("https://music.youtube.com/channel/UC123") is False
    assert shaped("https://music.youtube.com/channel/UC123?list=OLAK5uy_1") is True
    assert shaped("https://www.youtube.com/watch?v=abc") is False
    assert shaped("https://www.youtube.com/watch?v=abc&index=2") is False
    assert shaped("https://example.com/playlist?list=PL1") is False
    assert shaped("") is False
    assert shaped(None) is False


# ── Thumbnails ─────────────────────────────────────────────────────────────────────────────


def test_item_carries_thumbnail_url():
    thumb = "https://i.ytimg.com/vi/abc/hqdefault.jpg"
    message = _enumerate(
        "https://www.youtube.com/playlist?list=PL1",
        [_flat_entry("abc", thumbnail=thumb)],
    )
    item = message["items"][0]
    assert item["thumbnailUrl"] == thumb
    assert item["thumbnailCandidates"] == [thumb]


def test_thumbnail_candidates_are_capped_and_prefer_the_canonical_thumbnail():
    thumbs = [{"url": f"https://i.ytimg.com/vi/abc/{size}.jpg"} for size in ("maxres", "sd", "hq", "mq", "default")]
    message = _enumerate(
        "https://www.youtube.com/playlist?list=PL1",
        [_flat_entry("abc", thumbnail="https://i.ytimg.com/vi/abc/canonical.jpg", thumbnails=thumbs)],
    )
    item = message["items"][0]
    assert item["thumbnailUrl"] == "https://i.ytimg.com/vi/abc/canonical.jpg"
    assert len(item["thumbnailCandidates"]) == 3
    assert item["thumbnailCandidates"][0] == "https://i.ytimg.com/vi/abc/canonical.jpg"


def test_data_url_thumbnails_are_excluded():
    """hls-thumbnail-spec.md §5.2/§11: a base64 blob is copied into synced history, whose
    whole budget is ~100KB. Never emit one."""
    message = _enumerate(
        "https://www.youtube.com/playlist?list=PL1",
        [
            _flat_entry(
                "abc",
                thumbnail="data:image/jpeg;base64,/9j/4AAQSkZJRg==",
                thumbnails=[{"url": "data:image/png;base64,iVBORw0KGgo="}],
            )
        ],
    )
    item = message["items"][0]
    assert item["thumbnailUrl"] == ""
    assert item["thumbnailCandidates"] == []


def test_item_without_thumbnails_still_succeeds():
    message = _enumerate("https://www.youtube.com/playlist?list=PL1", [_flat_entry("abc")])
    item = message["items"][0]
    assert item["thumbnailUrl"] == ""
    assert item["thumbnailCandidates"] == []
