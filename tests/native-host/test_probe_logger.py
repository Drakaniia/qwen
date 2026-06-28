"""Tests for DownloadLogger probe event types."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

from download_logger import DownloadLogger

from probe_runner import ProbeError


class TestDownloadLoggerProbeEvents(unittest.TestCase):
    """DownloadLogger must support PROBE_START, PROBE_RESULT, PROBE_WIN, PROBE_ALL_FAIL."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w")
        self.tmp.close()
        self.logger = DownloadLogger(log_path=Path(self.tmp.name))

    def tearDown(self):
        Path(self.tmp.name).unlink(missing_ok=True)

    def _read_log(self):
        text = Path(self.tmp.name).read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def test_probe_start_logs_url_and_backend_list(self):
        self.logger.probe_start(url="https://example.com/video", backends=["yt-dlp", "curl_cffi"])
        entries = self._read_log()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "PROBE_START")
        self.assertEqual(entries[0]["url"], "https://example.com/video")
        self.assertEqual(entries[0]["backends"], ["yt-dlp", "curl_cffi"])
        self.assertIn("timestamp", entries[0])

    def test_probe_result_logs_individual_backend_outcome(self):
        self.logger.probe_result(backend="yt-dlp", ok=True, duration_ms=150, error_type=None)
        entries = self._read_log()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "PROBE_RESULT")
        self.assertEqual(entries[0]["backend"], "yt-dlp")
        self.assertTrue(entries[0]["ok"])
        self.assertEqual(entries[0]["durationMs"], 150)
        self.assertIsNone(entries[0].get("errorType"))

    def test_probe_result_logs_failure_with_error_type(self):
        self.logger.probe_result(backend="curl_cffi", ok=False, duration_ms=500, error_type="http_error")
        entries = self._read_log()

        self.assertEqual(entries[0]["event"], "PROBE_RESULT")
        self.assertFalse(entries[0]["ok"])
        self.assertEqual(entries[0]["errorType"], "http_error")

    def test_probe_win_logs_winning_backend(self):
        self.logger.probe_win(backend="yt-dlp", label="yt-dlp (skip-download)")
        entries = self._read_log()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "PROBE_WIN")
        self.assertEqual(entries[0]["backend"], "yt-dlp")
        self.assertEqual(entries[0]["label"], "yt-dlp (skip-download)")

    def test_probe_all_fail_logs_all_errors(self):
        errors = [
            ProbeError(
                backend="yt-dlp",
                label="yt-dlp (skip-download)",
                error_type="exit_code",
                message="Exit code 1",
                status_code=1,
                raw_output="ERROR: HTTP 403",
                duration_ms=200,
            ),
            ProbeError(
                backend="curl_cffi",
                label="curl-cffi (HEAD)",
                error_type="http_error",
                message="HTTP 403",
                status_code=403,
                raw_output="<html>...</html>",
                duration_ms=1200,
            ),
        ]
        self.logger.probe_all_fail(url="https://example.com/video", backends=["yt-dlp", "curl_cffi"], errors=errors)
        entries = self._read_log()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "PROBE_ALL_FAIL")
        self.assertEqual(entries[0]["url"], "https://example.com/video")
        self.assertEqual(entries[0]["backends"], ["yt-dlp", "curl_cffi"])
        self.assertEqual(len(entries[0]["errors"]), 2)
        self.assertEqual(entries[0]["errors"][0]["backend"], "yt-dlp")
        self.assertEqual(entries[0]["errors"][0]["errorType"], "exit_code")
        self.assertEqual(entries[0]["errors"][1]["backend"], "curl_cffi")
        self.assertEqual(entries[0]["errors"][1]["errorType"], "http_error")


if __name__ == "__main__":
    unittest.main()
