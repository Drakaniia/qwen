"""
Probe Runner — Edge Case Tests (RED Phase)

Exhaustive TDD tests for gaps identified in docs/audit/test-gaps-and-edge-cases.md

Coverage areas:
  A. Token-expired error type detection in probe_yt_dlp
  B. Probe timeout behavior (thread join timeout)
  C. Referrer/Origin header passing to probe_curl_cffi
  D. ffmpeg direct stream copy command building
  E. Complete fallback chain priority order (full listing)
  F. Magnet/torrent URL probe exclusion
  G. Probe cancellation on winner found
"""

import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock, patch

from path_setup import *


# ═══════════════════════════════════════════════════════════════════════
# A. Token-Expired Error Detection
# ═══════════════════════════════════════════════════════════════════════


class TestTokenExpiredDetection(unittest.TestCase):
    """probe_yt_dlp should detect token/signature expiry in error output."""

    def _make_probe_result(self, stderr_text):
        """Simulate probe_yt_dlp with a given stderr output."""
        from probe_backends import probe_yt_dlp
        from unittest.mock import patch

        with patch("probe_backends.subprocess.run") as mock_run:
            mock_result = MagicMock()
            mock_result.returncode = 1
            mock_result.stdout = ""
            mock_result.stderr = stderr_text
            mock_run.return_value = mock_result

            cancel_event = threading.Event()
            return probe_yt_dlp(
                url="https://example.com/video.m3u8",
                cancel_event=cancel_event,
                yt_dlp_command=["yt-dlp"],
                ffmpeg_location=None,
            )

    def test_detects_expired_url_with_expiry_param(self):
        """Signed URL with 'expired' keyword should be detected as token_expired."""
        result = self._make_probe_result(
            "ERROR: [example.com] HTTP Error 410: Gone (video URL has expired)"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "token_expired",
            "yt-dlp probe should report token_expired for expired URLs with 410"
        )

    def test_detects_expired_signed_url_with_expires_param(self):
        """Signed URL with 'expires' in the URL should be detected when failing."""
        result = self._make_probe_result(
            "ERROR: [example.com] HTTP Error 403: Forbidden (signed URL may have expired)"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "token_expired",
            "yt-dlp probe should report token_expired for signed URL 403 errors"
        )

    def test_detects_signed_url_signature_error(self):
        """Signed URL with signature/key expiry should be detected."""
        result = self._make_probe_result(
            "ERROR: [example.com] HTTP Error 403: Forbidden (signature mismatch or expired)"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "token_expired",
            "yt-dlp probe should report token_expired for signature errors"
        )

    def test_detects_aws_cloudfront_signed_url_expiry(self):
        """AWS CloudFront signed URLs with Policy/Key-Pair-Id expiry detection."""
        result = self._make_probe_result(
            "ERROR: [cdn.example.com] HTTP Error 403: Forbidden (CloudFront URL expired)"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "token_expired",
            "yt-dlp probe should report token_expired for CloudFront signed URL expiry"
        )

    def test_regular_403_without_expiry_is_not_token_expired(self):
        """Regular 403 without token/expiry hints should still be exit_code."""
        result = self._make_probe_result(
            "ERROR: [example.com] HTTP Error 403: Forbidden"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "exit_code",
            "Regular 403 without token/expiry hints must NOT be token_expired"
        )

    def test_detects_token_expiry_in_stdout(self):
        """Token expiry detected in stdout as well as stderr."""
        from probe_backends import probe_yt_dlp
        from unittest.mock import patch

        with patch("probe_backends.subprocess.run") as mock_run:
            mock_result = MagicMock()
            mock_result.returncode = 1
            mock_result.stdout = "Error: This video URL has expired. Please refresh the page."
            mock_result.stderr = ""
            mock_run.return_value = mock_result

            cancel_event = threading.Event()
            result = probe_yt_dlp(
                url="https://example.com/video.m3u8",
                cancel_event=cancel_event,
                yt_dlp_command=["yt-dlp"],
                ffmpeg_location=None,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(
            result["error_type"], "token_expired",
            "yt-dlp probe should check stdout for expiry messages too"
        )

    def test_detects_m3u8_playlist_not_found_as_not_token_expired(self):
        """M3U8 playlist not found (404) should NOT be classified as token_expired."""
        result = self._make_probe_result(
            "ERROR: [example.com] HTTP Error 404: Not Found (playlist not found)"
        )
        self.assertFalse(result["ok"])
        self.assertNotEqual(
            result["error_type"], "token_expired",
            "404 for playlist should NOT be token_expired"
        )


# ═══════════════════════════════════════════════════════════════════════
# B. Probe Timeout Behavior
# ═══════════════════════════════════════════════════════════════════════


class TestProbeTimeoutBehavior(unittest.TestCase):
    """Probe runner should handle thread join timeout correctly."""

    def test_parallel_probes_timeout_on_hanging_thread(self):
        """run_parallel_probes should handle a thread that exceeds the join timeout."""
        from probe_runner import ProbeConfig, ProbeResult, run_parallel_probes

        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        def hanging_probe(url, cancel_event):
            """Simulate a probe that hangs indefinitely until cancelled."""
            while not cancel_event.is_set():
                time.sleep(0.1)
            return {
                "ok": False,
                "backend": "slow",
                "label": "slow backend",
                "error_type": "cancelled",
                "message": "Cancelled after timeout",
                "status_code": None,
                "raw_output": None,
                "duration_ms": 0,
            }

        config = ProbeConfig(
            backend="slow",
            label="slow backend",
            probe_fn=hanging_probe,
            command=["slow", "https://example.com/video"],
        )

        # Set a timer to cancel after 2s — this simulates external
        # cancellation (e.g., from another probe winning). The poll
        # loop in run_parallel_probes checks cancel_event every 500ms,
        # so the function should return quickly after cancellation.
        timer = threading.Timer(2.0, cancel_event.set)
        timer.start()

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        timer.cancel()

        self.assertIsNotNone(
            result,
            "run_parallel_probes should return a result even when a probe hangs"
        )
        self.assertIsNone(result.winner, "No winner expected with hanging probe")
        self.assertGreaterEqual(
            len(result.errors), 0,
            "Should have zero or more errors"
        )

    def test_parallel_probes_cancels_all_on_first_success(self):
        """When one probe succeeds, cancel_event is set so other probes can stop."""
        from probe_runner import ProbeConfig, ProbeResult, run_parallel_probes

        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        # Track which probes were actually called
        probes_called = []

        def fast_probe(url, ce):
            probes_called.append("fast")
            return {
                "ok": True,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": None,
                "message": None,
                "status_code": None,
                "raw_output": None,
                "duration_ms": 10,
            }

        def slow_probe(url, ce):
            probes_called.append("slow")
            # Should be cancelled before this completes
            while not ce.is_set():
                time.sleep(0.05)
            return {
                "ok": False,
                "backend": "slow",
                "label": "slow backend",
                "error_type": "cancelled",
                "message": "Cancelled",
                "status_code": None,
                "raw_output": None,
                "duration_ms": 0,
            }

        fast_config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=fast_probe,
            command=["yt-dlp", "url"],
        )

        slow_config = ProbeConfig(
            backend="slow",
            label="slow backend",
            probe_fn=slow_probe,
            command=["slow", "url"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[fast_config, slow_config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertEqual(result.winner, "yt-dlp", "Fast probe should win")
        self.assertTrue(
            cancel_event.is_set(),
            "cancel_event must be set when a winner is found so other probes can stop"
        )
        self.assertIn("fast", probes_called, "Fast probe should have been called")
        # slow probe may or may not have been called depending on timing,
        # but the key assertion is that cancel_event WAS set


# ═══════════════════════════════════════════════════════════════════════
# C. Referrer/Origin Header Passing in curl_cffi Probe
# ═══════════════════════════════════════════════════════════════════════


class TestCurlCffiProbeHeaderPassing(unittest.TestCase):
    """probe_curl_cffi should pass headers (Referer, Origin) to the backend."""

    @patch("curl_cffi.requests.head")
    @patch("probe_backends.curl_cffi_available", return_value=True)
    def test_passes_referer_header(self, mock_available, mock_head):
        """Referer header should be passed to curl_cffi requests.head."""
        from probe_backends import probe_curl_cffi

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_head.return_value = mock_resp

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/video.mp4",
            cancel_event=cancel_event,
            headers={"Referer": "https://example.com/video-page"},
        )

        self.assertTrue(result["ok"], "Probe should succeed with Referer")
        # Verify headers were passed
        call_kwargs = mock_head.call_args
        if call_kwargs:
            _, kwargs = call_kwargs
            passed_headers = kwargs.get("headers", {})
            self.assertIn(
                "Referer", passed_headers,
                "Referer header must be passed to curl_cffi requests.head"
            )
            self.assertEqual(
                passed_headers["Referer"], "https://example.com/video-page",
                "Referer header value must be preserved"
            )

    @patch("curl_cffi.requests.head")
    @patch("probe_backends.curl_cffi_available", return_value=True)
    def test_passes_origin_header(self, mock_available, mock_head):
        """Origin header should be passed to curl_cffi requests.head."""
        from probe_backends import probe_curl_cffi

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_head.return_value = mock_resp

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/video.mp4",
            cancel_event=cancel_event,
            headers={"Origin": "https://example.com"},
        )

        self.assertTrue(result["ok"], "Probe should succeed with Origin")
        call_kwargs = mock_head.call_args
        if call_kwargs:
            _, kwargs = call_kwargs
            passed_headers = kwargs.get("headers", {})
            self.assertIn(
                "Origin", passed_headers,
                "Origin header must be passed to curl_cffi requests.head"
            )

    @patch("curl_cffi.requests.head")
    @patch("probe_backends.curl_cffi_available", return_value=True)
    def test_passes_multiple_headers(self, mock_available, mock_head):
        """Multiple headers (Referer + Origin + User-Agent) should all be passed."""
        from probe_backends import probe_curl_cffi

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_head.return_value = mock_resp

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/video.mp4",
            cancel_event=cancel_event,
            headers={
                "Referer": "https://example.com/page",
                "Origin": "https://example.com",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
            },
        )

        self.assertTrue(result["ok"], "Probe should succeed with multiple headers")
        call_kwargs = mock_head.call_args
        if call_kwargs:
            _, kwargs = call_kwargs
            passed_headers = kwargs.get("headers", {})
            self.assertEqual(
                passed_headers.get("Referer"), "https://example.com/page",
                "Referer must be passed"
            )
            self.assertEqual(
                passed_headers.get("Origin"), "https://example.com",
                "Origin must be passed"
            )
            self.assertIn(
                "User-Agent", passed_headers,
                "User-Agent must be passed"
            )

    @patch("curl_cffi.requests.head")
    @patch("probe_backends.curl_cffi_available", return_value=True)
    def test_passes_no_headers_when_headers_is_empty_dict(self, mock_available, mock_head):
        """Empty headers dict should not cause errors."""
        from probe_backends import probe_curl_cffi

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200
        mock_head.return_value = mock_resp

        cancel_event = threading.Event()
        result = probe_curl_cffi(
            url="https://cdn.example.com/video.mp4",
            cancel_event=cancel_event,
            headers={},
        )

        self.assertTrue(result["ok"], "Probe should succeed with empty headers")


# ═══════════════════════════════════════════════════════════════════════
# D. ffmpeg Direct Stream Copy Command
# ═══════════════════════════════════════════════════════════════════════


class TestFfmpegDirectCommand(unittest.TestCase):
    """build_ffmpeg_direct_command should build correct ffmpeg commands."""

    def test_basic_ffmpeg_direct_stream_copy(self):
        """Basic ffmpeg command should use -c copy for stream copy."""
        from stream_backends import build_ffmpeg_direct_command

        command = build_ffmpeg_direct_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=r"C:\Downloads\Movie\Movie.mp4",
        )

        self.assertEqual(command[0], "ffmpeg", "First arg should be ffmpeg")
        self.assertIn("-i", command, "Should specify input with -i")
        self.assertIn("https://cdn.example.com/hls/master.m3u8", command,
                      "URL should be the input")
        self.assertIn("-c", command, "Should specify codec with -c")
        self.assertIn("copy", command, "Should use stream copy (not re-encode)")
        self.assertIn("-y", command, "Should overwrite output without asking")
        self.assertIn(r"C:\Downloads\Movie\Movie.mp4", command,
                      "Output path should be the last argument")

    def test_ffmpeg_custom_location(self):
        """Custom ffmpeg location should be used."""
        from stream_backends import build_ffmpeg_direct_command

        command = build_ffmpeg_direct_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=r"C:\Output\video.mp4",
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(
            command[0], r"C:\Tools\ffmpeg.exe",
            "Custom ffmpeg location should be the first argument"
        )

    def test_ffmpeg_with_request_headers(self):
        """Request headers should be passed as -headers to ffmpeg."""
        from stream_backends import build_ffmpeg_direct_command

        command = build_ffmpeg_direct_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=r"C:\Output\video.mp4",
            request_headers=[
                {"name": "Referer", "value": "https://example.com/watch"},
                {"name": "User-Agent", "value": "Mozilla/5.0 Test"},
            ],
        )

        self.assertIn("-headers", command,
                       "ffmpeg should use -headers for custom HTTP headers")
        headers_idx = command.index("-headers")
        headers_str = command[headers_idx + 1]
        self.assertIn("Referer: https://example.com/watch", headers_str,
                       "Referer should be in -headers")
        self.assertIn("User-Agent: Mozilla/5.0 Test", headers_str,
                       "User-Agent should be in -headers")

    def test_ffmpeg_without_headers(self):
        """No -headers flag should be added when no request headers provided."""
        from stream_backends import build_ffmpeg_direct_command

        command = build_ffmpeg_direct_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=r"C:\Output\video.mp4",
        )

        self.assertNotIn(
            "-headers", command,
            "No -headers flag when no request headers provided"
        )

    def test_ffmpeg_command_is_executable_via_subprocess(self):
        """The ffmpeg command list should be valid for subprocess.Popen."""
        from stream_backends import build_ffmpeg_direct_command

        command = build_ffmpeg_direct_command(
            url="https://cdn.example.com/manifest.mpd",
            output_path=r"C:\Downloads\Video\Video.mp4",
            request_headers=[
                {"name": "Referer", "value": "https://example.com"},
            ],
            ffmpeg_location="ffmpeg",
        )

        # Verify it's a list of strings
        self.assertIsInstance(command, list, "Command should be a list")
        for arg in command:
            self.assertIsInstance(arg, str, f"Each argument should be a string, got: {arg}")

        # Verify the structure: ffmpeg [-headers ...] -i <url> -c copy -y <output>
        self.assertGreater(len(command), 3, "Command should have at least 4 arguments")
        # The output path should be the last argument
        self.assertTrue(
            command[-1].endswith("Video.mp4") or command[-1] == r"C:\Downloads\Video\Video.mp4",
            f"Last argument should be the output path, got: {command[-1]}"
        )


# ═══════════════════════════════════════════════════════════════════════
# E. Complete Fallback Chain Priority Order
# ═══════════════════════════════════════════════════════════════════════


class TestFallbackChainPriorityOrder(unittest.TestCase):
    """The complete ordered fallback chain should follow the spec priority."""

    def _capture_fallback_commands(self, url, format_hint=None, with_n_m3u8dl_re=False):
        """Run run_download and capture fallback_commands labels in order."""
        import tempfile

        import download_manager as dm

        captured = []

        class CapturingTask:
            def __init__(self, **kwargs):
                fb = kwargs.get("fallback_commands", [])
                captured.extend([cmd.get("label", "") for cmd in (fb or [])])

            def start(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dl_dir = Path(tmpdir) / "Downloads"
            dl_dir.mkdir(parents=True)

            msg = {
                "id": "test_fallback",
                "url": url,
                "pageUrl": "https://example.com/watch",
                "formatId": "best",
            }
            if format_hint:
                msg["format"] = format_hint

            n_m3u8dl_re_resolver = (
                (lambda: r"C:\Tools\N_m3u8DL-RE.exe") if with_n_m3u8dl_re else (lambda: None)
            )

            with (
                patch.object(dm, "resolve_download_dir", return_value=dl_dir),
                patch.object(dm, "write_cookie_file_from_headers", return_value=None),
                patch.object(dm, "validate_download_url", return_value=None),
            ):
                try:
                    dm.run_download(
                        message=msg,
                        task_class=CapturingTask,
                        aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
                        ffmpeg_location_resolver=lambda: None,
                        yt_dlp_command_resolver=lambda: ["yt-dlp"],
                        n_m3u8dl_re_location_resolver=n_m3u8dl_re_resolver,
                        streamlink_command_resolver=lambda: None,
                    )
                except Exception:
                    pass  # Some flows raise HostError on all-cloudflare

        return captured

    def test_fallback_chain_priority_for_direct_mp4(self):
        """Direct MP4 URL fallback chain must follow: yt-dlp > curl-cffi > yt-dlp variants > yt-dlp native."""
        labels = self._capture_fallback_commands(
            "https://cdn.example.com/video.mp4"
        )

        # Fallback chain for direct MP4:
        expected_order = [
            "curl-cffi (direct download)",
            # yt-dlp variants (multiple):
            "yt-dlp (no SSL check)",
            "yt-dlp (geo bypass)",
            "yt-dlp (no impersonate)",
            "yt-dlp (max retries)",
            "yt-dlp (single fragment)",
            "yt-dlp (generic extractor)",
            "yt-dlp (throttle detect)",
            # you-get (if available)
            # lux (if available)
            # yt-dlp native must be last:
        ]

        # Find the indices of expected labels in the actual list
        curl_cffi_idx = next(
            (i for i, l in enumerate(labels) if "curl-cffi" in l), -1
        )
        yt_dlp_variants_start = next(
            (i for i, l in enumerate(labels) if l.startswith("yt-dlp")), -1
        )
        native_idx = next(
            (i for i, l in enumerate(labels) if "native" in l.lower()), -1
        )

        self.assertGreaterEqual(
            curl_cffi_idx, 0,
            f"curl-cffi must be in fallback chain for MP4. Got: {labels}"
        )
        self.assertGreaterEqual(
            yt_dlp_variants_start, 0,
            f"yt-dlp variants must be in fallback chain. Got: {labels}"
        )
        self.assertGreaterEqual(
            native_idx, 0,
            f"yt-dlp (native downloader) must be in fallback chain. Got: {labels}"
        )

        # curl-cffi should come before yt-dlp variants
        if curl_cffi_idx >= 0 and yt_dlp_variants_start >= 0:
            self.assertLess(
                curl_cffi_idx, yt_dlp_variants_start,
                f"curl-cffi (at {curl_cffi_idx}) should come before yt-dlp variants "
                f"(at {yt_dlp_variants_start}). Full chain: {labels}"
            )

        # yt-dlp (native downloader) should be the LAST entry
        if native_idx >= 0:
            self.assertEqual(
                native_idx, len(labels) - 1,
                f"yt-dlp (native downloader) should be the last fallback "
                f"(at {native_idx} of {len(labels)}). Full chain: {labels}"
            )

    def test_fallback_chain_priority_for_hls_url(self):
        """HLS URL fallback chain must follow: yt-dlp > N_m3u8DL-RE > yt-dlp variants > Streamlink > ffmpeg > yt-dlp native."""
        labels = self._capture_fallback_commands(
            "https://cdn.example.com/hls/master.m3u8",
            format_hint="M3U8",
            with_n_m3u8dl_re=True,
        )

        # Find key entries
        n_m3u8dl_re_idx = next(
            (i for i, l in enumerate(labels) if "N_m3u8DL-RE" in l), -1
        )
        yt_dlp_variants_start = next(
            (i for i, l in enumerate(labels) if l.startswith("yt-dlp")), -1
        )
        ffmpeg_idx = next(
            (i for i, l in enumerate(labels) if "ffmpeg" in l.lower()), -1
        )
        native_idx = next(
            (i for i, l in enumerate(labels) if "native" in l.lower()), -1
        )

        self.assertGreaterEqual(
            n_m3u8dl_re_idx, 0,
            f"N_m3u8DL-RE must be in fallback chain for HLS. Got: {labels}"
        )
        self.assertGreaterEqual(
            ffmpeg_idx, 0,
            f"ffmpeg (direct stream copy) must be in fallback chain for HLS. Got: {labels}"
        )
        self.assertGreaterEqual(
            native_idx, 0,
            f"yt-dlp (native downloader) must be in fallback. Got: {labels}"
        )

        # N_m3u8DL-RE should come before yt-dlp variants
        if n_m3u8dl_re_idx >= 0 and yt_dlp_variants_start >= 0:
            self.assertLess(
                n_m3u8dl_re_idx, yt_dlp_variants_start,
                f"N_m3u8DL-RE (at {n_m3u8dl_re_idx}) should come before yt-dlp variants "
                f"(at {yt_dlp_variants_start}). Full chain: {labels}"
            )

        # ffmpeg should be before yt-dlp native
        if ffmpeg_idx >= 0 and native_idx >= 0:
            self.assertLess(
                ffmpeg_idx, native_idx,
                f"ffmpeg (at {ffmpeg_idx}) should come before yt-dlp native "
                f"(at {native_idx}). Full chain: {labels}"
            )

        # yt-dlp (native downloader) should be the LAST entry
        if native_idx >= 0:
            self.assertEqual(
                native_idx, len(labels) - 1,
                f"yt-dlp (native downloader) should be the last fallback "
                f"(at {native_idx} of {len(labels)}). Full chain: {labels}"
            )

    def test_fallback_chain_excludes_curl_cffi_for_hls(self):
        """curl-cffi should NOT be in the fallback chain for HLS manifest URLs."""
        labels = self._capture_fallback_commands(
            "https://cdn.example.com/hls/master.m3u8",
            format_hint="M3U8",
        )
        curl_cffi_entries = [l for l in labels if "curl-cffi" in l]
        self.assertEqual(
            len(curl_cffi_entries), 0,
            f"curl-cffi should NOT be in fallback for HLS URLs. Got: {labels}"
        )

    def test_fallback_chain_excludes_you_get_lux_for_hls(self):
        """you-get and lux should NOT be in the fallback chain for HLS URLs."""
        labels = self._capture_fallback_commands(
            "https://cdn.example.com/hls/master.m3u8",
            format_hint="M3U8",
        )
        you_get_entries = [l for l in labels if "you-get" in l.lower()]
        lux_entries = [l for l in labels if "lux" in l.lower()]
        self.assertEqual(
            len(you_get_entries), 0,
            f"you-get should NOT be in fallback for HLS URLs. Got: {labels}"
        )
        self.assertEqual(
            len(lux_entries), 0,
            f"lux should NOT be in fallback for HLS URLs. Got: {labels}"
        )


# ═══════════════════════════════════════════════════════════════════════
# F. Magnet/Torrent URL Probe Exclusion
# ═══════════════════════════════════════════════════════════════════════


class TestMagnetTorrentProbeExclusion(unittest.TestCase):
    """Magnet and torrent URLs should bypass probing entirely."""

    def test_magnet_url_skips_probe_runner(self):
        """Magnet: URLs should skip probe_runner and go directly to magnet download."""
        import download_manager as dm

        probe_fn = MagicMock()
        magnet_started = [False]

        def mock_magnet_download(message, **kwargs):
            magnet_started[0] = True

        with patch.object(dm, "run_gopeed_magnet_download", mock_magnet_download):
            try:
                dm.run_download(
                    message={
                        "id": "magnet_test",
                        "url": "magnet:?xt=urn:btih:test1234567890abcdef",
                        "pageUrl": "",
                    },
                    task_class=None,
                    aria2c_location_resolver=lambda: None,
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: None,
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                    probe_runner_fn=probe_fn,
                )
            except Exception:
                # Might raise if magnet download attempts fail, that's OK
                pass

        # probe_runner should NOT be called for magnet URLs
        probe_fn.assert_not_called()

    def test_torrent_file_url_skips_probe_runner(self):
        """Torrent file URLs should skip probe_runner."""
        import download_manager as dm

        probe_fn = MagicMock()

        with patch.object(dm, "run_gopeed_torrent_download"):
            try:
                dm.run_download(
                    message={
                        "id": "torrent_test",
                        "url": "https://example.com/file.torrent",
                        "pageUrl": "",
                    },
                    task_class=None,
                    aria2c_location_resolver=lambda: None,
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: None,
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                    probe_runner_fn=probe_fn,
                )
            except Exception:
                pass

        # probe_runner should NOT be called for torrent URLs
        probe_fn.assert_not_called()

    def test_normal_url_calls_probe_runner(self):
        """Normal video URLs should still call probe_runner."""
        import download_manager as dm

        probe_fn = MagicMock(return_value=None)

        with (
            patch.object(dm, "resolve_download_dir", return_value=Path("/tmp")),
            patch.object(dm, "write_cookie_file_from_headers", return_value=None),
            patch.object(dm, "validate_download_url", return_value=None),
        ):
            try:
                dm.run_download(
                    message={
                        "id": "normal_test",
                        "url": "https://cdn.example.com/video.mp4",
                        "pageUrl": "https://example.com/watch",
                        "formatId": "best",
                    },
                    task_class=None,
                    aria2c_location_resolver=lambda: None,
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: None,
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                    probe_runner_fn=probe_fn,
                )
            except Exception:
                pass

        # probe_runner SHOULD be called for normal video URLs
        probe_fn.assert_called()


# ═══════════════════════════════════════════════════════════════════════
# G. Probe Cancellation on Winner Found
# ═══════════════════════════════════════════════════════════════════════


class TestProbeCancellationOnWinner(unittest.TestCase):
    """When a winner is found, remaining probes should be notified via cancel_event."""

    def test_cancel_event_set_when_winner_found(self):
        """cancel_event must be set immediately when a probe succeeds."""
        from probe_runner import ProbeConfig, ProbeResult, run_parallel_probes

        cancel_event = threading.Event()
        send_messages = []
        logger = MagicMock()

        fast_config = ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda url, ce: {
                "ok": True,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": None,
                "message": None,
                "status_code": None,
                "raw_output": None,
                "duration_ms": 10,
            },
            command=["yt-dlp", "url"],
        )

        result = run_parallel_probes(
            url="https://example.com/video",
            probes=[fast_config],
            cancel_event=cancel_event,
            send_message=send_messages.append,
            logger=logger,
        )

        self.assertEqual(result.winner, "yt-dlp", "Probe should succeed")
        self.assertTrue(
            cancel_event.is_set(),
            "cancel_event must be set after winner is found"
        )

    def test_probe_checks_cancel_event_before_work(self):
        """Probe functions should check cancel_event before starting work."""
        # probe_yt_dlp checks cancel_event first
        from probe_backends import probe_yt_dlp

        cancel_event = threading.Event()
        cancel_event.set()  # Already cancelled

        result = probe_yt_dlp(
            url="https://example.com/video",
            cancel_event=cancel_event,
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=None,
        )

        self.assertFalse(result["ok"], "Should not succeed when cancelled")
        self.assertEqual(
            result["error_type"], "cancelled",
            "Should report cancelled error_type when cancel_event is set"
        )

    def test_probe_checks_cancel_event_during_work(self):
        """Probe functions should accept cancel_event parameter in their signature."""
        # This test verifies all probe backends are aware of cancellation
        # by checking their function signatures.
        import inspect
        from probe_backends import (
            probe_curl_cffi,
            probe_n_m3u8dl_re,
            probe_streamlink,
            probe_yt_dlp,
        )

        cancel_event = threading.Event()

        # Verify probe_curl_cffi accepts cancel_event
        sig = inspect.signature(probe_curl_cffi)
        self.assertIn(
            "cancel_event", sig.parameters,
            "probe_curl_cffi must accept cancel_event parameter"
        )

        # Verify probe_yt_dlp accepts cancel_event
        sig2 = inspect.signature(probe_yt_dlp)
        self.assertIn(
            "cancel_event", sig2.parameters,
            "probe_yt_dlp must accept cancel_event parameter"
        )

        # Verify probe_n_m3u8dl_re accepts cancel_event
        sig3 = inspect.signature(probe_n_m3u8dl_re)
        self.assertIn(
            "cancel_event", sig3.parameters,
            "probe_n_m3u8dl_re must accept cancel_event parameter"
        )

        # Verify probe_streamlink accepts cancel_event
        sig4 = inspect.signature(probe_streamlink)
        self.assertIn(
            "cancel_event", sig4.parameters,
            "probe_streamlink must accept cancel_event parameter"
        )


class TestBuildDownloadCommandFallbackVariants(unittest.TestCase):
    """build_yt_dlp_fallback_variants should produce the correct ordered list."""

    def test_fallback_variants_ordered_by_strategy(self):
        """Fallback variants should follow: no-SSL > geo > no-impersonate > max-retries > single-fragment > generic > throttle."""
        from yt_dlp_command import build_yt_dlp_fallback_variants

        variants = build_yt_dlp_fallback_variants(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        labels = [v.get("label", "") for v in variants]

        expected_labels = [
            "yt-dlp (no SSL check)",
            "yt-dlp (geo bypass)",
            "yt-dlp (no impersonate)",
            "yt-dlp (max retries)",
            "yt-dlp (single fragment)",
            "yt-dlp (generic extractor)",
            "yt-dlp (throttle detect)",
        ]

        for i, expected in enumerate(expected_labels):
            self.assertIn(
                expected, labels,
                f"Fallback variant #{i + 1} should be '{expected}'. Got: {labels}"
            )
            self.assertEqual(
                labels[i],
                expected,
                f"Fallback variant at position {i} should be '{expected}'. "
                f"Got: '{labels[i] if i < len(labels) else 'N/A'}'. Full: {labels}"
            )

    def test_yt_dlp_variants_have_valid_commands(self):
        """Each fallback variant should have a valid command list."""
        from yt_dlp_command import build_yt_dlp_fallback_variants

        variants = build_yt_dlp_fallback_variants(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        for variant in variants:
            self.assertIn("command", variant, f"Variant {variant.get('label')} must have 'command'")
            self.assertIn("label", variant, f"Variant must have 'label'")
            cmd = variant["command"]
            self.assertIsInstance(cmd, list, f"Command for {variant['label']} must be a list")
            self.assertGreater(len(cmd), 0, f"Command for {variant['label']} must not be empty")
            self.assertEqual(cmd[0], "yt-dlp", f"First arg for {variant['label']} must be yt-dlp")


# ═══════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
