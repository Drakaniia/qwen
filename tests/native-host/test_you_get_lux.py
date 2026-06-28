"""Tests for you-get and lux fallback download engine integration.

These tests follow the TDD (RED→GREEN→REFACTOR) cycle.
Tests will fail initially (RED phase) until the corresponding
code is implemented in fallback_engines.py and download_manager.py.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

# These imports will fail until the functions are implemented — RED phase
from fallback_engines import (
    download_with_lux,
    download_with_you_get,
    has_lux,
    has_you_get,
    list_formats_lux,
    list_formats_you_get,
    resolve_lux_command,
    resolve_you_get_command,
)

# Patch targets for each sub-module (used in mock patches below)
_YOU_GET = "fallback_engines.you_get_engine"
_LUX = "fallback_engines.lux_engine"
_GALLERY = "fallback_engines.gallery_dl_engine"


class TestYouGetResolution(unittest.TestCase):
    """Tests for you-get command resolution."""

    def test_resolve_you_get_command_returns_none_when_not_installed(self):
        """When you-get is not installed, resolve_you_get_command returns None."""
        with patch(_YOU_GET + ".which", return_value=None), \
             patch(_YOU_GET + ".importlib.util.find_spec", return_value=None):
            result = resolve_you_get_command()
            self.assertIsNone(result)

    def test_resolve_you_get_command_finds_binary_on_path(self):
        """When you-get binary is on PATH, return it."""
        with patch(_YOU_GET + ".which", return_value="/usr/bin/you-get"):
            result = resolve_you_get_command()
            self.assertEqual(result, ["/usr/bin/you-get"])

    def test_resolve_you_get_command_finds_python_module(self):
        """When you-get is installed as a Python module, return python -m you_get."""
        with patch(_YOU_GET + ".which", return_value=None), \
             patch(_YOU_GET + ".importlib.util.find_spec", return_value=MagicMock()):
            result = resolve_you_get_command()
            self.assertIsNotNone(result)
            self.assertIn("-m", result)
            self.assertIn("you_get", result)

    def test_has_you_get_returns_false_when_not_installed(self):
        """has_you_get returns False when you-get is unavailable."""
        with patch(_YOU_GET + ".resolve_you_get_command", return_value=None):
            self.assertFalse(has_you_get())

    def test_has_you_get_returns_true_when_installed(self):
        """has_you_get returns True when you-get is available."""
        with patch(_YOU_GET + ".resolve_you_get_command", return_value=["you-get"]):
            self.assertTrue(has_you_get())


class TestLuxResolution(unittest.TestCase):
    """Tests for lux command resolution."""

    def test_resolve_lux_command_returns_none_when_not_installed(self):
        """When lux is not installed, resolve_lux_command returns None."""
        with patch(_LUX + ".which", return_value=None):
            result = resolve_lux_command()
            self.assertIsNone(result)

    def test_resolve_lux_command_finds_binary_on_path(self):
        """When lux binary is on PATH, return it."""
        with patch(_LUX + ".which", return_value="/usr/local/bin/lux"):
            result = resolve_lux_command()
            self.assertEqual(result, ["/usr/local/bin/lux"])

    def test_has_lux_returns_false_when_not_installed(self):
        """has_lux returns False when lux is unavailable."""
        with patch(_LUX + ".resolve_lux_command", return_value=None):
            self.assertFalse(has_lux())

    def test_has_lux_returns_true_when_installed(self):
        """has_lux returns True when lux is available."""
        with patch(_LUX + ".resolve_lux_command", return_value=["lux"]):
            self.assertTrue(has_lux())


class TestYouGetFormatListing(unittest.TestCase):
    """Tests for listing formats via you-get."""

    @patch(_YOU_GET + ".subprocess.run")
    def test_list_formats_you_get_returns_none_when_not_installed(self, mock_run):
        """list_formats_you_get returns None when you-get is unavailable."""
        with patch(_YOU_GET + ".resolve_you_get_command", return_value=None):
            result = list_formats_you_get("https://www.bilibili.com/video/BV1xx411c7mD")
            self.assertIsNone(result)
        mock_run.assert_not_called()

    @patch(_YOU_GET + ".subprocess.run")
    def test_list_formats_you_get_returns_none_on_unsupported_url(self, mock_run):
        """list_formats_you_get returns None when you-get doesn't support the URL."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "Unsupported URL"
        mock_run.return_value = mock_result

        with patch(_YOU_GET + ".resolve_you_get_command", return_value=["you-get"]):
            result = list_formats_you_get("https://example.com/video.mp4")
            self.assertIsNone(result)

    @patch(_YOU_GET + ".subprocess.run")
    def test_list_formats_you_get_parses_supported_url(self, mock_run):
        """list_formats_you_get returns format list for supported URLs."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = """
Title: Test Video
Stream:
    - format: dash-hd
      container: mp4
      video-quality: 1080p
      size: 524288000
    - format: dash-flv
      container: flv
      video-quality: 720p
"""
        mock_run.return_value = mock_result

        with patch(_YOU_GET + ".resolve_you_get_command", return_value=["you-get"]):
            result = list_formats_you_get("https://www.bilibili.com/video/BV1xx411c7mD")

        self.assertIsNotNone(result)
        self.assertIsInstance(result, list)
        self.assertGreater(len(result), 0)


class TestLuxFormatListing(unittest.TestCase):
    """Tests for listing formats via lux."""

    @patch(_LUX + ".subprocess.run")
    def test_list_formats_lux_returns_none_when_not_installed(self, mock_run):
        """list_formats_lux returns None when lux is unavailable."""
        with patch(_LUX + ".resolve_lux_command", return_value=None):
            result = list_formats_lux("https://www.bilibili.com/video/BV1xx411c7mD")
            self.assertIsNone(result)
        mock_run.assert_not_called()

    @patch(_LUX + ".subprocess.run")
    def test_list_formats_lux_returns_none_on_unsupported_url(self, mock_run):
        """list_formats_lux returns None when lux doesn't support the URL."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_run.return_value = mock_result

        with patch(_LUX + ".resolve_lux_command", return_value=["lux"]):
            result = list_formats_lux("https://example.com/video.mp4")
            self.assertIsNone(result)

    @patch(_LUX + ".subprocess.run")
    def test_list_formats_lux_parses_supported_url(self, mock_run):
        """list_formats_lux returns format list for supported URLs."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = """
 Site:      bilibili.com
 Title:     Test Video
 Type:      video
 Stream:
   - Quality: 1080p
     Size: 524.29 MiB
   - Quality: 720p
     Size: 262.14 MiB
"""
        mock_run.return_value = mock_result

        with patch(_LUX + ".resolve_lux_command", return_value=["lux"]):
            result = list_formats_lux("https://www.bilibili.com/video/BV1xx411c7mD")

        self.assertIsNotNone(result)
        self.assertIsInstance(result, list)
        self.assertGreater(len(result), 0)


class TestYouGetDownload(unittest.TestCase):
    """Tests for downloading with you-get."""

    @patch(_YOU_GET + ".subprocess.Popen")
    def test_download_with_you_get_raises_when_not_installed(self, mock_popen):
        """download_with_you_get raises HostError when you-get is unavailable."""
        from fallback_engines import HostError

        with patch(_YOU_GET + ".resolve_you_get_command", return_value=None):
            with self.assertRaises(HostError):
                download_with_you_get(
                    url="https://www.bilibili.com/video/BV1xx411c7mD",
                    download_dir=Path("/tmp/downloads"),
                )
        mock_popen.assert_not_called()

    @patch(_YOU_GET + "._find_latest_file", return_value="/tmp/downloads/BV1xx411c7mD.mp4")
    @patch(_YOU_GET + ".subprocess.Popen")
    def test_download_with_you_get_starts_process(self, mock_popen, mock_find):
        """download_with_you_get starts a you-get subprocess."""
        import io

        mock_process = MagicMock()
        mock_process.stdout = io.StringIO("Download completed\n")
        mock_process.wait.return_value = 0
        mock_popen.return_value = mock_process

        with patch(_YOU_GET + ".resolve_you_get_command", return_value=["you-get"]):
            result = download_with_you_get(
                url="https://www.bilibili.com/video/BV1xx411c7mD",
                download_dir=Path("/tmp/downloads"),
            )

        self.assertEqual(result, "/tmp/downloads/BV1xx411c7mD.mp4")
        mock_popen.assert_called_once()


class TestLuxDownload(unittest.TestCase):
    """Tests for downloading with lux."""

    @patch(_LUX + ".subprocess.Popen")
    def test_download_with_lux_raises_when_not_installed(self, mock_popen):
        """download_with_lux raises HostError when lux is unavailable."""
        from fallback_engines import HostError

        with patch(_LUX + ".resolve_lux_command", return_value=None):
            with self.assertRaises(HostError):
                download_with_lux(
                    url="https://www.bilibili.com/video/BV1xx411c7mD",
                    download_dir=Path("/tmp/downloads"),
                )
        mock_popen.assert_not_called()

    @patch(_LUX + "._find_latest_file", return_value="/tmp/downloads/BV1xx411c7mD.mp4")
    @patch(_LUX + ".subprocess.Popen")
    def test_download_with_lux_starts_process(self, mock_popen, mock_find):
        """download_with_lux starts a lux subprocess."""
        import io

        mock_process = MagicMock()
        mock_process.stdout = io.StringIO("Download completed\n")
        mock_process.wait.return_value = 0
        mock_popen.return_value = mock_process

        with patch(_LUX + ".resolve_lux_command", return_value=["lux"]):
            result = download_with_lux(
                url="https://www.bilibili.com/video/BV1xx411c7mD",
                download_dir=Path("/tmp/downloads"),
            )

        self.assertEqual(result, "/tmp/downloads/BV1xx411c7mD.mp4")
        mock_popen.assert_called_once()


if __name__ == "__main__":
    unittest.main()
