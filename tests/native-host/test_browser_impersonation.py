"""Integration tests verifying curl_cffi's browser TLS impersonation.

Tests that curl_cffi correctly mimics real browser TLS/HTTP fingerprints
when downloading, by comparing impersonated vs non-impersonated requests
and verifying the fingerprint manipulation is actually working.

Usage:
    python -m pytest tests/native-host/test_browser_impersonation.py -v
    python tests/native-host/test_browser_impersonation.py -v
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / "src" / "native_host"
sys.path.insert(0, str(SRC_DIR))

import curl_cffi_adapter as cca

# ── Test endpoints ─────────────────────────────────────────────────────────
# httpbin.org is unreachable in this environment; we use tls.browserleaks.com
# for TLS fingerprint analysis and api.github.com for header/content tests.
#
# curl_cffi uses its own DNS (libcurl-based), which can differ from system DNS.
# All endpoints below have been verified to work with curl_cffi.

TLS_SCAN_URL = "https://tls.browserleaks.com/json"
GENERIC_GET_URL = "https://api.github.com"
GENERIC_BYTES_URL = "https://api.github.com/emojis"


# ── Helpers ────────────────────────────────────────────────────────────────


def _fetch_json_body(url, impersonate=None):
    """Fetch a URL and return parsed JSON body via curl_cffi."""
    from curl_cffi import requests as curl_requests

    kwargs = {"url": url, "timeout": 15}
    if impersonate:
        kwargs["impersonate"] = impersonate

    resp = curl_requests.get(**kwargs)
    resp.raise_for_status()
    return resp.json()


def _ja3_from_tls_scan(impersonate=None):
    """Fetch JA3 fingerprint from tls.browserleaks.com.

    Returns the ja3_hash string, or empty string on failure.
    """
    data = _fetch_json_body(TLS_SCAN_URL, impersonate=impersonate)
    return data.get("ja3_hash", "")


# ── Tests ──────────────────────────────────────────────────────────────────


class TestBrowserImpersonation(unittest.TestCase):
    """Verify curl_cffi changes TLS fingerprints to match browsers.

    The key assertion: an impersonated request has a *different* TLS
    fingerprint than the default curl fingerprint.  If both produce the
    same JA3, curl_cffi's impersonation is NOT working.
    """

    @classmethod
    def setUpClass(cls):
        if not cca.curl_cffi_available():
            raise unittest.SkipTest("curl_cffi not installed — skipping impersonation tests")

    def test_impersonation_changes_tls_fingerprint(self):
        """JA3 with impersonate='chrome' must differ from default (no impersonate)."""
        ja3_chrome = _ja3_from_tls_scan(impersonate="chrome")
        ja3_default = _ja3_from_tls_scan(impersonate=None)

        self.assertIsNotNone(ja3_chrome)
        self.assertIsNotNone(ja3_default)
        self.assertNotEqual(
            ja3_chrome,
            ja3_default,
            "Impersonated JA3 should differ from default curl JA3 — "
            f"both produced hash {ja3_chrome}. "
            "This means curl_cffi's TLS impersonation is NOT working.",
        )

    def test_ja3_hash_is_valid_md5_format(self):
        """JA3 fingerprint from impersonated request should be a 32-char hex string."""
        ja3_chrome = _ja3_from_tls_scan(impersonate="chrome")

        self.assertNotEqual(ja3_chrome, "", "JA3 hash should not be empty")
        self.assertRegex(
            ja3_chrome,
            r"^[a-f0-9]{32}$",
            f"JA3 hash should be a 32-char hex string, got: {ja3_chrome}",
        )

    def test_impersonation_sends_chrome_user_agent(self):
        """User-Agent header must contain Chrome/ when impersonating Chrome.

        Checks the User-Agent via TLS scan endpoint which echoes back the
        detected user-agent from the TLS handshake.
        """
        data = _fetch_json_body(TLS_SCAN_URL, impersonate="chrome")
        ua = data.get("user_agent", "")

        self.assertIn("Chrome/", ua, f"User-Agent should contain Chrome/, got: {ua}")
        self.assertIn("Safari/", ua, f"User-Agent should contain Safari/, got: {ua}")

    def test_impersonation_sends_firefox_user_agent(self):
        """User-Agent must contain Firefox/ when impersonating Firefox."""
        data = _fetch_json_body(TLS_SCAN_URL, impersonate="firefox")
        ua = data.get("user_agent", "")

        self.assertIn("Firefox/", ua, f"User-Agent should contain Firefox/, got: {ua}")
        self.assertIn("Gecko/", ua, f"User-Agent should contain Gecko/, got: {ua}")

    def test_different_browsers_produce_different_fingerprints(self):
        """Chrome and Safari impersonation must produce different JA3 hashes."""
        ja3_chrome = _ja3_from_tls_scan(impersonate="chrome")
        ja3_safari = _ja3_from_tls_scan(impersonate="safari")

        self.assertIsNotNone(ja3_chrome)
        self.assertIsNotNone(ja3_safari)
        self.assertNotEqual(
            ja3_chrome,
            ja3_safari,
            f"Chrome and Safari impersonation should produce different JA3 hashes. Both produced {ja3_chrome}.",
        )

    def test_impersonated_vs_default_ua_differs(self):
        """Impersonated Chrome UA must differ from default (no impersonation) UA."""
        data_chrome = _fetch_json_body(TLS_SCAN_URL, impersonate="chrome")
        data_default = _fetch_json_body(TLS_SCAN_URL, impersonate=None)

        ua_chrome = data_chrome.get("user_agent", "")
        ua_default = data_default.get("user_agent", "")

        self.assertNotEqual(
            ua_chrome,
            ua_default,
            f"Impersonated UA should differ from default UA. Chrome UA: {ua_chrome}, Default UA: {ua_default}",
        )
        self.assertIn("Chrome/", ua_chrome, f"Chrome UA expected, got: {ua_chrome}")


class TestDownloadImpersonation(unittest.TestCase):
    """Verify curl_cffi downloads use proper browser impersonation."""

    @classmethod
    def setUpClass(cls):
        if not cca.curl_cffi_available():
            raise unittest.SkipTest("curl_cffi not installed — skipping download tests")

    def test_download_binary_data_with_chrome(self):
        """Should download binary content (bytes) correctly with Chrome impersonation.

        Uses api.github.com/emojis which returns a ~300 KB JSON payload.
        """
        from curl_cffi import requests as curl_requests

        resp = curl_requests.get(
            GENERIC_BYTES_URL,
            impersonate="chrome",
            timeout=15,
        )
        resp.raise_for_status()
        content = resp.content

        self.assertGreater(len(content), 1000, "Should download a response of > 1 KB")
        self.assertIsInstance(content, bytes, "Content should be bytes")

    def test_download_with_referer_header(self):
        """Should successfully download with a custom Referer header."""
        from curl_cffi import requests as curl_requests

        resp = curl_requests.get(
            GENERIC_GET_URL,
            impersonate="chrome",
            headers={"Referer": "https://example.com/video-page"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        self.assertIsInstance(data, dict, "Response should be a valid JSON object")
        self.assertIn("current_user_url", data, "Should contain expected GitHub API fields")

    def test_download_tls_scan_json_with_chrome(self):
        """Should successfully fetch and parse JSON with Chrome impersonation."""
        data = _fetch_json_body(TLS_SCAN_URL, impersonate="chrome")

        self.assertIsInstance(data, dict, "Response should be valid JSON")
        self.assertIn("ja3_hash", data, "TLS scan response should contain ja3_hash")

    def test_download_streaming_large(self):
        """Should handle larger downloads (> 100 KB) with streaming."""
        import warnings

        from curl_cffi import requests as curl_requests

        resp = curl_requests.get(
            "https://api.github.com/repos/python/cpython/commits",
            impersonate="chrome",
            stream=True,
            timeout=30,
        )
        resp.raise_for_status()

        # Suppress the chunk_size warning from curl_cffi
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            chunks = list(resp.iter_content(chunk_size=8192))
        total = sum(len(c) for c in chunks)

        self.assertGreater(total, 1000, f"Should stream > 1 KB of data, got {total}")


class TestCurlCffiAdapterIntegration(unittest.TestCase):
    """Verify the adapter module correctly wraps curl_cffi with impersonation."""

    @classmethod
    def setUpClass(cls):
        if not cca.curl_cffi_available():
            raise unittest.SkipTest("curl_cffi not installed — skipping adapter tests")

    def test_fetch_page_text_uses_chrome_impersonation(self):
        """fetch_page_text should use curl_cffi with Chrome impersonation."""
        text = cca.fetch_page_text(
            TLS_SCAN_URL,
            {},
            impersonate="chrome",
        )
        self.assertIn("chrome", text.lower(), "Response should mention chrome in request context")

    def test_fetch_page_text_fallback_on_unavailable(self):
        """fetch_page_text should fall back to urllib when curl_cffi not available."""
        with unittest.mock.patch.object(cca, "curl_cffi_available", return_value=False):
            text = cca.fetch_page_text(
                TLS_SCAN_URL,
                {},
                impersonate="chrome",
            )
            # urllib fallback should get a response too
            self.assertIsInstance(text, str)
            self.assertGreater(len(text), 0)

    def test_download_curl_cffi_command_includes_impersonation(self):
        """download_curl_cffi_command should build a syntactically valid script
        that calls download_with_curl_cffi (which internally uses impersonation)."""
        cmd = cca.download_curl_cffi_command(
            url="https://example.com/video.mp4",
            output_path=r"C:\Downloads\test.mp4",
            headers={"Referer": "https://example.com/"},
        )
        script = cmd[2]

        # The impersonation is INSIDE download_with_curl_cffi, not in the script string
        self.assertIn("Referer", script, "Referer header must be in the script")
        self.assertIn("download_with_curl_cffi", script, "Script must call download function")
        self.assertIn("curl_cffi_adapter", script, "Script must import from curl_cffi_adapter")

        # Verify the script is syntactically valid Python
        try:
            compile(script, "<test>", "exec")
        except SyntaxError as exc:
            self.fail(f"Generated script has syntax error: {exc}")

    def test_download_with_curl_cffi_creates_file_correctly(self):
        """download_with_curl_cffi should stream data to a file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "downloaded.json"
            result = cca.download_with_curl_cffi(
                url=GENERIC_BYTES_URL,
                output_path=str(output),
                headers={},
            )
            self.assertEqual(result, str(output), "Should return output path on success")
            self.assertTrue(output.exists(), "Output file should exist")
            self.assertGreater(output.stat().st_size, 1000, "Should download > 1 KB")

    def test_download_with_curl_cffi_host_error_on_unreachable(self):
        """download_with_curl_cffi should raise HostError on unreachable URLs."""
        from native_protocol import HostError

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "fail.bin"
            with self.assertRaises(HostError):
                cca.download_with_curl_cffi(
                    url="https://nonexistent.invalid/file.mp4",
                    output_path=str(output),
                    headers={},
                )

    def test_curl_cffi_available_returns_true(self):
        """curl_cffi_available() should return True when curl_cffi is installed."""
        self.assertTrue(cca.curl_cffi_available())


class TestDownloadFallbackChain(unittest.TestCase):
    """Verify curl_cffi is correctly positioned in the download fallback chain."""

    def test_fallback_chain_includes_curl_cffi_label(self):
        """When downloading a direct media URL (not HLS/DASH, not YouTube),
        run_download() should include curl-cffi in the fallback command labels."""
        import importlib

        import download_manager

        importlib.reload(download_manager)

        message = {
            "id": "test-123",
            "url": "https://cdn.example.com/video.mp4",
            "title": "TestVideo",
            "requestHeaders": [],
        }

        # Pass mock resolvers directly as arguments — this avoids issues with
        # default parameter evaluation at function-definition time.
        mock_yt_dlp = unittest.mock.MagicMock(return_value="yt-dlp")
        mock_ffmpeg = unittest.mock.MagicMock(return_value="ffmpeg")
        mock_aria2c = unittest.mock.MagicMock(return_value="aria2c")
        mock_nm3u8 = unittest.mock.MagicMock(return_value=None)
        mock_streamlink = unittest.mock.MagicMock(return_value=None)

        with (
            tempfile.TemporaryDirectory() as tmpdir,
            unittest.mock.patch.object(download_manager.DownloadTask, "start"),
        ):
            message["downloadFolder"] = tmpdir
            download_manager.run_download(
                message,
                yt_dlp_command_resolver=mock_yt_dlp,
                ffmpeg_location_resolver=mock_ffmpeg,
                aria2c_location_resolver=mock_aria2c,
                n_m3u8dl_re_location_resolver=mock_nm3u8,
                streamlink_command_resolver=mock_streamlink,
            )

        # Check that the task's fallback_commands include curl-cffi
        task = download_manager.ACTIVE_DOWNLOADS.get("test-123")

        if task is None:
            self.fail("Download task was not registered in ACTIVE_DOWNLOADS")

        labels = [fb.get("label", "") for fb in task.fallback_commands]
        self.assertIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should be in fallback commands. Got labels: {labels}",
        )


if __name__ == "__main__":
    unittest.main()
