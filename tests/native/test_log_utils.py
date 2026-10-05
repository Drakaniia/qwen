"""Guards for the src/logs cleanup: progress-noise filtering, log rotation,
probe/download join keys, and error attempt linkage.

`downloads.jsonl` was 21 KB for 32 lines — almost entirely yt-dlp
`[download] …KiB at …` progress spam duplicated across ATTEMPT_END.output
and DOWNLOAD_ERROR.error — and probe events carried no downloadId, so a
probe round could not be tied to the download that used it.
"""

import json
import sys
from pathlib import Path

_REPOS_ROOT = Path(__file__).resolve().parents[2]
_NATIVE_HOST = _REPOS_ROOT / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

import log_utils  # noqa: E402
from download_logger import DownloadLogger  # noqa: E402


def _entries(log_path):
    return [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_progress_lines_are_noise():
    assert log_utils.is_noise_line("[download]    2.64KiB at  564.81KiB/s (00:00:00)")
    assert log_utils.is_noise_line("[download] 100% of    2.64KiB in 00:00:00 at 4.62KiB/s")
    assert log_utils.is_noise_line("frame=   12 fps=0.0 q=-0.0 size=      10KiB time=00:00:00.5")


def test_errors_diag_and_status_are_kept():
    assert not log_utils.is_noise_line("ERROR: Unable to download video subtitles: HTTP Error 429")
    assert not log_utils.is_noise_line("[DIAG] cmd_len=827 cwd_len=25 cmd_args=43 cwd='C:\\DL'")
    assert not log_utils.is_noise_line("Conversion failed!")
    assert not log_utils.is_noise_line("Skipped 3 yt-dlp variants that cannot fix this error: a, b")


def test_clean_tail_drops_noise_but_never_empties():
    lines = [
        "[DIAG] cmd_len=10",
        "[download]    2.64KiB at  564.81KiB/s (00:00:00)",
        "[download] 100% of    2.64KiB in 00:00:00",
        "ERROR: HTTP Error 429: Too Many Requests",
    ]
    assert log_utils.clean_tail(lines) == ["[DIAG] cmd_len=10", "ERROR: HTTP Error 429: Too Many Requests"]
    # All-noise tail keeps the last line rather than logging nothing.
    assert log_utils.clean_tail(["[download] 100% of 1KiB"]) == ["[download] 100% of 1KiB"]
    assert log_utils.clean_tail([]) == []


def test_attempt_end_failure_tail_has_no_progress_spam(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.init(download_id="job-1", url="https://x.com/v")
    logger.attempt_start(download_id="job-1", attempt_num=9, label="yt-dlp", command=["yt-dlp"])
    logger.attempt_line("job-1", "[DIAG] cmd_len=827 cwd_len=25 cmd_args=43 cwd='C:\\DL'")
    recent = [
        "[download]    2.64KiB at  564.81KiB/s (00:00:00)",
        "[download] 100% of    2.64KiB in 00:00:00 at 4.62KiB/s",
        "ERROR: Unable to download video subtitles: HTTP Error 429: Too Many Requests",
    ]
    logger.attempt_end(download_id="job-1", attempt_num=9, exit_code=1, recent_lines=recent)
    entry = _entries(log_path)[-1]
    assert "[download]" not in entry["output"]
    assert "HTTP Error 429" in entry["output"]
    assert "[DIAG]" in entry["output"]


def test_error_carries_attempt_number(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.init(download_id="job-1", url="https://x.com/v")
    logger.error(download_id="job-1", error_text="HTTP Error 429", duration_seconds=1.0, attempt_number=9)
    entry = _entries(log_path)[-1]
    assert entry["attemptNumber"] == 9


def test_probe_events_carry_download_id(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.probe_start(url="https://x.com/m.m3u8", backends=["a"], download_id="job-1")
    logger.probe_result(backend="a", ok=True, duration_ms=5, download_id="job-1")
    logger.probe_win(backend="a", label="A", download_id="job-1")
    entries = _entries(log_path)
    assert [e["downloadId"] for e in entries] == ["job-1"] * 3


def test_probe_all_fail_carries_download_id(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.probe_all_fail(url="https://x.com/m.m3u8", backends=[], errors=[], download_id="job-1")
    assert _entries(log_path)[-1]["downloadId"] == "job-1"


def test_rotation_caps_file_size(tmp_path, monkeypatch):
    monkeypatch.setattr(log_utils, "_MAX_LOG_BYTES", 500)
    monkeypatch.setattr(log_utils, "_KEEP_LINES", 50)
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    for i in range(200):
        logger._write({"event": "X", "downloadId": "job-1", "n": i})
    size = log_path.stat().st_size
    assert size < 500 + 200  # one entry of slack after the last rotate
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) <= 51
    assert json.loads(lines[-1])["n"] == 199


def test_log_path_resolves_to_src_logs():
    path = log_utils.resolve_log_path("downloads.jsonl")
    assert path.parent.name == "logs"
    assert path.parent.parent.name == "src"
    assert path.name == "downloads.jsonl"
