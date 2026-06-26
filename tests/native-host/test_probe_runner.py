"""Tests for probe_runner — parallel reachability probes.

These tests follow the spec in parallel-reachability-spec.md.
"""

import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native-host"))

# These will fail until probe_runner.py is created — that's the RED phase
from probe_runner import (
    ProbeConfig,
    ProbeError,
    ProbeResult,
    probe_curl_cffi,
    probe_n_m3u8dl_re,
    probe_streamlink,
    probe_yt_dlp,
    run_parallel_probes,
)


class TestProbeConfig(unittest.TestCase):
    """ProbeConfig dataclass — simple value object."""

    def test_probe_config_holds_backend_label_probe_fn_and_command(self):
        def dummy_fn(url, cancel_event):
            return {"ok": True}

        config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=dummy_fn,
            command=["yt-dlp", "--version"],
        )

        self.assertEqual(config.backend, "yt-dlp")
        self.assertEqual(config.label, "yt-dlp (skip-download)")
        self.assertIs(config.probe_fn, dummy_fn)
        self.assertEqual(config.command, ["yt-dlp", "--version"])


class TestProbeResult(unittest.TestCase):
    """ProbeResult dataclass — outcome of a parallel probe round."""

    def test_probe_result_holds_winner_command_and_errors(self):
        result = ProbeResult(
            winner="yt-dlp",
            command=["yt-dlp", "--format", "best", "https://example.com/video"],
            label="yt-dlp (skip-download)",
            errors=[],
            duration_ms=1234,
        )

        self.assertEqual(result.winner, "yt-dlp")
        self.assertEqual(result.command, ["yt-dlp", "--format", "best", "https://example.com/video"])
        self.assertEqual(result.label, "yt-dlp (skip-download)")
        self.assertEqual(result.errors, [])
        self.assertEqual(result.duration_ms, 1234)

    def test_probe_result_allows_none_winner_on_all_fail(self):
        error = ProbeError(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            error_type="exit_code",
            message="Exit code 1",
            status_code=1,
            raw_output="ERROR: something went wrong",
            duration_ms=500,
        )
        result = ProbeResult(
            winner=None,
            command=None,
            label=None,
            errors=[error],
            duration_ms=500,
        )

        self.assertIsNone(result.winner)
        self.assertIsNone(result.command)
        self.assertIsNone(result.label)
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(result.errors[0].backend, "yt-dlp")
        self.assertEqual(result.errors[0].error_type, "exit_code")
        self.assertEqual(result.errors[0].raw_output, "ERROR: something went wrong")
        self.assertEqual(result.errors[0].duration_ms, 500)

    def test_probe_result_duration_is_int_milliseconds(self):
        result = ProbeResult(winner=None, command=None, label=None, errors=[], duration_ms=0)
        self.assertIsInstance(result.duration_ms, int)


class TestProbeError(unittest.TestCase):
    """ProbeError dataclass — details of a single failed probe."""

    def test_probe_error_holds_all_failure_details(self):
        error = ProbeError(
            backend="curl_cffi",
            label="curl-cffi (HEAD)",
            error_type="http_error",
            message="HTTP 403 Forbidden",
            status_code=403,
            raw_output="<html>...</html>",
            duration_ms=1200,
        )

        self.assertEqual(error.backend, "curl_cffi")
        self.assertEqual(error.label, "curl-cffi (HEAD)")
        self.assertEqual(error.error_type, "http_error")
        self.assertEqual(error.message, "HTTP 403 Forbidden")
        self.assertEqual(error.status_code, 403)
        self.assertEqual(error.raw_output, "<html>...</html>")
        self.assertEqual(error.duration_ms, 1200)

    def test_probe_error_allows_none_status_code_and_raw_output(self):
        error = ProbeError(
            backend="streamlink",
            label="Streamlink",
            error_type="timeout",
            message="Timed out after 10 seconds",
            status_code=None,
            raw_output=None,
            duration_ms=10000,
        )

        self.assertIsNone(error.status_code)
        self.assertIsNone(error.raw_output)


class TestRunParallelProbes(unittest.TestCase):
    """run_parallel_probes — the main orchestration function."""

    def test_empty_probes_list_returns_all_fail_with_no_errors(self):
        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertIsNone(result.winner)
        self.assertIsNone(result.command)
        self.assertEqual(result.errors, [])

    def test_single_probe_succeeds_returns_winner(self):
        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda url, cancel_event: {
                "ok": True,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": None,
                "message": None,
                "status_code": None,
                "raw_output": None,
                "duration_ms": 100,
            },
            command=["yt-dlp", "--format", "best", "https://example.com/video"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertEqual(result.winner, "yt-dlp")
        self.assertEqual(result.command, ["yt-dlp", "--format", "best", "https://example.com/video"])
        self.assertEqual(result.label, "yt-dlp (skip-download)")
        self.assertEqual(result.errors, [])

    def test_single_probe_fails_returns_all_fail_with_error(self):
        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda url, cancel_event: {
                "ok": False,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": "exit_code",
                "message": "Exit code 1",
                "status_code": 1,
                "raw_output": "ERROR: HTTP 403",
                "duration_ms": 200,
            },
            command=["yt-dlp", "https://example.com/video"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertIsNone(result.winner)
        self.assertIsNone(result.command)
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(result.errors[0].backend, "yt-dlp")
        self.assertEqual(result.errors[0].error_type, "exit_code")
        self.assertEqual(result.errors[0].raw_output, "ERROR: HTTP 403")

    def test_multiple_probes_first_success_wins_others_cancelled(self):
        """When one probe succeeds, the result should be returned immediately."""

        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        other_was_called = [False]

        def slow_probe(url, cancel_event):
            other_was_called[0] = True
            return {
                "ok": False,
                "backend": "slow",
                "label": "slow",
                "error_type": "timeout",
                "message": "Would timeout",
                "status_code": None,
                "raw_output": None,
                "duration_ms": 10000,
            }

        fast_config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda url, cancel_event: {
                "ok": True,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": None,
                "message": None,
                "status_code": None,
                "raw_output": None,
                "duration_ms": 50,
            },
            command=["yt-dlp", "https://example.com/video"],
        )

        slow_config = ProbeConfig(
            backend="slow",
            label="slow backend",
            probe_fn=slow_probe,
            command=["slow", "https://example.com/video"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[fast_config, slow_config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertEqual(result.winner, "yt-dlp")
        # cancel_event should be set so other probes can check it
        self.assertTrue(cancel_event.is_set())

    def test_cancel_event_stops_probes_early(self):
        """If cancel_event is already set, probes should not run."""
        cancel_event = threading.Event()
        cancel_event.set()
        send_messages = []
        logger = MagicMock()

        probe_was_called = [False]

        def check_called(url, cancel_event):
            probe_was_called[0] = True
            return {"ok": True, "backend": "yt-dlp", "label": "yt-dlp"}

        config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=check_called,
            command=["yt-dlp", "https://example.com/video"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertIsNone(result.winner)
        # The probe function should NOT have been called since cancel was already set
        self.assertFalse(probe_was_called[0])

    def test_sends_progress_messages_during_probing(self):
        """During the probe phase, progress messages should be sent with stage='probing'."""
        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda url, cancel_event: {
                "ok": True,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
            },
            command=["yt-dlp", "https://example.com/video"],
        )

        run_parallel_probes(
            url="https://example.com/video",
            probes=[config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        # Should have sent a "probing" progress message
        probing_messages = [m for m in send_messages if isinstance(m, dict) and m.get("stage") == "probing"]
        self.assertGreater(len(probing_messages), 0)


class TestProbeYtDlp(unittest.TestCase):
    """probe_yt_dlp — the yt-dlp skip-download probe."""

    @patch("probe_runner.subprocess.run")
    def test_probe_yt_dlp_success_returns_ok(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"formats": [{"format_id": "best"}]})
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], "yt-dlp")
        self.assertIsNone(result["error_type"])

    @patch("probe_runner.subprocess.run")
    def test_probe_yt_dlp_failure_on_nonzero_exit(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "ERROR: HTTP Error 403: Forbidden"
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["backend"], "yt-dlp")
        self.assertEqual(result["error_type"], "exit_code")
        self.assertIn("HTTP", result.get("raw_output", ""))

    @patch("probe_runner.subprocess.run")
    def test_probe_yt_dlp_failure_on_empty_formats(self, mock_run):
        """yt-dlp exit 0 but empty formats list should be treated as failure."""
        from unittest.mock import MagicMock

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"formats": []})
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "no_formats")

    @patch("probe_runner.subprocess.run")
    def test_probe_yt_dlp_failure_on_invalid_json(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "not valid json"
        mock_result.stderr = ""
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "parse_error")

    @patch("probe_runner.subprocess.run")
    def test_probe_yt_dlp_checks_cancel_event_before_running(self, mock_run):
        cancel_event = threading.Event()
        cancel_event.set()

        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "cancelled")
        mock_run.assert_not_called()


class TestProbeCurlCffi(unittest.TestCase):
    """probe_curl_cffi — the curl_cffi HEAD request probe."""

    @patch("probe_runner.curl_cffi_available", return_value=True)
    @patch("curl_cffi.requests")
    def test_probe_curl_cffi_success_returns_ok(self, mock_curl_requests, mock_available):
        mock_response = MagicMock()
        mock_response.ok = True
        mock_response.status_code = 200
        mock_curl_requests.head.return_value = mock_response

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/media.mp4",
            cancel_event=cancel_event,
            headers={"Referer": "https://example.com"},
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], "curl_cffi")
        self.assertEqual(result["status_code"], 200)

    @patch("probe_runner.curl_cffi_available", return_value=True)
    @patch("curl_cffi.requests")
    def test_probe_curl_cffi_http_error_returns_failure(self, mock_curl_requests, mock_available):
        mock_response = MagicMock()
        mock_response.ok = False
        mock_response.status_code = 403
        mock_curl_requests.head.return_value = mock_response

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/media.mp4",
            cancel_event=cancel_event,
            headers={},
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "http_error")
        self.assertEqual(result["status_code"], 403)

    @patch("probe_runner.curl_cffi_available", return_value=False)
    def test_probe_curl_cffi_fallback_when_curl_cffi_unavailable(self, mock_available):
        """When curl_cffi is not installed, the probe should fall back to urllib."""
        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/media.mp4",
            cancel_event=cancel_event,
            headers={},
        )

        # Should still attempt, just using urllib fallback
        # The test verifies this doesn't crash — it may fail or succeed
        self.assertIn(result["backend"], "curl_cffi")

    def test_probe_curl_cffi_checks_cancel_before_request(self):
        cancel_event = threading.Event()
        cancel_event.set()

        result = probe_curl_cffi(
            url="https://cdn.example.com/media.mp4",
            cancel_event=cancel_event,
            headers={},
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "cancelled")


class TestProbeStreamManifests(unittest.TestCase):
    """Probe functions for stream manifest backends."""

    @patch("probe_runner.subprocess.run")
    def test_probe_n_m3u8dl_re_success_on_parseable_manifest(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "Index: 1\nType: VOD\n"
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_n_m3u8dl_re(
            url="https://cdn.example.com/hls/master.m3u8",
            cancel_event=cancel_event,
            n_m3u8dl_re_location="N_m3u8DL-RE",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], "n_m3u8dl_re")

    @patch("probe_runner.subprocess.run")
    def test_probe_n_m3u8dl_re_failure_on_nonzero_exit(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_n_m3u8dl_re(
            url="https://cdn.example.com/hls/master.m3u8",
            cancel_event=cancel_event,
            n_m3u8dl_re_location="N_m3u8DL-RE",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "exit_code")

    def test_probe_n_m3u8dl_re_checks_cancel_before_running(self):
        cancel_event = threading.Event()
        cancel_event.set()

        result = probe_n_m3u8dl_re(
            url="https://cdn.example.com/hls/master.m3u8",
            cancel_event=cancel_event,
            n_m3u8dl_re_location="N_m3u8DL-RE",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "cancelled")

    @patch("probe_runner.subprocess.run")
    def test_probe_streamlink_success_returns_ok(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"streams": {"best": "https://..."}})
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_streamlink(
            url="https://www.twitch.tv/example",
            cancel_event=cancel_event,
            streamlink_command=["streamlink"],
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], "streamlink")

    @patch("probe_runner.subprocess.run")
    def test_probe_streamlink_failure_on_nonzero_exit(self, mock_run):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "No streams found"
        mock_run.return_value = mock_result

        cancel_event = threading.Event()
        result = probe_streamlink(
            url="https://www.twitch.tv/example",
            cancel_event=cancel_event,
            streamlink_command=["streamlink"],
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "exit_code")

    def test_probe_streamlink_checks_cancel_before_running(self):
        cancel_event = threading.Event()
        cancel_event.set()

        result = probe_streamlink(
            url="https://www.twitch.tv/example",
            cancel_event=cancel_event,
            streamlink_command=["streamlink"],
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "cancelled")


if __name__ == "__main__":
    unittest.main()
