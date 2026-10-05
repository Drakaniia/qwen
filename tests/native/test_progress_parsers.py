"""The parsers, the reader, the throttle and the log collapse.

Assert-based, no fixtures, no monkeypatching, no subprocess, no network: every
input is an inline sample line and every assertion reads a plain dict or list.

The regression half matters most. `progress_parser.py` used to be one function
containing both backends' branches; it is now a dispatcher over
`download/parsers/` (spec D11), so "the aria2 branch moved verbatim" is only true
if these shapes still produce the same dicts. `test_host_imports.py` is the guard
for the other half -- that the new package did not leave the host unimportable.
"""

import io
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

import output_reader  # noqa: E402
from aria2 import parse_aria2_fragment_activity  # noqa: E402
from parsers import parse_line  # noqa: E402

from download_task import DownloadTask, ProgressThrottle, StageLogCollapser  # noqa: E402
from progress_parser import is_cloudflare_challenge, parse_yt_dlp_line  # noqa: E402

# ── regression: the two shapes that worked before the split ────────────────


def test_ytdlp_percent_line_is_unchanged():
    parsed = parse_line("[download]  42.3% of ~1.21GiB at    5.01MiB/s ETA 03:21")
    assert parsed["stage"] == "download"
    assert parsed["percent"] == 42.3
    assert parsed["totalSize"] == "1.21GiB"
    assert parsed["speed"] == "5.01MiB/s"
    assert parsed["eta"] == "03:21"
    assert parsed["line"] == "[download]  42.3% of ~1.21GiB at    5.01MiB/s ETA 03:21"


def test_aria2_progress_line_is_unchanged():
    line = "[#208f7e 12.34MiB/1.21GiB(1%) CN:8 DL:5.01MiB ETA:3m20s]"
    parsed = parse_line(line)
    assert parsed["stage"] == "download"
    assert parsed["percent"] == 1.0
    assert parsed["downloadedSize"] == "12.34MiB"
    assert parsed["totalSize"] == "1.21GiB"
    assert parsed["connections"] == 8
    assert parsed["speed"] == "5.01MiB/s"
    assert parsed["eta"] == "3m20s"


def test_aria2_multi_row_line_reports_active_fragments():
    """aria2 repaints one row per download, so several `[#` rows land on one line."""
    parsed = parse_aria2_fragment_activity("[#a1 1/2(50%)][#b2 2/4(50%)]")
    assert parsed["stage"] == "download"
    assert parsed["fragment"] == "2 active"


def test_filepath_marker_branch_is_unchanged():
    parsed = parse_line("__QWIN_FILEPATH__:C:\\Users\\q\\Downloads\\video.mp4")
    assert parsed["stage"] == "filepath"
    assert parsed["filepath"] == "C:\\Users\\q\\Downloads\\video.mp4"
    assert parsed["artifactRoot"] == "C:\\Users\\q\\Downloads"


def test_download_destination_branch_is_unchanged():
    parsed = parse_line("[download] Destination: C:\\Users\\q\\Downloads\\video.mp4")
    assert parsed["stage"] == "destination"
    assert parsed["filepath"] == "C:\\Users\\q\\Downloads\\video.mp4"
    assert parsed["artifactRoot"] == "C:\\Users\\q\\Downloads"


def test_unrecognised_line_is_still_a_log_line():
    line = "[info] Downloading webpage"
    assert parse_line(line) == {"stage": "log", "line": line}


def test_back_compat_entry_point_dispatches():
    """`parse_yt_dlp_line` is still the single-argument dispatcher entry point."""
    assert parse_yt_dlp_line("[download]  42.3% of ~1.21GiB at 5.01MiB/s ETA 03:21")["percent"] == 42.3


# ── fragment counting (spec §3.4, D10) ────────────────────────────────────


def test_fragments_latch_total_then_drive_an_approximate_percent():
    state = {}
    latch = parse_line("[hlsnative] Total fragments: 500", state=state)
    assert latch["stage"] == "extract"
    assert latch["fragment"] == "0/500"
    assert state["fragmentTotal"] == 500

    # The percent is the fragment counter, not the byte estimate on the line --
    # yt-dlp sizes the estimate from the same counter (fragment.py's
    # `estimated_size`), and segments are not equal-sized (D2).
    first = parse_line("[download]   9.9% of ~12.00MiB at 1.00MiB/s ETA 20:00 (frag 12/500)", state=state)
    assert first["percent"] == 2.4
    assert first["percentApproximate"] is True
    assert first["fragment"] == "12/500"
    assert state["fragmentDone"] == 12

    second = parse_line("[download]   9.9% of ~12.00MiB at 1.00MiB/s ETA 10:00 (frag 250/500)", state=state)
    assert second["percent"] == 50.0
    assert second["fragment"] == "250/500"


def test_fragment_denominator_resets_once_it_is_reached():
    """A re-attempt sharing this state must not count into the old total."""
    state = {}
    parse_line("[hlsnative] Total fragments: 4", state=state)
    done = parse_line("[download]  25.0% of ~1MiB at 1MiB/s ETA 00:04 (frag 4/4)", state=state)
    assert done["percent"] == 100.0
    assert "fragmentTotal" not in state
    assert "fragmentDone" not in state


def test_fragment_count_without_a_latched_total_does_not_crash():
    assert parse_line("[download]  1.0% of ~1MiB at 1MiB/s ETA 00:10")["percent"] == 1.0


# ── buffered reader (spec D13) ────────────────────────────────────────────


class _Read1Stream:
    """Stands in for `Popen(text=True).stdout`: `read1`, never `read`."""

    def __init__(self, text):
        self._io = io.StringIO(text)

    def read1(self, _size):
        return self._io.read(3)

    def read(self, _size):
        raise AssertionError("the reader must prefer read1: read(n) blocks for exactly n chars")


def test_reader_yields_the_same_strings_as_the_old_read_one_loop():
    raw = "one\r\ntwo\n\rthree\n\n\nfour"
    assert list(output_reader.iter_process_output_lines(_Read1Stream(raw))) == ["one", "two", "three", "four"]


def test_reader_flushes_a_trailing_partial_line():
    assert list(output_reader.iter_process_output_lines(io.StringIO("tail"))) == ["tail"]


# ── throttle (spec §5.1) ───────────────────────────────────────────────────


def test_only_repeated_frames_of_one_stage_are_deferred():
    now = [0.0]
    throttle = ProgressThrottle(clock=lambda: now[0])

    assert throttle.allow({"type": "progress", "stage": "download", "line": "a"})
    assert not throttle.allow({"type": "progress", "stage": "download", "line": "b"})
    # A new stage must land the instant it starts.
    assert throttle.allow({"type": "progress", "stage": "postprocess", "line": "c"})
    now[0] = 0.25
    assert throttle.allow({"type": "progress", "stage": "postprocess", "line": "d"})


def test_state_changing_messages_are_never_deferred():
    now = [0.0]
    throttle = ProgressThrottle(clock=lambda: now[0])
    throttle.allow({"type": "progress", "stage": "download", "line": "a"})

    unthrottled = [
        {"type": "started"},
        {"type": "done"},
        {"type": "error"},
        {"type": "canceled"},
        {"type": "paused"},
        {"type": "resumed"},
        {"type": "control"},
        {"type": "progress", "stage": "download", "filepath": "C:/out/v.mp4"},
        {"type": "progress", "stage": "download", "artifactRoot": "C:/out"},
    ]
    deferred = [message for message in unthrottled if not throttle.allow(message)]
    assert deferred == []


# ── log collapse (spec §5.3, D8) ──────────────────────────────────────────


class _RecordingLogger:
    def __init__(self):
        self.lines = []

    def attempt_line(self, download_id, line):
        self.lines.append((download_id, line))


def _task():
    task = DownloadTask(
        message={"id": "job1"},
        command=["yt-dlp", "https://x/v"],
        download_dir="C:/downloads",
        send=lambda message: None,
        logger=_RecordingLogger(),
    )
    task.throttle = ProgressThrottle(clock=lambda: 0.0)  # frozen: only bypasses send
    task.stage_log = StageLogCollapser(lambda line: task.logger.attempt_line(task.id, line))
    return task


LINES = [
    "[hlsnative] Total fragments: 4",
    "[hlsnative] resolving manifest",
    "[hlsnative] 4 fragments, 4 ad",
    "[download]   1.0% of ~1MiB at 1MiB/s ETA 00:10",
    "[download]   2.0% of ~1MiB at 1MiB/s ETA 00:09",
    "[download]   3.0% of ~1MiB at 1MiB/s ETA 00:08",
    "[download] Destination: C:/downloads/video.mp4",
]


def test_progress_frames_never_reach_the_logger():
    task = _task()
    for line in LINES:
        task.handle_output_line(line)
    task.stage_log.flush()

    logged = [line for _id, line in task.logger.lines]
    assert logged == [
        # one transition line per stage...
        LINES[0],
        LINES[2],  # ...and the last line of each stage. No frame in between.
        LINES[3],
        LINES[5],
        LINES[6],
    ]
    assert all(line not in logged for line in (LINES[1], LINES[4]))


def test_recent_lines_still_holds_the_full_tail():
    task = _task()
    for line in LINES:
        task.handle_output_line(line)

    assert list(task.recent_lines) == LINES
    assert task.current_path == "C:/downloads/video.mp4"


def test_frozen_clock_still_sends_one_frame_per_stage():
    """With nothing but stage transitions and path-bearing lines getting through,
    the bar still moves -- the throttle must not swallow a whole stage."""
    sent = []
    task = _task()
    task.send = sent.append
    for line in LINES:
        task.handle_output_line(line)

    assert [message["stage"] for message in sent] == ["extract", "download", "destination"]


# ── Cloudflare challenge detection ─────────────────────────────────────────────
#
# This function guards every completed download: yt-dlp and aria2c can both report
# success while having actually written a Cloudflare interstitial instead of video
# (see its callers in probe/probe_backends.py and download/download_task.py). Its
# only test used to be an `if __name__ == __main__` assert block, which never
# runs under import -- and which asserted against a 74-byte sample while the
# function's own first guard rejects anything under 100 bytes, so it would have
# failed the moment it was ever wired up. The size floor is the subtle part, so it
# is pinned here rather than left to a comment.

_CHALLENGE_PAGE = (
    b'<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>'
    b'<body><div id=cf-challenge>Checking your browser before accessing</div>'
    b'<script src=/cdn-cgi/challenge-platform/h/b/orchestrate></script>'
    b'<p>Please enable JavaScript and cookies to continue.</p></body></html>'
)
_VIDEO_HEADER = bytes([0, 0, 0, 32]) + b"ftypisom" + bytes(512)


def test_cloudflare_challenge_page_is_detected():
    assert is_cloudflare_challenge(_CHALLENGE_PAGE) is True


def test_real_video_bytes_are_not_flagged_as_a_challenge():
    assert is_cloudflare_challenge(_VIDEO_HEADER) is False


def test_a_short_html_fragment_is_below_the_size_floor():
    # The exact sample the old __main__ block asserted on. It is a genuine
    # Cloudflare title but only 74 bytes, and the function refuses anything under
    # 100 -- so the old assert could only ever have failed.
    short = b'<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>'
    assert len(short) < 100
    assert is_cloudflare_challenge(short) is False
