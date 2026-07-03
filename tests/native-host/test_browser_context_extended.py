"""Tests for browser context and impersonation improvements.

RED phase — these tests describe desired behavior that is NOT YET IMPLEMENTED.
They will fail until the corresponding GREEN phase implementation is written.
"""

import sys
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import MagicMock, patch

from path_setup import *


# ═══════════════════════════════════════════════════════════════════════
# 1. Browser context headers — sec-ch-ua* should be allowed
# ═══════════════════════════════════════════════════════════════════════

class TestBrowserContextSecChUaHeaders(unittest.TestCase):
    """browser_context should forward sec-ch-ua* headers for Cloudflare detection."""

    def setUp(self):
        # Re-import to get fresh module state
        import importlib
        import browser_context
        importlib.reload(browser_context)
        self.bc = browser_context

    def test_sec_ch_ua_header_is_allowed(self):
        """sec-ch-ua header should pass through clean_request_headers."""
        headers = [{"name": "sec-ch-ua", "value": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="99"'}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["name"], "Sec-Ch-Ua")

    def test_sec_ch_ua_platform_header_is_allowed(self):
        """sec-ch-ua-platform header should pass through clean_request_headers."""
        headers = [{"name": "sec-ch-ua-platform", "value": "Windows"}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["name"], "Sec-Ch-Ua-Platform")

    def test_sec_ch_ua_mobile_header_is_allowed(self):
        """sec-ch-ua-mobile header should pass through clean_request_headers."""
        headers = [{"name": "sec-ch-ua-mobile", "value": "?0"}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["name"], "Sec-Ch-Ua-Mobile")

    def test_sec_ch_ua_full_version_header_is_allowed(self):
        """sec-ch-ua-full-version header should pass through clean_request_headers."""
        headers = [{"name": "sec-ch-ua-full-version", "value": "131.0.6778.86"}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["name"], "Sec-Ch-Ua-Full-Version")

    def test_priority_header_is_allowed(self):
        """Priority header should pass through clean_request_headers."""
        headers = [{"name": "priority", "value": "u=1, i"}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["name"], "Priority")

    def test_all_sec_ch_ua_headers_together(self):
        """Multiple sec-ch-ua* headers should all pass through."""
        headers = [
            {"name": "sec-ch-ua", "value": '"Chrome";v="131"'},
            {"name": "sec-ch-ua-platform", "value": "Windows"},
            {"name": "sec-ch-ua-mobile", "value": "?0"},
            {"name": "referer", "value": "https://example.com/"},
        ]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 4)
        names = {h["name"] for h in cleaned}
        self.assertIn("Sec-Ch-Ua", names)
        self.assertIn("Sec-Ch-Ua-Platform", names)
        self.assertIn("Sec-Ch-Ua-Mobile", names)
        self.assertIn("Referer", names)

    def test_non_standard_headers_still_blocked(self):
        """Non-standard headers like x-custom should still be blocked."""
        headers = [{"name": "x-custom-token", "value": "abc123"}]
        cleaned = self.bc.clean_request_headers(headers)
        self.assertEqual(len(cleaned), 0)


# ═══════════════════════════════════════════════════════════════════════
# 2. Version-specific Chrome impersonation in probes
# ═══════════════════════════════════════════════════════════════════════

class TestVersionSpecificImpersonation(unittest.TestCase):
    """Probe functions should accept a chrome_version parameter for version-specific impersonation."""

    def test_probe_curl_cffi_accepts_chrome_version(self):
        """probe_curl_cffi should accept a chrome_version parameter."""
        from probe_backends import probe_curl_cffi

        # Mock to avoid actual network request
        with patch("probe_backends.curl_cffi_available", return_value=True), \
             patch("curl_cffi.requests.head") as mock_head:

            mock_resp = MagicMock()
            mock_resp.ok = True
            mock_resp.status_code = 200
            mock_head.return_value = mock_resp

            # Call with explicit chrome_version
            result = probe_curl_cffi(
                url="https://example.com/video.mp4",
                cancel_event=Event(),
                headers={},
                chrome_version="131",
            )

            self.assertTrue(result["ok"])
            # Verify impersonate was called with chrome131
            call_kwargs = mock_head.call_args[1]
            self.assertEqual(call_kwargs.get("impersonate"), "chrome131",
                             "Should use version-specific impersonate parameter")

    def test_probe_curl_cffi_uses_chrome_default_without_version(self):
        """probe_curl_cffi should use 'chrome' default when no version specified."""
        from probe_backends import probe_curl_cffi

        with patch("probe_backends.curl_cffi_available", return_value=True), \
             patch("curl_cffi.requests.head") as mock_head:

            mock_resp = MagicMock()
            mock_resp.ok = True
            mock_resp.status_code = 200
            mock_head.return_value = mock_resp

            result = probe_curl_cffi(
                url="https://example.com/video.mp4",
                cancel_event=Event(),
                headers={},
            )

            self.assertTrue(result["ok"])
            call_kwargs = mock_head.call_args[1]
            self.assertEqual(call_kwargs.get("impersonate"), "chrome",
                             "Should use default 'chrome' impersonate parameter")


# ═══════════════════════════════════════════════════════════════════════
# 3. curl_cffi_adapter — version-specific impersonation
# ═══════════════════════════════════════════════════════════════════════

class TestCurlCffiAdapterVersionSpecific(unittest.TestCase):
    """curl_cffi_adapter download functions should support version-specific impersonation."""

    def test_fetch_page_text_accepts_chrome_version(self):
        """fetch_page_text should pass chrome_version through to impersonation."""
        import curl_cffi_adapter as cca

        with patch.object(cca, "curl_cffi_available", return_value=True), \
             patch("curl_cffi.requests.get") as mock_get:

            mock_resp = MagicMock()
            mock_resp.content = b"<html><body>OK</body></html>"
            mock_resp.status_code = 200
            mock_get.return_value = mock_resp

            result = cca.fetch_page_text(
                url="https://example.com/",
                headers={},
                impersonate="chrome131",
            )

            self.assertTrue(len(result) > 0)
            call_kwargs = mock_get.call_args[1]
            self.assertEqual(call_kwargs.get("impersonate"), "chrome131")

    def test_download_with_curl_cffi_accepts_chrome_version(self):
        """download_with_curl_cffi should accept impersonate parameter."""
        import curl_cffi_adapter as cca

        with patch.object(cca, "curl_cffi_available", return_value=True), \
             patch("curl_cffi.requests.get") as mock_get:

            mock_resp = MagicMock()
            mock_resp.headers = {"content-length": "512"}
            mock_resp.iter_content.return_value = [b"x" * 512]
            mock_get.return_value = mock_resp

            import tempfile
            with tempfile.TemporaryDirectory() as tmpdir:
                output = Path(tmpdir) / "test.bin"
                result = cca.download_with_curl_cffi(
                    url="https://example.com/video.mp4",
                    output_path=str(output),
                    headers={},
                    impersonate="chrome131",
                )

                self.assertIsNotNone(result)
                call_kwargs = mock_get.call_args[1]
                self.assertEqual(call_kwargs.get("impersonate"), "chrome131")


# ═══════════════════════════════════════════════════════════════════════
# 4. download_curl_cffi_command — should encode chrome version in script
# ═══════════════════════════════════════════════════════════════════════

class TestDownloadCurlCffiCommandVersion(unittest.TestCase):
    """download_curl_cffi_command should encode chrome version in the generated script."""

    def test_command_includes_impersonate_parameter(self):
        """The generated script should include the impersonate parameter."""
        import curl_cffi_adapter as cca

        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\video.mp4",
            headers={},
        )

        script = cmd[2]
        # The script should contain an impersonate parameter
        self.assertIn("impersonate", script,
                      "Generated script should include impersonate parameter")


if __name__ == "__main__":
    unittest.main()
