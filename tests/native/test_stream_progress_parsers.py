"""Unit tests for the three per-backend progress parsers (real-progress spec §7.1).

Assert-based, no fixtures, no monkeypatching, no subprocess, no network. Each test feeds
inline sample output straight into a module's `parse(line, state)` with a hand-owned state
dict, which is exactly how the dispatcher calls it.

`progress_parser.py` had no tests at all before this file, which is why the three backends
that used to fall through to its final `{"stage": "log"}` return could regress silently.
The last test in here is the guard for that class of bug: garbage in, `log` out, never a
raise.

N_m3u8DL-RE samples are built from the pinned build's own column source
(`0.6.0+df70f0b`, `SimpleDownloadManager.cs:StartDownloadAsync` +
`MyPercentageColumn`/`DownloadStatusColumn`/`DownloadSpeedColumn`), not from a captured
run, so the widths here are the widths the code actually emits.
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_NATIVE_HOST = _REPO_ROOT / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

# Imported directly rather than through the dispatcher: the dispatcher's registry is being
# written alongside this file, and these tests are about the parsers, not the routing.
import ffmpeg  # noqa: E402
import n_m3u8dl_re  # noqa: E402
import streamlink  # noqa: E402

_BAR = "━" * 30

_VID = f"Vid 1920x1080 | 5000 Kbps | 30 | SDR {_BAR} 1234/5678 21.73% 800.00MB/1000.00MB 240.00KBps 00:10:00"
_AUD = f"Aud 128 Kbps | English | 2CH | main {_BAR} 500/520 96.15% 8.00MB/10.00MB 128.00KBps 00:00:02"
_SUB = f"Sub eng | English | stpp | main {_BAR} 30/40 75.00% 0.50MB/0.50MB 8.00KBps 00:00:03"

# `DownloadSpeedColumn.Render` rewrites Value/MaxValue to bytes on the single-file path.
_BYTE_ROW = (
    f"Vid 1920x1080 | 5000 Kbps | 30 | SDR {_BAR} "
    "482344960/1073741824 44.92% 460.00MB/1024.00MB 240.00KBps 00:10:00"
)


def _rows(lines, state=None):
    """Feed every line through the parser and return the last result."""
    state = {} if state is None else state
    result = {"stage": "log", "line": ""}
    for line in lines:
        result = n_m3u8dl_re.parse(line, state)
    return result


# ── N_m3u8DL-RE ───────────────────────────────────────────────────────────────────────


def test_n_m3u8dl_re_combines_rows_by_segment_count_not_by_meaning_the_mean():
    """D4: Σ done / Σ total, so a 40-segment subtitle track cannot out-weigh a 5678-segment video.

    A plain mean of the three per-row percentages is 64.29%. The weighted answer is 28.28%.
    The whole reason D4 exists is that those two numbers are not interchangeable -- the mean
    reports "two thirds done" one frame before the video, which is what a user sees as a
    bar that jumps to 100% and sits there.
    """
    state = {}
    for line in (_VID, _AUD, _SUB):
        n_m3u8dl_re.parse(line, state)

    result = _rows([_SUB], state)
    assert result["stage"] == "download"
    assert result["percent"] == round((1234 + 500 + 30) / (5678 + 520 + 40) * 100, 2)
    assert result["percent"] == 28.28
    plain_mean = (21.73 + 96.15 + 75.00) / 3
    assert abs(result["percent"] - plain_mean) > 10, "D4 weighted percent must not be a mean"


def test_n_m3u8dl_re_sums_sizes_and_speeds_and_takes_the_max_eta():
    """Bytes and speed are concurrent so they add; ETA takes the max, because the job ends
    when the slowest track does. A mean ETA is a number for no moment in the download."""
    result = _rows([_VID, _AUD, _SUB])
    assert result["downloadedSize"] == "808.50MB"  # 800.00 + 8.00 + 0.50
    assert result["totalSize"] == "1010.50MB"  # 1000.00 + 10.00 + 0.50
    assert result["speed"] == "376.00KBps"  # 240 + 128 + 8
    assert result["eta"] == "00:10:00"
    assert result["eta"] != "00:03:21"


def test_n_m3u8dl_re_handles_the_single_file_byte_counter_path():
    """§3.1: Value/MaxValue is a segment counter on the multi-segment path and a byte counter
    on the single-file path. The parser must not assume which -- same arithmetic either way."""
    result = _rows([_BYTE_ROW])
    assert result["stage"] == "download"
    assert result["percent"] == 44.92
    assert result["percent"] == round(482344960 / 1073741824 * 100, 2)
    assert result["downloadedSize"] == "460.00MB"


def test_n_m3u8dl_re_strips_ansi_and_survives_a_surviving_carriage_return():
    """`Program.cs` forces `NoAnsiColor` on redirected stdout, but a build that does not
    auto-detect still leaks SGR codes. And `LiveRenderable.PositionCursor` writes `\\r`
    before each frame, which the reader can leave in the line."""
    ansi = "\x1B[38;2;0;168;255m" + _VID + "\x1B[0m"
    assert n_m3u8dl_re.parse(ansi, {})["percent"] == round(1234 / 5678 * 100, 2)
    assert n_m3u8dl_re.parse("\r" + _AUD, {})["stage"] == "download"


def test_n_m3u8dl_re_parses_the_no_ansi_color_shape_with_no_spinner_column():
    """`--no-ansi-color` drops the SpinnerColumn (SkipLast(1)) and nothing else, so the row is
    one token shorter and still a progress row."""
    no_spinner = f"Vid 1920x1080 | 5000 Kbps | 30 | SDR {_BAR} 1234/5678 21.73% 800.00MB/1000.00MB 240.00KBps 00:10:00"
    assert n_m3u8dl_re.parse(no_spinner, {})["percent"] == round(1234 / 5678 * 100, 2)


def test_n_m3u8dl_re_tolerates_the_idle_and_finished_column_states():
    """`-` for size at zero and for speed when idle, and a single size value once the row is
    finished (`DownloadStatusColumn`: `if (task.IsFinished) sizeStr = FormatFileSize(size)`)."""
    zeroed = f"Vid 1920x1080 | 5000 Kbps | 30 | SDR {_BAR} 0/5678 0.00% - - --:--:--"
    early = n_m3u8dl_re.parse(zeroed, {})
    assert early["stage"] == "download"
    assert early["percent"] == 0.0
    assert "downloadedSize" not in early

    finished = f"Vid 1920x1080 | 5000 Kbps | 30 | SDR {_BAR} 5678/5678 100.00% 1000.00MB - 00:00:00"
    done = n_m3u8dl_re.parse(finished, {})
    assert done["percent"] == 100.0
    assert done["downloadedSize"] == "1000.00MB" == done["totalSize"]


def test_n_m3u8dl_re_maps_the_timestamped_stage_lines():
    """The Logger prefix is `HH:mm:ss.fff`, and INFO/WARN carry a space before the colon
    while DEBUG/ERROR do not -- so the colon must not be anchored to a fixed offset."""
    assert n_m3u8dl_re.parse("14:02:03.114 INFO : Start downloading...", {})["stage"] == "extract"
    assert n_m3u8dl_re.parse("14:02:04.001 INFO : Binary merging...", {})["stage"] == "postprocess"
    assert n_m3u8dl_re.parse("14:02:05.002 INFO : ffmpeg merging...", {})["stage"] == "postprocess"
    partial = n_m3u8dl_re.parse("14:02:06.003 WARN : Segments more than 1800, start partial merge...", {})
    assert partial["stage"] == "postprocess"
    assert n_m3u8dl_re.parse("14:02:07.004 WARN : Muxing to out.MUX.mp4", {})["stage"] == "postprocess"
    assert n_m3u8dl_re.parse("14:02:08.005 WARN : Cleaning files...", {})["stage"] == "postprocess"
    assert n_m3u8dl_re.parse("14:02:09.006 WARN : Rename to out.mp4", {})["stage"] == "postprocess"


def test_n_m3u8dl_re_does_not_claim_a_terminal_state():
    """`Done` is terminal and `run()` owns it; the parser must not emit a terminal message or
    invent a phase for it. `log` is the honest answer -- it is not one of the four stops."""
    done = n_m3u8dl_re.parse("14:02:10.007 INFO : Done", {})
    assert done == {"stage": "log", "line": "14:02:10.007 INFO : Done"}
    failed = n_m3u8dl_re.parse("14:02:11.008 ERROR: Download failed!", {})
    assert failed["stage"] == "log"
    assert "percent" not in failed
    assert "terminal" not in failed


def test_n_m3u8dl_re_log_level_off_yields_log_and_never_a_number():
    """`--log-level OFF` sets `AutoRefresh = false` and produces zero frames. Nothing to parse
    means nothing to claim: the bar goes indeterminate rather than showing a wrong number."""
    state = {}
    for line in ("14:02:03.114 INFO : Start downloading...", "14:02:04.115 INFO : Done"):
        result = n_m3u8dl_re.parse(line, state)
        assert result["stage"] in {"extract", "log"}
        assert "percent" not in result


def test_n_m3u8dl_re_live_record_rows_are_log_not_a_mis_parsed_percent():
    """`SimpleLiveRecordManager2` swaps in RecordingDurationColumn / RecordingStatusColumn /
    Spectre's own PercentageColumn and drops the `━` bar. There is no Value/MaxValue column to
    read, and live record is out of scope -- so these rows must not become a percent."""
    live = "Vid 1920x1080 | 5000 Kbps | 30 | SDR 00m10s/42m00s 30 Recording [███░░░░░░░] 3.57% 8.00KBps ⠋"
    result = n_m3u8dl_re.parse(live, {})
    assert result["stage"] == "log"
    assert "percent" not in result


# ── Streamlink ────────────────────────────────────────────────────────────────────────


def test_streamlink_reads_a_json_progress_object():
    """`--json` output is a JSON object; this one carries an explicit percent."""
    line = '{"type": "progress", "downloaded": 10485760, "total": 52428800, "speed": 1258291.2}'
    result = streamlink.parse(line, {})
    assert result["stage"] == "download"
    assert result["percent"] == 20.0
    assert result["downloadedSize"] == "10.00MB"
    assert result["totalSize"] == "50.00MB"
    assert result["speed"] == "1.20MB"


def test_streamlink_keeps_the_raw_text_tail_for_the_user_facing_error():
    """D5. `--json` rewrites every line, and `download_task.py:353` joins a `deque(maxlen=25)`
    of raw lines into the `HostError` the user reads. Swallowing them here would leave the
    failure blank, so a non-JSON line is forwarded verbatim."""
    raw = "[cli][error] Unable to open URL: https://example.com/live.m3u8 (403)"
    result = streamlink.parse(raw, {})
    assert result == {"stage": "log", "line": raw}


def test_streamlink_stitches_the_multi_line_json_document_and_still_keeps_each_line():
    """`ConsoleOutput.msg_json` serialises with `indent=2`, so one object arrives as several
    lines. Each is still logged (D5), and the closing line carries the progress."""
    state = {}
    lines = [
        "{",
        '  "plugin": "example",',
        '  "downloaded": 5242880,',
        '  "total": 10485760',
        "}",
    ]
    results = [streamlink.parse(line, state) for line in lines]
    assert [r["stage"] for r in results] == ["log", "log", "log", "log", "download"]
    assert [r["line"] for r in results] == lines
    assert results[-1]["percent"] == 50.0
    assert "_BUF" not in state and "json_buffer" not in state


def test_streamlink_marks_the_percent_approximate_unless_the_payload_says_otherwise():
    """A percent off a real Content-Length is exact; one derived from bitrate/duration is not,
    and the payload does not distinguish the two -- so the pessimistic reading is the default."""
    derived = streamlink.parse('{"percent": 42.5}', {})
    assert derived["percentApproximate"] is True
    exact = streamlink.parse('{"percent": 42.5, "approximate": false}', {})
    assert exact["percentApproximate"] is False


def test_streamlink_with_no_progress_object_yields_log_and_no_percent():
    """Verified against streamlink's source: `ConsoleOutput.msg`/`msg_status` return early
    when `--json` is set, and `Progress.update` writes through exactly those. So a stock
    install emits no progress under `--json` at all -- the §3.2 documented guard."""
    for line in ('{"plugin": "twitch", "streams": {"best": {}}}', "[download] Written 1.00 KiB"):
        result = streamlink.parse(line, {})
        assert result["stage"] == "log"
        assert "percent" not in result


# ── ffmpeg ────────────────────────────────────────────────────────────────────────────


def test_ffmpeg_reads_a_progress_block_interleaved_with_normal_stderr():
    """`Popen` merges stderr into stdout, so ordinary ffmpeg chatter shares the line stream.
    Only the block's terminator means the block is worth reporting."""
    state = {"duration": 10.0}
    lines = [
        "  libavutil  58. 29.100 / 58. 29.100",
        "out_time_us=5234512",
        "total_size=5242880",
        "out_time_ms=5234512",
        "speed=1.20x",
        "progress=continue",
        'Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps',
    ]
    results = [ffmpeg.parse(line, state) for line in lines]

    assert results[0]["stage"] == "log" and results[0]["line"] == lines[0]
    assert results[-1]["stage"] == "log" and results[-1]["line"] == lines[-1]

    block = results[5]
    assert block["stage"] == "download"
    assert block["percent"] == 52.35  # 5.234512s / 10s
    assert block["downloadedSize"] == "5.00MB"
    # `total_size` is bytes written *so far*, not a grand total -- mirroring it into
    # `totalSize` rendered "5.0 MB of 5.0 MB" on a bar sitting at 52%.
    assert "totalSize" not in block
    # ffmpeg's own `speed=1.20x` is a ratio, and `formatSpeed` in ui/format.ts only parses
    # a byte rate -- forwarding it produced a field that displayed as nothing. Measured
    # bytes/elapsed is the same quantity in the shape the UI reads: 5242880 / 5.234512.
    assert block["speed"] == "1001599B/s"
    assert block["eta"] == "00:00:04"  # (10 - 5.234512) / 1.001599 MB/s
    assert block["percentApproximate"] is False


def test_ffmpeg_accumulator_resets_between_blocks():
    """Without the reset, block two would re-report block one's keys -- a bar that stalls at
    the first block's percent while bytes keep moving."""
    state = {"duration": 100.0}
    ffmpeg.parse("out_time_us=10000000", state)
    ffmpeg.parse("total_size=10485760", state)
    first = ffmpeg.parse("progress=continue", state)

    ffmpeg.parse("out_time_us=20000000", state)
    second = ffmpeg.parse("progress=end", state)

    assert first["percent"] == 10.0
    assert second["percent"] == 20.0
    assert "downloadedSize" not in second  # no total_size in this block: not carried over
    assert "progress_block" not in state


def test_ffmpeg_never_guesses_a_total_when_duration_is_unknown():
    """§3.3: duration is manifest metadata, not `-progress` output. With it absent there is no
    percent -- but `total_size` is a real byte count, so the size readout still works."""
    state = {}
    ffmpeg.parse("out_time_us=5234512", state)
    ffmpeg.parse("total_size=5242880", state)
    result = ffmpeg.parse("progress=continue", state)

    assert result["stage"] == "download"
    assert "percent" not in result
    assert result["downloadedSize"] == "5.00MB"
    assert "totalSize" not in result
    assert "eta" not in result  # no duration to count down to


def test_ffmpeg_reads_out_time_when_the_numeric_fields_are_absent():
    """`out_time=HH:MM:SS.ffffff` is the unambiguous form, and the only one some builds print."""
    state = {"duration": 20.0}
    ffmpeg.parse("out_time=00:00:12.500000", state)
    result = ffmpeg.parse("progress=continue", state)
    assert result["percent"] == 62.5


def test_ffmpeg_drops_accumulation_lines_from_the_error_tail():
    """`download_task.py:353` filters empty lines out of the user-facing error, and a block is
    five lines per frame -- logging them verbatim would bury the actual ffmpeg error."""
    assert ffmpeg.parse("out_time_us=1234", {})["line"] == ""


# ── the guard ─────────────────────────────────────────────────────────────────────────


def test_garbage_from_any_of_the_three_parsers_is_a_log_line_and_never_a_raise():
    """Three backends used to fall through `progress_parser.py` to its final `log` return.
    That catch-all is the whole contract for a line nobody recognised -- including empty ones,
    which is what a `--log-level OFF` N_m3u8DL-RE run produces in bulk."""
    garbage = [
        "",
        "   ",
        "\r",
        "\x1b[?25l\x1b[2K",
        "not a progress line at all",
        "😀 unicode",
        "0/0",
        "{ broken json",
        "[download] 100%",
        "12/34 56.78%",
        "progress=",
        "=",
        "key=value",
    ]
    for line in garbage:
        for module in (n_m3u8dl_re, streamlink, ffmpeg):
            result = module.parse(line, {})
            assert isinstance(result, dict)
            assert isinstance(result["stage"], str)
            assert isinstance(result["line"], str)
