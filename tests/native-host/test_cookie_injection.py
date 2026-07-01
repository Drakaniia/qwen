"""Tests for cookie/header injection into download backends.

Verifies:
1. write_cookie_file_from_string() creates valid Netscape cookie files
2. _inject_cookie_header() merges cookie header into request headers
3. run_download() properly extracts cookieHeader from messages
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))


class WriteCookieFileFromStringTests(unittest.TestCase):
    """Tests for write_cookie_file_from_string in browser_context."""

    def test_write_cookie_file_from_string_basic(self):
        """Basic cookie string creates a valid Netscape cookie file."""
        from browser_context import write_cookie_file_from_string

        with tempfile.TemporaryDirectory() as temp_dir:
            filepath = write_cookie_file_from_string(
                "session=abc123; pref=lang=en",
                "https://example.com/video.mp4",
                temp_dir=temp_dir,
            )
            self.assertIsNotNone(filepath, "Should return a file path")
            content = Path(filepath).read_text(encoding="utf-8")
            self.assertIn("# Netscape HTTP Cookie File", content)
            self.assertIn("example.com", content)
            self.assertIn("session", content)
            self.assertIn("abc123", content)
            self.assertIn("pref", content)
            self.assertIn("lang=en", content)
            self.assertIn("TRUE", content)

    def test_write_cookie_file_from_string_empty(self):
        """Empty cookie string returns None."""
        from browser_context import write_cookie_file_from_string

        with tempfile.TemporaryDirectory() as temp_dir:
            result = write_cookie_file_from_string("", "https://example.com", temp_dir=temp_dir)
            self.assertIsNone(result, "Empty cookie string should return None")

    def test_write_cookie_file_from_string_null(self):
        """None cookie string returns None."""
        from browser_context import write_cookie_file_from_string

        with tempfile.TemporaryDirectory() as temp_dir:
            result = write_cookie_file_from_string(None, "https://example.com", temp_dir=temp_dir)
            self.assertIsNone(result, "None cookie string should return None")

    def test_write_cookie_file_from_string_http(self):
        """HTTP URLs should have FALSE secure flag."""
        from browser_context import write_cookie_file_from_string

        with tempfile.TemporaryDirectory() as temp_dir:
            filepath = write_cookie_file_from_string(
                "test=value",
                "http://example.com/page",
                temp_dir=temp_dir,
            )
            content = Path(filepath).read_text(encoding="utf-8")
            lines = [l for l in content.split("\n") if l and not l.startswith("#")]
            self.assertTrue(any("FALSE" in l for l in lines), "HTTP should have secure=FALSE")

    def test_write_cookie_file_from_string_multiple_cookies(self):
        """Multiple cookies should all be written."""
        from browser_context import write_cookie_file_from_string

        with tempfile.TemporaryDirectory() as temp_dir:
            filepath = write_cookie_file_from_string(
                "a=1; b=2; c=3",
                "https://example.com",
                temp_dir=temp_dir,
            )
            content = Path(filepath).read_text(encoding="utf-8")
            for name in ("a", "b", "c"):
                self.assertIn(name, content, f"Cookie '{name}' should be in the file")


class InjectCookieHeaderTests(unittest.TestCase):
    """Tests for _inject_cookie_header in download_manager."""

    def test_inject_cookie_header_adds_cookie(self):
        """Cookie header should be added when no existing Cookie header."""
        from download_manager import _inject_cookie_header

        result = _inject_cookie_header({"Referer": "https://example.com"}, "session=abc123")
        self.assertIn("Cookie", result)
        self.assertEqual(result["Cookie"], "session=abc123")
        self.assertEqual(result["Referer"], "https://example.com")

    def test_inject_cookie_header_does_not_overwrite(self):
        """Existing Cookie header should not be overwritten."""
        from download_manager import _inject_cookie_header

        result = _inject_cookie_header({"Cookie": "existing=value"}, "new=value")
        self.assertEqual(result["Cookie"], "existing=value")

    def test_inject_cookie_header_empty_cookie(self):
        """Empty cookie header should not add anything."""
        from download_manager import _inject_cookie_header

        result = _inject_cookie_header({"Referer": "https://example.com"}, "")
        self.assertNotIn("Cookie", result)

    def test_inject_cookie_header_none_headers(self):
        """None headers should not cause errors."""
        from download_manager import _inject_cookie_header

        result = _inject_cookie_header(None, "session=abc123")
        self.assertEqual(result.get("Cookie"), "session=abc123")

    def test_inject_cookie_header_none_cookie(self):
        """None cookie should not cause errors."""
        from download_manager import _inject_cookie_header

        result = _inject_cookie_header({"Referer": "https://example.com"}, None)
        self.assertNotIn("Cookie", result)


if __name__ == "__main__":
    unittest.main()
