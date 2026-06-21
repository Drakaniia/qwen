"""Tests for YouTube Premium bypass (cookie passing + PO token + impersonation).

Phase 1a: YouTube Premium / YouTube Music
===========================================
Strategy (§5.1):
  - Forward full browser cookie store to yt-dlp via --cookies file
  - Use --remote-components ejs:github for PO token solving
  - Use --extractor-args generic:impersonate for fingerprint masking

These tests verify the complete command-building pipeline for YouTube
Premium URLs (www.youtube.com, music.youtube.com, youtu.be).
"""

import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native-host"))

from browser_context import (
    clean_request_headers,
    cookie_header_from_request_headers,
    parse_cookie_header,
    write_cookie_file_from_headers,
    append_browser_context_options,
)
from yt_dlp_command import (
    build_yt_dlp_command,
    build_formats_command,
    is_youtube_url,
)


class TestYouTubeUrlDetection(unittest.TestCase):
    """Verify is_youtube_url() correctly identifies YouTube domains."""

    def test_detects_www_youtube_com(self):
        self.assertTrue(is_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))

    def test_detects_music_youtube_com(self):
        self.assertTrue(is_youtube_url("https://music.youtube.com/watch?v=dQw4w9WgXcQ"))

    def test_detects_youtu_be(self):
        self.assertTrue(is_youtube_url("https://youtu.be/dQw4w9WgXcQ"))

    def test_detects_youtube_nocookie(self):
        self.assertTrue(is_youtube_url("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"))

    def test_rejects_non_youtube_urls(self):
        self.assertFalse(is_youtube_url("https://vimeo.com/123456"))
        self.assertFalse(is_youtube_url("https://example.com/video.mp4"))
        self.assertFalse(is_youtube_url(""))


class TestYouTubeCookieFile(unittest.TestCase):
    """Verify cookies from the browser are correctly written to a Netscape cookie file for yt-dlp."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def test_writes_youtube_premium_cookies_to_file(self):
        """Simulate YouTube Premium session cookies being passed from the browser."""
        request_headers = [
            {"name": "Cookie", "value": "__Secure-3PSID=abc123; SAPISID=def456; __Secure-3PAPISID=ghi789"},
            {"name": "User-Agent", "value": "Mozilla/5.0"},
        ]

        cookie_file = write_cookie_file_from_headers(
            url="https://music.youtube.com/watch?v=test",
            request_headers=request_headers,
            temp_dir=Path(self.temp_dir.name),
        )

        self.assertIsNotNone(cookie_file, "Must create a cookie file for YouTube cookies")
        self.assertTrue(Path(cookie_file).exists(), "Cookie file must exist on disk")

        content = Path(cookie_file).read_text(encoding="utf-8")
        self.assertIn("music.youtube.com", content, "Cookie file must scope to music.youtube.com")
        self.assertIn("__Secure-3PSID", content, "Must include YouTube Premium session cookie")
        self.assertIn("SAPISID", content, "Must include SAPISID cookie")
        self.assertIn("__Secure-3PAPISID", content, "Must include 3PAPISID cookie")

    def test_writes_www_youtube_cookies_to_file(self):
        """Verify cookies for www.youtube.com are scoped correctly."""
        request_headers = [
            {"name": "Cookie", "value": "CONSENT=YES+1; VISITOR_INFO1_LIVE=abc"},
        ]

        cookie_file = write_cookie_file_from_headers(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            request_headers=request_headers,
            temp_dir=Path(self.temp_dir.name),
        )

        self.assertIsNotNone(cookie_file)
        content = Path(cookie_file).read_text(encoding="utf-8")
        self.assertIn("www.youtube.com", content)
        self.assertIn("CONSENT", content)
        self.assertIn("VISITOR_INFO1_LIVE", content)

    def test_returns_none_when_no_cookies(self):
        """No cookie file should be created if the user has no cookies for the domain."""
        cookie_file = write_cookie_file_from_headers(
            url="https://music.youtube.com/watch?v=test",
            request_headers=[{"name": "User-Agent", "value": "Test"}],
            temp_dir=Path(self.temp_dir.name),
        )
        self.assertIsNone(cookie_file, "No cookie file when no Cookie header present")


class TestYouTubePremiumCommandBuild(unittest.TestCase):
    """Verify yt-dlp command includes all YouTube Premium bypass flags."""

    def test_command_includes_ejs_remote_components_for_youtube(self):
        """--remote-components ejs:github must be added for YouTube URLs."""
        command = build_yt_dlp_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            download_dir=Path("C:\\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--remote-components", command)
        ejs_idx = command.index("--remote-components")
        self.assertEqual(command[ejs_idx + 1], "ejs:github")

    def test_command_includes_generic_impersonation(self):
        """--extractor-args generic:impersonate must be added for all URLs."""
        command = build_yt_dlp_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            download_dir=Path("C:\\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--extractor-args", command)
        imp_idx = command.index("--extractor-args")
        self.assertEqual(command[imp_idx + 1], "generic:impersonate")

    def test_command_includes_cookie_file_when_provided(self):
        """--cookies must point to the cookie file path."""
        command = build_yt_dlp_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            download_dir=Path("C:\\Downloads"),
            cookies_file=r"C:\Temp\qwin-youtube-cookies.txt",
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--cookies", command)
        cookies_idx = command.index("--cookies")
        self.assertEqual(command[cookies_idx + 1], r"C:\Temp\qwin-youtube-cookies.txt")

    def test_command_omits_raw_cookie_header_when_cookie_file_provided(self):
        """When --cookies file is used, the raw Cookie header must NOT be passed."""
        command = build_yt_dlp_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            download_dir=Path("C:\\Downloads"),
            request_headers=[
                {"name": "Cookie", "value": "__Secure-3PSID=abc123"},
                {"name": "Origin", "value": "https://music.youtube.com"},
            ],
            cookies_file=r"C:\Temp\qwin-youtube-cookies.txt",
            yt_dlp_command=["yt-dlp"],
        )

        # Cookie header should NOT appear as --add-header
        cookie_add_header = [
            command[i] for i in range(len(command) - 1) if command[i] == "--add-header" and "Cookie:" in command[i + 1]
        ]
        self.assertEqual(len(cookie_add_header), 0, "Raw Cookie header must not appear when --cookies is used")

        # Other headers like Origin should still be passed
        self.assertIn("--add-header", command)
        add_headers = [command[i + 1] for i in range(len(command) - 1) if command[i] == "--add-header"]
        self.assertTrue(any("Origin:https://music.youtube.com" in h for h in add_headers))

    def test_command_includes_all_youtube_flags_together(self):
        """Complete YouTube Premium command must include ALL bypass flags."""
        command = build_yt_dlp_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            download_dir=Path("C:\\Downloads"),
            cookies_file=r"C:\Temp\qwin-cookies.txt",
            yt_dlp_command=["yt-dlp"],
        )

        command_str = " ".join(command)

        self.assertIn("--cookies", command_str, "Must include --cookies flag")
        self.assertIn("qwin-cookies.txt", command_str, "Must point to the cookie file")
        self.assertIn("--remote-components", command_str, "Must include --remote-components")
        self.assertIn("ejs:github", command_str, "Must include ejs:github PO token solver")
        self.assertIn("--extractor-args", command_str, "Must include --extractor-args")
        self.assertIn("generic:impersonate", command_str, "Must include generic:impersonate")

    def test_formats_command_includes_ejs_and_impersonation(self):
        """The formats (quality listing) command must also include YouTube bypass flags."""
        command = build_formats_command(
            url="https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            yt_dlp_command=["yt-dlp"],
        )

        command_str = " ".join(command)
        self.assertIn("--remote-components", command_str)
        self.assertIn("ejs:github", command_str)
        self.assertIn("--extractor-args", command_str)
        self.assertIn("generic:impersonate", command_str)

    def test_command_does_not_include_youtube_flags_for_non_youtube_urls(self):
        """Non-YouTube URLs should not get EJS components (but keep impersonation)."""
        command = build_yt_dlp_command(
            url="https://vimeo.com/123456",
            download_dir=Path("C:\\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        command_str = " ".join(command)
        self.assertNotIn("--remote-components", command_str, "Non-YouTube URLs must NOT include --remote-components")
        self.assertIn("--extractor-args", command_str, "Non-YouTube URLs must still include --extractor-args")
        self.assertIn("generic:impersonate", command_str, "Non-YouTube URLs must still include impersonation")


class TestCookieParsing(unittest.TestCase):
    """Verify cookie parsing handles YouTube's cookie format correctly."""

    def test_parses_secure_cookies(self):
        """YouTube uses __Secure- prefixed cookies; these must be parsed correctly.
        Cookie attributes (path, Secure, HttpOnly) are not cookie name=value pairs.
        """
        cookies = parse_cookie_header("__Secure-3PSID=abc123")
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0][0], "__Secure-3PSID")
        self.assertEqual(cookies[0][1], "abc123")

    def test_parses_multiple_youtube_cookies(self):
        """YouTube Premium session sends multiple cookies."""
        cookie_header = "__Secure-3PSID=abc123; __Secure-3PAPISID=def456; SAPISID=ghi789; PREF=fz=value"
        cookies = parse_cookie_header(cookie_header)
        cookie_names = {name for name, _ in cookies}
        self.assertIn("__Secure-3PSID", cookie_names)
        self.assertIn("__Secure-3PAPISID", cookie_names)
        self.assertIn("SAPISID", cookie_names)
        self.assertIn("PREF", cookie_names)

    def test_skips_empty_cookies(self):
        """Cookies with empty names should be skipped."""
        cookies = parse_cookie_header("=value; __Secure-3PSID=abc123")
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0][0], "__Secure-3PSID")

    def test_cookie_header_from_request_headers(self):
        """Extract the Cookie header from a list of request headers."""
        headers = [
            {"name": "Cookie", "value": "__Secure-3PSID=abc123"},
            {"name": "User-Agent", "value": "Mozilla/5.0"},
        ]
        result = cookie_header_from_request_headers(headers)
        self.assertEqual(result, "__Secure-3PSID=abc123")

    def test_clean_request_headers_strips_crlf(self):
        """Header injection via CRLF must be prevented (CRLF replaced with spaces)."""
        headers = [
            {"name": "Cookie", "value": "valid=yes\r\nInjected: nope"},
        ]
        cleaned = clean_request_headers(headers)
        self.assertTrue(len(cleaned) > 0)
        self.assertNotIn("\r\n", cleaned[0]["value"], "CRLF characters must be stripped from header values")
        self.assertIn("valid=yes", cleaned[0]["value"], "Valid part of the header must be preserved")


if __name__ == "__main__":
    unittest.main()
