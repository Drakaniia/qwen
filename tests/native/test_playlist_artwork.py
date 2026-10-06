"""Playlist artwork on the native side (`format_list.py`).

`_entry_artwork` is the one place the host decides what a cover *is*, and it now has two
callers: the per-ENTRY artwork every expanded row shows, and — through `_playlist_cover`
— the playlist's OWN cover, which the popup draws on its folder header. `--flat-playlist`
describes entries and carries nothing about the collection, so the folder's art needs a
second probe whose output only makes sense through this same helper.

The rules that matter are the ones that cost money if they regress:

- a `data:` URL never survives. One base64 JPEG per row is copied into synced history,
  whose whole budget is ~100KB (hls-thumbnail-spec.md §5.2/§11).
- the ladder is capped, and `thumbnail` outranks `thumbnails` — the first is yt-dlp's
  canonical answer, the second is its size-ordered fallback list.
- every failure mode of the folder probe is `""`, never an exception: the enumeration it
  decorates has already succeeded by then.

No network and no yt-dlp here — these call the pure helper directly.
"""

import json
import sys
from pathlib import Path

_NATIVE_HOST = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))


_add_native_host_to_path()

import format_list  # noqa: E402
from yt_dlp_command import build_playlist_info_command  # noqa: E402

PLAYLIST_JSON = {
    "id": "PL123",
    "title": "My Mix",
    "thumbnail": "https://i.ytimg.com/vi/cover/hqdefault.jpg",
    "thumbnails": [
        {"url": "https://i.ytimg.com/vi/cover/maxres.jpg"},
        {"url": "https://i.ytimg.com/vi/cover/sd.jpg"},
    ],
}


def _cover(stdout, returncode=0):
    """Drive `_playlist_cover` over a canned yt-dlp answer."""

    class _Completed:
        pass

    completed = _Completed()
    completed.returncode = returncode
    completed.stdout = stdout
    completed.stderr = ""

    original = format_list.subprocess.run
    format_list.subprocess.run = lambda *a, **k: completed
    try:
        return format_list._playlist_cover(["yt-dlp", "https://www.youtube.com/playlist?list=PL123"])
    finally:
        format_list.subprocess.run = original


# ── The playlist's own cover ──────────────────────────────────────────────────────────


def test_playlist_cover_reads_the_playlist_thumbnail():
    assert _cover(json.dumps(PLAYLIST_JSON)) == "https://i.ytimg.com/vi/cover/hqdefault.jpg"


def test_playlist_cover_falls_back_to_the_thumbnails_ladder():
    # A playlist JSON with no `thumbnail` still has `thumbnails`; that is the whole reason
    # the folder probe reuses this helper rather than reading one key.
    without = {"thumbnails": PLAYLIST_JSON["thumbnails"]}
    assert _cover(json.dumps(without)) == "https://i.ytimg.com/vi/cover/maxres.jpg"


def test_playlist_cover_is_empty_when_the_probe_fails():
    """Every failure is `""`: the enumeration already succeeded and must not become an error."""
    assert _cover("ERROR: [youtube] PL123: Private video", returncode=1) == ""
    assert _cover("") == ""  # nothing on stdout at all
    assert _cover("not json") == ""  # unparseable stdout
    assert _cover(json.dumps({"title": "No art here"})) == ""
    assert _cover(json.dumps({"entries": []})) == ""  # a list, not a playlist object


def test_playlist_cover_rejects_a_data_url():
    assert _cover(json.dumps({"thumbnail": "data:image/jpeg;base64,AAA"})) == ""


def test_playlist_probe_asks_for_the_playlist_not_its_entries():
    """`--dump-single-json` is what makes the blob playlist-level; `--flat-playlist` keeps
    it from extracting every track again. Dropping either breaks the probe silently —
    the first answers with one entry per line, the second costs an extraction per item."""
    command = build_playlist_info_command(url="https://www.youtube.com/playlist?list=PL123")
    assert "--dump-single-json" in command
    assert "--flat-playlist" in command
    assert "--skip-download" in command
    assert command[-1] == "https://www.youtube.com/playlist?list=PL123"


def test_the_probe_is_short():
    # Decoration, not enumeration: it must not be able to hold the answer hostage.
    assert format_list.PLAYLIST_ARTWORK_TIMEOUT_SECONDS <= 30


def test_playlist_cover_is_empty_when_the_probe_times_out():
    """A slow cover must never turn a working enumeration into an error."""

    def _timeout(*_args, **_kwargs):
        raise format_list.subprocess.TimeoutExpired(cmd="yt-dlp", timeout=15)

    original = format_list.subprocess.run
    format_list.subprocess.run = _timeout
    try:
        assert format_list._playlist_cover(["yt-dlp"]) == ""
    finally:
        format_list.subprocess.run = original


def test_the_enumeration_message_carries_the_cover():
    """End to end over the yt-dlp branch: flat entries first, then the cover probe."""
    entries = [
        json.dumps({"id": "aaa", "url": "https://youtu.be/aaa", "title": "A", "playlist_title": "Mix"}),
        json.dumps({"id": "bbb", "url": "https://youtu.be/bbb", "title": "B"}),
    ]
    calls = []

    class _Completed:
        def __init__(self, stdout):
            self.returncode = 0
            self.stdout = stdout
            self.stderr = ""

    def _run(command, **_kwargs):
        calls.append(command)
        return _Completed("\n".join(entries) if len(calls) == 1 else json.dumps(PLAYLIST_JSON))

    messages = []
    original = format_list.subprocess.run
    format_list.subprocess.run = _run
    try:
        format_list.run_playlist_enumeration(
            {"id": "pl_1", "url": "https://www.youtube.com/playlist?list=PL123"},
            send=messages.append,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "",
        )
    finally:
        format_list.subprocess.run = original

    message = messages[0]
    assert message["playlistThumbnailUrl"] == "https://i.ytimg.com/vi/cover/hqdefault.jpg"
    # One probe, and it is the playlist-level one: the enumeration is still exactly one call.
    assert len(calls) == 2
    assert "--dump-single-json" in calls[1]
    # The per-row artwork of the two tracks is untouched by any of this.
    assert [item["title"] for item in message["items"]] == ["A", "B"]


def test_a_playlist_with_no_cover_still_enumerates():
    """The cover is decoration: no art anywhere must still produce a complete answer."""

    class _Completed:
        returncode = 0
        stdout = json.dumps({"id": "a", "url": "https://youtu.be/a", "title": "A", "playlist_title": "Mix"})
        stderr = ""

    original = format_list.subprocess.run
    format_list.subprocess.run = lambda *a, **k: _Completed()
    try:
        messages = []
        format_list.run_playlist_enumeration(
            {"id": "pl_2", "url": "https://www.youtube.com/playlist?list=PL123"},
            send=messages.append,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "",
        )
    finally:
        format_list.subprocess.run = original

    assert messages[0]["playlistThumbnailUrl"] == ""
    assert len(messages[0]["items"]) == 1


# ── Per-ENTRY artwork: unchanged, and pinned because the folder shares the helper ──────────


def test_entry_artwork_prefers_thumbnail_then_thumbnails():
    assert format_list._entry_artwork(
        {
            "thumbnail": "https://i.ytimg.com/vi/abc/canonical.jpg",
            "thumbnails": [{"url": "https://i.ytimg.com/vi/abc/maxres.jpg"}],
        }
    ) == ["https://i.ytimg.com/vi/abc/canonical.jpg", "https://i.ytimg.com/vi/abc/maxres.jpg"]


def test_entry_artwork_is_capped():
    thumbs = [{"url": f"https://i.ytimg.com/vi/abc/{size}.jpg"} for size in ("maxres", "sd", "hq", "mq", "default")]
    ladder = format_list._entry_artwork({"thumbnails": thumbs})
    assert ladder == [thumb["url"] for thumb in thumbs[: format_list.MAX_PLAYLIST_THUMBNAILS]]
    assert len(ladder) == 3


def test_entry_artwork_drops_data_urls_and_repeats():
    assert format_list._entry_artwork(
        {
            "thumbnail": "data:image/jpeg;base64,AAA",
            "thumbnails": [
                {"url": "data:image/png;base64,BBB"},
                {"url": "https://i.ytimg.com/vi/abc/hq.jpg"},
                {"url": "https://i.ytimg.com/vi/abc/hq.jpg"},
            ],
        }
    ) == ["https://i.ytimg.com/vi/abc/hq.jpg"]


def test_entry_artwork_is_empty_for_an_entry_with_none():
    assert format_list._entry_artwork({}) == []
    assert format_list._entry_artwork({"thumbnail": None, "thumbnails": None}) == []
