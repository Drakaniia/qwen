"""Regression test for the zero-formats bug.

run_format_list() used to run a parallel-probe phase before the real yt-dlp
extraction. That phase discarded its ProbeResult and its only wire effect was
sending `{"type": "progress", ...}` messages stamped with the formats request
id. native_requests.js resolves on the *first* message carrying the request id,
so the extension received a progress message where it expected the response:

    response.formats === undefined  ->  "yt-dlp returned response but no formats found"

These tests assert the wire contract instead: a formats request must emit the
terminal `formats` message first, and that message must carry formats.
"""

import json
import sys
from pathlib import Path

import pytest

_NATIVE_HOST = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

import format_list  # noqa: E402

YOUTUBE_INFO = {
    "id": "PgyggSRHY1o",
    "title": 'HTMX Explained: The "Dumb" HTML Secret Replacing React',
    "webpage_url": "https://www.youtube.com/watch?v=PgyggSRHY1o",
    "formats": [
        # Storyboard: must be filtered out (audio-only).
        {"format_id": "sb0", "height": 180, "vcodec": "none", "protocol": "mhtml"},
        # Audio-only DASH: must be filtered out.
        {"format_id": "251", "height": None, "vcodec": "none", "protocol": "https", "abr": 107.256},
        # HLS: must be filtered out (segmented).
        {"format_id": "hls1", "height": 720, "vcodec": "avc1", "protocol": "m3u8_native"},
        # Valid progressive MP4.
        {
            "format_id": "137",
            "height": 1080,
            "width": 1920,
            "fps": 30,
            "vcodec": "avc1.640028",
            "acodec": "none",
            "ext": "mp4",
            "protocol": "https",
            "tbr": 426.013,
            "filesize": 23600000,
            "format_note": "1080p",
        },
        # Valid lower-quality MP4.
        {
            "format_id": "136",
            "height": 720,
            "width": 1280,
            "fps": 30,
            "vcodec": "avc1.4d401f",
            "acodec": "none",
            "ext": "mp4",
            "protocol": "https",
            "tbr": 110.0,
            "filesize_approx": 9000000,
            "format_note": "720p",
        },
    ],
    "subtitles": {},
    "automatic_captions": {"en": [{"ext": "vtt", "url": "https://example/en.vtt"}]},
}


@pytest.fixture
def sent(monkeypatch):
    """Run run_format_list against a stubbed yt-dlp; collect every sent message."""
    messages = []

    class _Completed:
        returncode = 0
        stdout = json.dumps(YOUTUBE_INFO)
        stderr = ""

    monkeypatch.setattr(format_list.subprocess, "run", lambda *a, **k: _Completed())

    # The resolvers are default *parameters* of run_format_list, bound at definition
    # time, so patching a module attribute would never reach them. Stub them at the
    # call site instead; otherwise the test probes the machine and fails wherever
    # yt-dlp or ffmpeg is not installed (CI).
    def _run(request_id):
        format_list.run_format_list(
            {"id": request_id, "url": "https://www.youtube.com/watch?v=PgyggSRHY1o"},
            send=messages.append,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "ffmpeg",
        )

    return messages, _run


def test_first_message_is_the_formats_response_not_a_progress_update(sent):
    """The bug: native_requests.js resolves on the first id-tagged message."""
    messages, run = sent
    run("formats_1")

    assert messages, "run_format_list sent no message at all"
    first = messages[0]
    assert first["type"] == "formats", (
        f"first message for a formats request was {first['type']!r}, "
        f"not 'formats' -- the client would resolve on it and see no formats"
    )
    assert first["id"] == "formats_1"


def test_response_carries_formats(sent):
    messages, run = sent
    run("formats_2")

    formats = messages[0]["formats"]
    assert len(formats) > 0, "response carried an empty formats list"
    ids = [f["id"] for f in formats]
    # "best" synthetic option plus the two valid progressive MP4s.
    assert "best" in ids
    assert "137" in ids
    assert "136" in ids
    # Audio-only and segmented formats stay filtered out.
    assert "251" not in ids
    assert "sb0" not in ids
    assert "hls1" not in ids


def test_no_progress_messages_share_the_request_id(sent):
    """No message may precede the terminal response on this id."""
    messages, run = sent
    run("formats_3")

    assert [m for m in messages if m["type"] != "formats"] == []


def test_title_and_subtitle_metadata_survive(sent):
    messages, run = sent
    run("formats_4")

    response = messages[0]
    assert "HTMX" in response["title"]
    assert response["hasSubtitles"] is True
    assert response["subtitleLanguages"] == 1
