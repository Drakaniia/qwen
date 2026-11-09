"""Guards for the job_1791188509871… findings: secret redaction, probe auth, attempt tails."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

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

import download_logger  # noqa: E402
import probe_backends  # noqa: E402
from download_logger import DownloadLogger  # noqa: E402


def _entries(log_path):
    return [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_write_redacts_cookies_auth_and_signed_params(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.attempt_start(
        download_id="job-1",
        attempt_num=1,
        label="yt-dlp",
        command=[
            "yt-dlp",
            "--add-header",
            "Cookie: __cf_bm=iA39SECRET",
            "--add-header",
            "Authorization: Bearer TOPSECRET",
            "https://cdn.example/v.m3u8?h=zsHZSECRET&e=1791192085&sig=ABCSECRET",
        ],
    )
    entry = _entries(log_path)[-1]
    blob = json.dumps(entry)
    assert "__cf_bm=iA39SECRET" not in blob
    assert "TOPSECRET" not in blob
    assert "zsHZSECRET" not in blob and "1791192085" not in blob and "ABCSECRET" not in blob
    assert "[REDACTED]" in blob


def test_attempt_end_keeps_failure_tail_and_decodes_crash(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.init(download_id="job-1", url="https://x.com/v")
    logger.attempt_start(download_id="job-1", attempt_num=1, label="ffmpeg", command=["ffmpeg"])
    logger.attempt_end(
        download_id="job-1",
        attempt_num=1,
        exit_code=2812791560,
        recent_lines=["frame= 12", "Conversion failed!"],
    )
    entry = _entries(log_path)[-1]
    assert entry["output"] == "frame= 12\nConversion failed!"
    assert entry["exitCodeSigned"] == 2812791560 - 2**32
    assert entry["exitCodeHex"] == f"0x{2812791560 & 0xFFFFFFFF:08X}"
    assert entry["crashed"] is True


def test_attempt_buffer_survives_past_first_attempt(tmp_path):
    """attempt_end() pops the buffer — without a reset, attempts 2+ log no output."""
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.init(download_id="job-1", url="https://x.com/v")
    logger.attempt_start(download_id="job-1", attempt_num=1, label="a", command=["a"])
    logger.attempt_line("job-1", "first")
    logger.attempt_end(download_id="job-1", attempt_num=1, exit_code=0)
    logger.attempt_start(download_id="job-1", attempt_num=2, label="b", command=["b"])
    logger.attempt_line("job-1", "second")
    logger.attempt_end(download_id="job-1", attempt_num=2, exit_code=1)
    ends = [e for e in _entries(log_path) if e["event"] == "ATTEMPT_END"]
    assert ends[0]["output"] == "first"
    assert ends[1]["output"] == "second"


def test_success_attempt_end_has_no_crash_keys(tmp_path):
    log_path = tmp_path / "t.jsonl"
    logger = DownloadLogger(log_path=log_path)
    logger.init(download_id="job-1", url="https://x.com/v")
    logger.attempt_end(download_id="job-1", attempt_num=1, exit_code=0)
    entry = _entries(log_path)[-1]
    assert "crashed" not in entry and "exitCodeSigned" not in entry


class _Completed:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _capture_argv(fn, **kwargs):
    import threading

    seen = {}
    real_url = kwargs.pop("url", "https://x.com/a.m3u8")
    completed = kwargs.pop("completed")

    def fake_run(command, *_args, **_kw):
        seen["argv"] = list(command)
        return completed

    # The probes run through `run_probe_command` (cancellable Popen), not subprocess.run.
    with patch.object(probe_backends, "run_probe_command", side_effect=fake_run):
        fn(url=real_url, cancel_event=threading.Event(), **kwargs)
    return seen["argv"]


def test_yt_dlp_probe_forwards_cookies_and_headers():
    argv = _capture_argv(
        probe_backends.probe_yt_dlp,
        yt_dlp_command=["yt-dlp"],
        request_headers=[
            {"name": "Cookie", "value": "session=abc"},
            {"name": "Referer", "value": "https://x.com/"},
        ],
        cookies_file="/tmp/qwin-cookies-test.txt",
        user_agent="UnitAgent/1.0",
        completed=_Completed(stdout='{"formats": [{"format_id": "b"}]}'),
    )
    assert "--cookies" in argv and "/tmp/qwin-cookies-test.txt" in argv
    assert any(str(a).startswith("Cookie:") or "session=abc" in str(a) for a in argv) or any(
        "Referer" in str(a) for a in argv
    )
    assert "UnitAgent/1.0" in argv


def test_n_m3u8dl_re_probe_forwards_headers():
    argv = _capture_argv(
        probe_backends.probe_n_m3u8dl_re,
        n_m3u8dl_re_location="N_m3u8DL-RE",
        request_headers=[{"name": "Cookie", "value": "session=abc"}],
        completed=_Completed(),
    )
    assert "-H" in argv
    assert any("session=abc" in str(a) for a in argv)


def test_streamlink_probe_forwards_cookies_and_headers():
    argv = _capture_argv(
        probe_backends.probe_streamlink,
        streamlink_command=["streamlink"],
        request_headers=[{"name": "Referer", "value": "https://x.com/"}],
        cookies_file="/tmp/qwin-cookies-test.txt",
        completed=_Completed(stdout='{"streams": {"best": {}}}'),
    )
    assert "--http-cookies-file" in argv and "/tmp/qwin-cookies-test.txt" in argv
    assert any("Referer" in str(a) for a in argv)


def test_probe_is_killed_by_its_cancel_event():
    """A cancel must stop a running probe now, not after its 30s timeout."""
    import sys
    import threading
    import time

    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    started = time.monotonic()
    completed = probe_backends.run_probe_command(
        [sys.executable, "-c", "import time; time.sleep(30)"], cancel, timeout=30
    )
    assert time.monotonic() - started < 10
    assert completed.returncode == probe_backends.PROBE_CANCELLED_EXIT_CODE


def test_probe_backends_stay_backward_compatible():
    """New probe params are optional — old two-positional-arg calls keep working."""
    import threading

    with patch.object(
        probe_backends,
        "run_probe_command",
        return_value=_Completed(stdout='{"formats": [{"format_id": "b"}]}'),
    ):
        result = probe_backends.probe_yt_dlp("https://x.com/v", threading.Event(), ["yt-dlp"])
    assert result["ok"] is True


def test_gitignore_covers_runtime_logs():
    text = (_REPOS_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "src/logs/" in text


def test_redact_module_importable_without_side_effects():
    assert callable(download_logger._redact_str)
    assert download_logger._redact_str("Cookie: abc h=secret") != "Cookie: abc h=secret"
