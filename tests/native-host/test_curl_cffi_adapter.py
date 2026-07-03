"""Tests for curl_cffi_adapter module."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import MagicMock, patch

import path_setup  # noqa: F401

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

    def _cleanup(self, tmp_paths):
        """Remove temp files created during a test."""
        for p in tmp_paths:
            try:
                os.unlink(p)
            except OSError:
                pass

    def test_download_curl_cffi_command_returns_tuple(self):
        """Should return a (command, temp_files) tuple."""
        cmd, tmp = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={"Referer": "https://example.com/"},
        )
        try:
            self.assertIsInstance(cmd, list)
            self.assertIsInstance(tmp, list)
            self.assertGreater(len(cmd), 0)
            self.assertIsInstance(cmd[0], str)
            self.assertGreater(len(tmp), 0)
            self.assertTrue(tmp[0].endswith(".json"))
        finally:
            self._cleanup(tmp)

    def test_download_curl_cffi_command_includes_python(self):
        """Should start with sys.executable and point to this adapter."""
        cmd, tmp = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={},
        )
        try:
            self.assertEqual(cmd[0], sys.executable)
            # cmd[1] should be the path to curl_cffi_adapter.py (not "-c")
            self.assertTrue(
                "curl_cffi_adapter" in cmd[1],
                f"Expected adapter path, got {cmd[1]}",
            )
            # --header-file and --impersonate should appear in the args
            self.assertIn("--header-file", cmd)
            self.assertIn("--impersonate", cmd)
        finally:
            self._cleanup(tmp)

    def test_download_curl_cffi_command_header_file_created(self):
        """Headers should be written to a temporary JSON file."""
        headers = {"Referer": "https://example.com/", "User-Agent": "Test/1.0"}
        cmd, tmp = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers=headers,
        )
        try:
            # The header file exists and contains the headers
            hdrs_path = tmp[0]
            self.assertTrue(os.path.exists(hdrs_path), "Header temp file was not created")
            with open(hdrs_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            self.assertEqual(saved.get("Referer"), "https://example.com/")
            self.assertEqual(saved.get("User-Agent"), "Test/1.0")
            # The --header-file arg in the command points to this file
            hf_idx = cmd.index("--header-file")
            self.assertEqual(cmd[hf_idx + 1], hdrs_path)
        finally:
            self._cleanup(tmp)

    def test_download_curl_cffi_command_impersonate_included(self):
        """Impersonation string should be passed as --impersonate arg."""
        cmd, tmp = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={},
            impersonate="chrome131",
        )
        try:
            imp_idx = cmd.index("--impersonate")
            self.assertEqual(cmd[imp_idx + 1], "chrome131")
        finally:
            self._cleanup(tmp)

    def test_download_curl_cffi_command_handles_large_headers(self):
        """Even with many cookies, the command line should stay short."""
        # Simulate 200 cookies
        big_headers = {f"cookie_{i}": f"val_{i}" * 20 for i in range(200)}
        cmd, tmp = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers=big_headers,
        )
        try:
            cmd_str = " ".join(cmd)
            # Should be well under the 32767 limit
            self.assertLess(len(cmd_str), 2000, f"Command too long: {len(cmd_str)} chars")
            # Verify all headers ended up in the file, not the command
            import json as _json

            with open(tmp[0], "r", encoding="utf-8") as f:
                saved = _json.load(f)
            for k in big_headers:
                self.assertIn(k, saved)
        finally:
            self._cleanup(tmp)


class TestDirectMediaUrlHeuristic(unittest.TestCase):
    """Test the heuristic used by download_manager to decide when curl_cffi applies."""

    def _is_stream_manifest(self, url):
        """Replicate the check used in download_manager.run_download()."""
        from stream_backends import is_stream_manifest_url

        return is_stream_manifest_url(url)

    def test_direct_mp4_is_not_stream_manifest(self):
        self.assertFalse(self._is_stream_manifest("https://cdn.example.com/video.mp4"))
        self.assertFalse(self._is_stream_manifest("https://cdn.example.com/video.mp4?token=abc&expiry=123"))

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
