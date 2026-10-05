"""Tests for the host-side thumbnail grab (hls-thumbnail-spec §4).

The wire contract under test is mostly about what is *not* an error: a stream
ffmpeg cannot decode has to come back as `{"ok": True, "frameUrl": ""}` (H10),
because the extension's row already shows a format glyph and has nowhere to put
an error. Only "the host cannot do this at all" — no ffmpeg binary, a URL ffmpeg
could never open — raises.

The command shape is asserted too, because two of its details are load-bearing:
`-ss` before `-i` (input seek: fast, and a live edge still yields a frame) and
`scale=160:-2` (must match LONGEST_EDGE_PX in content/frame_capture.ts so the
row does not change size when a host frame replaces an in-page capture).
"""

import base64
import subprocess
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

import thumbnail_frame  # noqa: E402
from native_protocol import HostError  # noqa: E402

JPEG_BYTES = b"\xff\xd8\xff\xe0not-really-a-jpeg\xff\xd9"

REQUEST_HEADERS = [
    {"name": "Referer", "value": "https://example.com/watch"},
    {"name": "User-Agent", "value": "Mozilla/5.0"},
    # Dropped by clean_request_headers — not in NATIVE_HEADER_NAMES.
    {"name": "X-Not-Forwarded", "value": "nope"},
]

MANIFEST = "https://cdn.example.com/hls/master.m3u8"


class _Completed:
    def __init__(self, returncode=0):
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


@pytest.fixture
def grab(monkeypatch):
    """Run the handler with ffmpeg stubbed out; record the argv and every sent message."""
    calls = []
    sent = []

    def _run(command, **_kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(JPEG_BYTES)
        return _Completed(0)

    monkeypatch.setattr(thumbnail_frame.subprocess, "run", _run)
    monkeypatch.setattr(thumbnail_frame, "ffmpeg_location_resolver", lambda: "ffmpeg", raising=False)

    def _send(message):
        sent.append(message)

    return calls, sent, _send


def _call(send, **overrides):
    message = {"id": "thumb_1", "url": MANIFEST, "pageUrl": "https://example.com/watch", "atSeconds": 1}
    message.update(overrides)
    thumbnail_frame.run_thumbnail_frame(
        message,
        send=send,
        ffmpeg_location_resolver=lambda: "ffmpeg",
    )


def test_seek_is_an_input_seek(grab):
    """-ss before -i is input seek. Output seek (-ss after -i) decodes from the
    start, which is minutes of dead time on a long stream, and reads nothing on a
    live edge."""
    calls, _sent, send = grab

    _call(send)

    command = calls[0]
    assert command.index("-ss") < command.index("-i"), f"-ss must precede -i: {command}"
    assert command[command.index("-ss") + 1] == "1"


def test_command_grabs_a_single_160px_frame(grab):
    calls, _sent, send = grab

    _call(send)

    command = calls[0]
    assert command[0] == "ffmpeg"
    assert "-frames:v" in command and command[command.index("-frames:v") + 1] == "1"
    assert "-vf" in command and command[command.index("-vf") + 1] == "scale=160:-2"
    assert "-q:v" in command and command[command.index("-q:v") + 1] == "6"
    assert "-y" in command
    assert command[-1].endswith(".jpg")


def test_headers_become_one_crlf_joined_argument(grab):
    """§4.1: requestHeaders are load-bearing — a Referer-less request 403s on a
    large share of HLS CDNs, and the grab then always fails."""
    calls, _sent, send = grab

    _call(send, requestHeaders=REQUEST_HEADERS)

    command = calls[0]
    assert command.count("-headers") == 1
    joined = command[command.index("-headers") + 1]
    assert joined == "Referer: https://example.com/watch\r\nUser-Agent: Mozilla/5.0"


def test_no_headers_argument_when_none_are_sent(grab):
    calls, _sent, send = grab

    _call(send)

    assert "-headers" not in calls[0]


def test_non_zero_exit_is_not_an_error(grab, monkeypatch):
    """H10: ffmpeg ran and produced nothing. The row keeps its glyph."""
    monkeypatch.setattr(
        thumbnail_frame.subprocess,
        "run",
        lambda command, **_kwargs: _Completed(1),
    )
    sent = []

    _call(sent.append)  # must not raise

    assert sent[0] == {"type": "thumbnailFrame", "id": "thumb_1", "ok": True, "frameUrl": ""}


def test_timeout_is_not_an_error(grab, monkeypatch):
    def _timeout(command, **_kwargs):
        raise subprocess.TimeoutExpired(command, 20)

    monkeypatch.setattr(thumbnail_frame.subprocess, "run", _timeout)
    sent = []

    _call(sent.append)  # must not raise

    assert sent[0]["frameUrl"] == ""
    assert sent[0]["ok"] is True


def test_success_returns_a_base64_jpeg_data_url(grab):
    _calls, sent, send = grab

    _call(send)

    payload = sent[0]["frameUrl"].removeprefix("data:image/jpeg;base64,")
    assert base64.b64decode(payload) == JPEG_BYTES


def test_temp_file_is_deleted_on_success(grab):
    calls, _sent, send = grab

    _call(send)

    assert not Path(calls[0][-1]).exists()


def test_temp_file_is_deleted_on_failure(grab, monkeypatch):
    calls = []

    def _run(command, **_kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(JPEG_BYTES)
        return _Completed(1)

    monkeypatch.setattr(thumbnail_frame.subprocess, "run", _run)

    _call(lambda _message: None)

    assert not Path(calls[0][-1]).exists()


def test_missing_ffmpeg_binary_raises_host_error(grab):
    """The one failure that is not H10: there is no ffmpeg, so the extension has
    nothing to fall back to and should stop asking."""
    _calls, _sent, send = grab

    def _resolver():
        raise HostError("ffmpeg is not installed. Run scripts/install.sh, then restart your browser.")

    with pytest.raises(HostError):
        thumbnail_frame.run_thumbnail_frame(
            {"id": "thumb_2", "url": MANIFEST}, send=send, ffmpeg_location_resolver=_resolver
        )


def test_empty_url_raises_host_error(grab):
    _calls, sent, send = grab

    with pytest.raises(HostError):
        thumbnail_frame.run_thumbnail_frame(
            {"id": "thumb_3", "url": ""}, send=send, ffmpeg_location_resolver=lambda: "ffmpeg"
        )

    assert sent == [], "an invalid URL must not produce a reply"


def test_relative_manifest_is_resolved_against_page_url(grab):
    """§4.1: pageUrl "lets the host resolve a relative manifest"."""
    calls, _sent, send = grab

    _call(send, url="/hls/master.m3u8", pageUrl="https://example.com/media/page.html")

    command = calls[0]
    assert command[command.index("-i") + 1] == "https://example.com/hls/master.m3u8"


def test_absolute_url_is_left_alone(grab):
    calls, _sent, send = grab

    _call(send)

    command = calls[0]
    assert command[command.index("-i") + 1] == MANIFEST
