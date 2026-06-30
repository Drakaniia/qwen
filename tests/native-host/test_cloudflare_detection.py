"""Tests for enhanced Cloudflare/anti-bot detection in downloads.

RED phase — these tests describe desired behavior that is NOT YET IMPLEMENTED.
They will fail until the corresponding GREEN phase implementation is written.
"""

import sys
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import MagicMock, patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

from progress_parser import is_cloudflare_challenge, is_html_error_page
from probe_types import ProbeConfig, ProbeError, ProbeResult


# ═══════════════════════════════════════════════════════════════════════
# 1. Enhanced is_cloudflare_challenge — Turnstile & generic anti-bot
# ═══════════════════════════════════════════════════════════════════════

class TestEnhancedCloudflareChallengeDetection(unittest.TestCase):
    """is_cloudflare_challenge should detect newer Cloudflare challenge formats."""

    def test_detects_turnstile_challenge(self):
        """Cloudflare Turnstile widget should be detected."""
        html = b"""<!DOCTYPE html><html><head><title>Just a moment...</title>
        <script src="/cdn-cgi/challenge-platform/scripts/turnstile.js"></script>
        <div id="cf-turnstile"></div><body>Checking your browser...</body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_detects_generic_just_a_moment(self):
        """'Just a moment...' with anti-bot indicators should be detected."""
        html = b"""<!DOCTYPE html><html><head><title>Just a moment...</title>
        <body>Please wait while we check your browser...</body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_detects_checking_browser_before_access(self):
        """'Checking your browser before accessing' should be detected."""
        html = b"""<html><head><title>Please wait...</title></head>
        <body>Checking your browser before accessing the site. This may take a moment.</body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_detects_unusual_traffic(self):
        """'unusual traffic' + anti-bot context should be detected."""
        html = b"""<html><head><title>Unusual traffic detected</title></head>
        <body>Our system has detected unusual traffic from your network.<div id="challenge"></div></body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_detects_ddos_protection(self):
        """DDOS protection challenge pages should be detected."""
        html = b"""<html><head><title>DDoS Protection</title></head>
        <body><div id="cf-please-wait">Please wait while we verify your browser...</div></body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_detects_cf_browser_check_script(self):
        """Challenge pages with jschl-answer script should be detected."""
        html = b"""<html><body><script type="text/javascript">
        var s = document.createElement('script');
        s.src = '/cdn-cgi/challenge-platform/h/b/scripts/jsd/abc123/instrument.js';
        document.head.appendChild(s);
        document.getElementById('challenge-form').submit();
        </script></body></html>"""
        self.assertTrue(is_cloudflare_challenge(html))

    def test_rejects_normal_web_page(self):
        """Normal web page with video should not be flagged."""
        html = b"""<!DOCTYPE html><html><head><title>My Video Page</title></head>
        <body><video src="movie.mp4" controls>Your browser does not support the video tag.</video>
        <p>Welcome to my website where I share videos about interesting topics.</p></body></html>"""
        self.assertFalse(is_cloudflare_challenge(html))

    def test_rejects_small_content(self):
        """Very small content should not be flagged."""
        html = b"<html><head></head>"
        self.assertFalse(is_cloudflare_challenge(html))

    def test_rejects_video_content(self):
        """MP4 video header should not be flagged."""
        video_header = b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x08moov"
        self.assertFalse(is_cloudflare_challenge(video_header))

    def test_rejects_mpegts_content(self):
        """MPEG-TS video data should not be flagged."""
        ts_data = b"G\x80\x10\x00\x01\xc0\x00\x00\x00\x01\xe0\x00\x00\x80\x00\x00"
        self.assertFalse(is_cloudflare_challenge(ts_data))

    def test_rejects_404_page_without_anti_bot(self):
        """Regular 404 page without anti-bot keywords should not be flagged."""
        html = b"""<!DOCTYPE html><html><head><title>404 Not Found</title></head>
        <body><h1>404</h1><p>The page you requested was not found.</p></body></html>"""
        self.assertFalse(is_cloudflare_challenge(html))


# ═══════════════════════════════════════════════════════════════════════
# 2. Enhanced is_html_error_page — broader detection
# ═══════════════════════════════════════════════════════════════════════

class TestEnhancedHtmlErrorPageDetection(unittest.TestCase):
    """is_html_error_page should detect more error page patterns."""

    def test_detects_cloudflare_403_page(self):
        """Cloudflare 403 forbidden page should be detected."""
        html = b"<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Access denied by Cloudflare</body></html>"
        self.assertTrue(is_html_error_page(html))

    def test_detects_error_title_403(self):
        """Generic 403 error with HTML should be detected."""
        html = b"<!DOCTYPE html><html><head><title>403 - Forbidden</title></head><body>You don't have permission to access this resource.</body></html>"
        self.assertTrue(is_html_error_page(html))

    def test_detects_error_title_404(self):
        """404 error with HTML should be detected."""
        html = b"<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>The requested URL was not found on this server.</body></html>"
        self.assertTrue(is_html_error_page(html))

    def test_detects_error_title_500(self):
        """500 error with HTML should be detected."""
        html = b"<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body>Internal server error occurred.</body></html>"
        self.assertTrue(is_html_error_page(html))

    def test_detects_access_denied(self):
        """Access denied error page should be detected."""
        html = b"<!DOCTYPE html><html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don't have permission to access this page.</p></body></html>"
        self.assertTrue(is_html_error_page(html))

    def test_rejects_video_html5(self):
        """HTML5 video page without error indicators should not be flagged."""
        html = b"<!DOCTYPE html><html><head><title>Video Player</title></head><body><video width='640' height='360' controls><source src='movie.mp4' type='video/mp4'></video></body></html>"
        self.assertFalse(is_html_error_page(html))

    def test_rejects_blog_page(self):
        """Normal HTML blog content without error keywords should not be flagged."""
        html = b"<!DOCTYPE html><html><head><title>My Blog</title></head><body><article><h1>Welcome</h1><p>This is my blog where I share thoughts about technology.</p></article></body></html>"
        self.assertFalse(is_html_error_page(html))


# ═══════════════════════════════════════════════════════════════════════
# 3. Cloudflare-specific error type in probe results
# ═══════════════════════════════════════════════════════════════════════

class TestProbeCloudflareDetection(unittest.TestCase):
    """Probes should detect Cloudflare blocks specifically."""

    def test_probe_yt_dlp_detects_cloudflare_403_in_stderr(self):
        """yt-dlp probe should detect Cloudflare 403 in stderr output."""
        from probe_backends import probe_yt_dlp

        # Realistic yt-dlp error output when blocked by Cloudflare
        result = probe_yt_dlp(
            url="https://example.com/master.m3u8",
            cancel_event=Event(),
            yt_dlp_command=[sys.executable, "-c",
                "import sys; print('ERROR: [example.com] HTTP Error 403: Forbidden (caused by Cloudflare)', file=sys.stderr); sys.exit(1)"],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_type"], "cloudflare_block",
                         "yt-dlp probe should report cloudflare_block for 403 errors with Cloudflare hints")

    def test_probe_curl_cffi_detects_cloudflare_403(self):
        """curl_cffi probe should detect Cloudflare 403 in response body."""
        from probe_backends import probe_curl_cffi

        # Mock a response that returns a Cloudflare challenge page
        with patch("curl_cffi.requests.head") as mock_head:
            mock_resp = MagicMock()
            mock_resp.ok = False
            mock_resp.status_code = 403
            mock_resp.text = "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>...</body></html>"
            mock_head.return_value = mock_resp

            with patch("probe_backends.curl_cffi_available", return_value=True):
                result = probe_curl_cffi(
                    url="https://example.com/video.mp4",
                    cancel_event=Event(),
                )

        self.assertFalse(result["ok"])
        # The error_type should be "cloudflare_block" when 403 + challenge content
        self.assertEqual(result["error_type"], "cloudflare_block",
                         "curl_cffi probe should report cloudflare_block for 403 with challenge HTML")

    def test_probe_normal_403_without_cloudflare(self):
        """Normal 403 without Cloudflare challenge should report http_error."""
        from probe_backends import probe_curl_cffi

        with patch("curl_cffi.requests.head") as mock_head:
            mock_resp = MagicMock()
            mock_resp.ok = False
            mock_resp.status_code = 403
            mock_resp.text = "<html><body>Access denied by server configuration</body></html>"
            mock_head.return_value = mock_resp

            with patch("probe_backends.curl_cffi_available", return_value=True):
                result = probe_curl_cffi(
                    url="https://example.com/video.mp4",
                    cancel_event=Event(),
                )

        self.assertFalse(result["ok"])
        # This is a regular 403, not a Cloudflare block
        self.assertEqual(result["error_type"], "http_error",
                         "Non-Cloudflare 403 should still report http_error")


# ═══════════════════════════════════════════════════════════════════════
# 4. Fallback chain should abort when all probes detect Cloudflare
# ═══════════════════════════════════════════════════════════════════════

class TestFallbackChainCloudflareAbort(unittest.TestCase):
    """The download fallback chain should abort early when all probes detect Cloudflare blocks."""

    def test_run_download_aborts_when_all_probes_return_cloudflare(self):
        """When ALL probes return 403 Cloudflare errors, run_download should abort early."""
        from download_manager import run_download

        sent_messages = []

        def mock_send(msg):
            sent_messages.append(msg)

        def mock_probe_runner(*args, **kwargs):
            """Simulate all probes failing with Cloudflare 403."""
            return ProbeResult(
                winner=None,
                command=None,
                label=None,
                errors=[
                    ProbeError(
                        backend="yt-dlp",
                        label="yt-dlp (skip-download)",
                        error_type="cloudflare_block",
                        message="HTTP Error 403: Forbidden by Cloudflare anti-bot protection",
                        status_code=403,
                    ),
                    ProbeError(
                        backend="curl_cffi",
                        label="curl-cffi (HEAD)",
                        error_type="cloudflare_block",
                        message="HTTP 403: Cloudflare challenge page detected",
                        status_code=403,
                    ),
                ],
                duration_ms=5000,
            )

        # This should raise HostError instead of starting a download task
        from native_protocol import HostError

        with self.assertRaises(HostError) as ctx:
            run_download(
                message={
                    "id": "test_abort",
                    "url": "https://example.com/master.m3u8",
                    "pageUrl": "https://example.com/video",
                    "format": "M3U8",
                },
                task_class=None,
                yt_dlp_command_resolver=lambda: [sys.executable, "-c", "print('mock yt-dlp')"],
                ffmpeg_location_resolver=lambda: None,
                aria2c_location_resolver=lambda: None,
                n_m3u8dl_re_location_resolver=lambda: None,
                streamlink_command_resolver=lambda: None,
                probe_runner_fn=mock_probe_runner,
            )

        # The error should mention Cloudflare
        self.assertIn("cloudflare", str(ctx.exception).lower(),
                      "Error should mention Cloudflare when all probes detect blocks")

    def test_run_download_proceeds_if_some_probes_succeed(self):
        """When at least one probe succeeds, fallback chain should proceed as normal."""
        from download_manager import run_download

        def mock_probe_runner(*args, **kwargs):
            """Simulate one probe succeeding, one failing with Cloudflare."""
            return ProbeResult(
                winner="yt-dlp",
                command=[sys.executable, "-c", "print('success')"],
                label="yt-dlp (skip-download)",
                errors=[],
                duration_ms=2000,
            )

        # Import the class for the task
        from download_task import DownloadTask

        # This should start a task (not raise) since a probe succeeded
        try:
            run_download(
                message={
                    "id": "test_proceed",
                    "url": "https://example.com/master.m3u8",
                    "pageUrl": "https://example.com/video",
                    "format": "M3U8",
                },
                task_class=DownloadTask,
                yt_dlp_command_resolver=lambda: [sys.executable, "-c", "print('mock yt-dlp')"],
                ffmpeg_location_resolver=lambda: None,
                aria2c_location_resolver=lambda: None,
                n_m3u8dl_re_location_resolver=lambda: None,
                streamlink_command_resolver=lambda: None,
                probe_runner_fn=mock_probe_runner,
            )
        except Exception:
            self.fail("run_download should not raise when at least one probe succeeds")


# ═══════════════════════════════════════════════════════════════════════
# 5. Fragment check should cover ALL file extensions
# ═══════════════════════════════════════════════════════════════════════

class TestFragmentCloudflareCheckAllExtensions(unittest.TestCase):
    """DownloadTask should check ALL fragment files for Cloudflare content, not just .mp4/.ts."""

    def test_check_m4s_fragments_for_cloudflare(self):
        """Cloudflare check should include .m4s fragment files."""
        from download_task import DownloadTask

        task = DownloadTask(
            message={"id": "frag_test", "url": "https://example.com/manifest.mpd"},
            command=[sys.executable, "-c", "print('mock')"],
            download_dir=Path(ROOT_DIR / "tests" / "fixtures"),
            send=lambda msg: None,
        )

        # Simulate a fragment with .m4s extension containing Cloudflare HTML
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            frag_dir = Path(tmpdir) / "artifacts"
            frag_dir.mkdir()
            frag_file = frag_dir / "seg-001.m4s"
            frag_file.write_bytes(
                b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>...</body></html>"
            )

            task.artifact_root = str(frag_dir)
            task.final_path = str(frag_dir / "output.mp4")
            Path(task.final_path).write_bytes(
                b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x08moov"
            )

            # Run the Cloudflare post-processing check
            # (This test will fail in RED phase if the check doesn't cover .m4s)
            downloadable = task._check_cloudflare_in_artifacts()
            self.assertTrue(downloadable,
                          "Cloudflare challenge in .m4s fragment should be detected")

    def test_check_cmfv_fragments_for_cloudflare(self):
        """Cloudflare check should include .cmfv fragment files."""
        from download_task import DownloadTask

        task = DownloadTask(
            message={"id": "cmfv_test", "url": "https://example.com/manifest.mpd"},
            command=[sys.executable, "-c", "print('mock')"],
            download_dir=Path(ROOT_DIR / "tests" / "fixtures"),
            send=lambda msg: None,
        )

        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            frag_dir = Path(tmpdir) / "artifacts"
            frag_dir.mkdir()
            frag_file = frag_dir / "audio_track_1.cmfv"
            frag_file.write_bytes(
                b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title><body>Checking your browser...</body></html>"
            )

            task.artifact_root = str(frag_dir)
            task.final_path = str(frag_dir / "output.mp4")
            Path(task.final_path).write_bytes(
                b"\x00\x00\x00\x20ftypmp42"
            )

            downloadable = task._check_cloudflare_in_artifacts()
            self.assertTrue(downloadable,
                          "Cloudflare challenge in .cmfv fragment should be detected")

    def test_check_no_extension_fragments(self):
        """Cloudflare check should include fragments without any extension."""
        from download_task import DownloadTask

        task = DownloadTask(
            message={"id": "noext_test", "url": "https://example.com/manifest.m3u8"},
            command=[sys.executable, "-c", "print('mock')"],
            download_dir=Path(ROOT_DIR / "tests" / "fixtures"),
            send=lambda msg: None,
        )

        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            frag_dir = Path(tmpdir) / "artifacts"
            frag_dir.mkdir()
            frag_file = frag_dir / "init"
            frag_file.write_bytes(
                b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Challenge page content for testing purposes that needs to be long enough</body></html>"
            )

            task.artifact_root = str(frag_dir)
            task.final_path = str(frag_dir / "output.mp4")
            Path(task.final_path).write_bytes(
                b"\x00\x00\x00\x20ftypmp42"
            )

            downloadable = task._check_cloudflare_in_artifacts()
            self.assertTrue(downloadable,
                          "Cloudflare challenge in extensionless fragment should be detected")


if __name__ == "__main__":
    unittest.main()
