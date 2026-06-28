"""Tests for curl_cffi_adapter module."""

import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import MagicMock, patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

import curl_cffi_adapter as cca
from native_protocol import HostError


class TestCurlCffiAvailable(unittest.TestCase):
    """Verify curl_cffi availability detection."""

    def test_curl_cffi_available_returns_bool(self):
        """curl_cffi_available() should return a boolean."""
        result = cca.curl_cffi_available()
        self.assertIsInstance(result, bool)

    def test_curl_cffi_available_false_when_not_installed(self):
        """Simulate curl_cffi not being installed."""
        with patch.dict("sys.modules", {"curl_cffi": None}):
            import importlib

            importlib.reload(cca)
            self.assertFalse(cca.curl_cffi_available())


class TestFetchPageText(unittest.TestCase):
    """Test fetch_page_text with fallback behavior."""

    def test_fetch_page_text_returns_string(self):
        """Should return a string (possibly empty on network error)."""
        result = cca.fetch_page_text("https://httpbin.org/html", {}, impersonate="chrome")
        self.assertIsInstance(result, str)

    def test_fetch_page_text_fallback_on_unavailable(self):
        """Should fall back gracefully when curl_cffi is not available."""
        with patch.object(cca, "curl_cffi_available", return_value=False):
            result = cca.fetch_page_text("https://httpbin.org/html", {})
            self.assertIsInstance(result, str)

    def test_fetch_page_text_returns_empty_on_fetch_failure(self):
        """Should return empty string on unreachable URL."""
        result = cca.fetch_page_text("https://nonexistent.invalid/page", {}, impersonate="chrome")
        self.assertEqual(result, "")


class TestDownloadWithCurlCffi(unittest.TestCase):
    """Test in-process download via curl_cffi."""

    @patch("curl_cffi.requests.get")
    def test_download_with_curl_cffi_creates_file(self, mock_get):
        """A successful download should create the output file."""
        # Mock the response - curl_cffi does not support context manager
        mock_resp = MagicMock()
        mock_resp.headers = {"content-length": "1024"}

        def iter_content(chunk_size=8192):
            yield b"x" * 512
            yield b"x" * 512

        mock_resp.iter_content = iter_content
        mock_get.return_value = mock_resp

        with patch.object(cca, "curl_cffi_available", return_value=True):
            with tempfile.TemporaryDirectory() as tmpdir:
                output = Path(tmpdir) / "test.bin"
                result = cca.download_with_curl_cffi(
                    url="https://example.com/video.mp4",
                    output_path=str(output),
                    headers={},
                )
                self.assertEqual(result, str(output))
                self.assertTrue(output.exists())
                self.assertGreater(output.stat().st_size, 0)

    def test_download_with_curl_cffi_cancel_before_network_request(self):
        """Cancellation before network request returns None and doesn't create file."""
        cancel = Event()
        cancel.set()

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "test.bin"
            result = cca.download_with_curl_cffi(
                url="https://example.com/video.mp4",
                output_path=str(output),
                headers={},
                cancel_event=cancel,
            )

            self.assertIsNone(result)
            self.assertFalse(output.exists())

    def test_download_with_curl_cffi_cancel_returns_none(self):
        """Cancellation before download should return None without network request."""
        cancel = Event()
        cancel.set()

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "test.bin"
            result = cca.download_with_curl_cffi(
                url="https://example.com/video.mp4",
                output_path=str(output),
                headers={},
                cancel_event=cancel,
            )
            self.assertIsNone(result)
            self.assertFalse(output.exists())

    @patch("curl_cffi.requests.get")
    def test_download_with_curl_cffi_reports_progress(self, mock_get):
        """Progress callback should be called during download."""
        mock_resp = MagicMock()
        mock_resp.headers = {"content-length": "1024"}

        def iter_content(chunk_size=8192):
            yield b"x" * 512
            yield b"x" * 512

        mock_resp.iter_content = iter_content
        mock_get.return_value = mock_resp

        progress_calls = []

        def cb(downloaded, total):
            progress_calls.append((downloaded, total))

        with patch.object(cca, "curl_cffi_available", return_value=True):
            with tempfile.TemporaryDirectory() as tmpdir:
                output = Path(tmpdir) / "test.bin"
                cca.download_with_curl_cffi(
                    url="https://example.com/video.mp4",
                    output_path=str(output),
                    headers={},
                    progress_callback=cb,
                )

        self.assertGreater(len(progress_calls), 0)
        final_downloaded, final_total = progress_calls[-1]
        self.assertEqual(final_downloaded, 1024)
        self.assertEqual(final_total, 1024)

    def test_download_with_curl_cffi_raises_host_error_on_bad_url(self):
        """Downloading from a bad URL should raise HostError."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "test.bin"
            with self.assertRaises(HostError):
                cca.download_with_curl_cffi(
                    url="https://nonexistent.invalid/video.mp4",
                    output_path=str(output),
                    headers={},
                )

    @patch("urllib.request.urlopen")
    def test_download_with_curl_cffi_fallback_on_unavailable(self, mock_urlopen):
        """Should fall back to urllib when curl_cffi is unavailable."""
        mock_resp = MagicMock()
        mock_resp.headers = {"Content-Length": "1024"}
        mock_resp.read.side_effect = [b"x" * 1024, b""]
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        with patch.object(cca, "curl_cffi_available", return_value=False):
            with tempfile.TemporaryDirectory() as tmpdir:
                output = Path(tmpdir) / "test.bin"
                result = cca.download_with_curl_cffi(
                    url="https://example.com/bytes/1024",
                    output_path=str(output),
                    headers={},
                )
                self.assertEqual(result, str(output))
                self.assertTrue(output.exists())

    @patch("urllib.request.urlopen")
    def test_download_with_curl_cffi_cancel_on_fallback(self, mock_urlopen):
        """Cancellation should work during urllib fallback too."""
        mock_resp = MagicMock()
        mock_resp.headers = {"Content-Length": "1024"}
        # Return some data before cancellation is detected
        mock_resp.read.side_effect = [b"x" * 512, b"x" * 512]
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        with patch.object(cca, "curl_cffi_available", return_value=False):
            cancel = Event()
            cancel.set()
            with tempfile.TemporaryDirectory() as tmpdir:
                output = Path(tmpdir) / "test.bin"
                result = cca.download_with_curl_cffi(
                    url="https://example.com/bytes/1024",
                    output_path=str(output),
                    headers={},
                    cancel_event=cancel,
                )
                self.assertIsNone(result)
                self.assertFalse(output.exists())


class TestDownloadCurlCffiCommand(unittest.TestCase):
    """Test subprocess command builder."""

    def test_download_curl_cffi_command_returns_list(self):
        """Should return a list of strings suitable for subprocess."""
        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={"Referer": "https://example.com/"},
        )
        self.assertIsInstance(cmd, list)
        self.assertGreater(len(cmd), 0)
        self.assertIsInstance(cmd[0], str)

    def test_download_curl_cffi_command_includes_python(self):
        """Should start with sys.executable."""
        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={},
        )
        self.assertEqual(cmd[0], sys.executable)
        self.assertEqual(cmd[1], "-c")

    def test_download_curl_cffi_command_encodes_headers(self):
        """Headers should be JSON-encoded in the command script."""
        headers = {"Referer": "https://example.com/", "User-Agent": "Test/1.0"}
        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers=headers,
        )
        script = cmd[2]
        # The headers JSON should appear somewhere in the script
        # (it will be escaped in the f-string)
        self.assertIn("Referer", script)
        self.assertIn("Test/1.0", script)
        # Verify the JSON is valid
        # Extract the json.loads argument
        import re

        match = re.search(r'json\.loads\(["\'](.+?)["\']\)', script)
        self.assertIsNotNone(match, "JSON loads call should be present in the script")

    def test_download_curl_cffi_command_script_executable(self):
        """The generated script should be syntactically valid Python."""
        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={},
        )
        script = cmd[2]
        try:
            compile(script, "<test>", "exec")
        except SyntaxError as exc:
            self.fail(f"Generated script has syntax error: {exc}")


class TestDirectMediaUrlHeuristic(unittest.TestCase):
    """Test the heuristic used by download_manager to decide when curl_cffi applies."""

    def _is_stream_manifest(self, url):
        """Replicate the check used in download_manager.run_download()."""
        from stream_backends import is_stream_manifest_url

        return is_stream_manifest_url(url)

    def test_direct_mp4_is_not_stream_manifest(self):
        self.assertFalse(self._is_stream_manifest("https://cdn.example.com/video.mp4"))
        self.assertFalse(
            self._is_stream_manifest("https://cdn.example.com/video.mp4?token=abc&expiry=123")
        )

    def test_m3u8_is_stream_manifest(self):
        self.assertTrue(self._is_stream_manifest("https://cdn.example.com/hls/master.m3u8"))

    def test_mpd_is_stream_manifest(self):
        self.assertTrue(self._is_stream_manifest("https://cdn.example.com/dash/manifest.mpd"))

    def test_webm_is_not_stream_manifest(self):
        self.assertFalse(self._is_stream_manifest("https://cdn.example.com/video.webm"))

    def test_ism_is_stream_manifest(self):
        self.assertTrue(self._is_stream_manifest("https://cdn.example.com/video.ism/Manifest"))


if __name__ == "__main__":
    unittest.main()
