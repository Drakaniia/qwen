"""Tests for LL-HLS and CMAF detection (GAP 10).

Tests the is_ll_hls_url(), is_cmaf_url(), and is_low_latency_stream()
functions in stream_backends.py.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../src/native_host"))

from stream_backends import is_cmaf_url, is_ll_hls_url, is_low_latency_stream


class LlHlsCmafDetectionTests(unittest.TestCase):
    """Test suite for LL-HLS and CMAF stream detection."""

    # ─── LL-HLS detection ─────────────────────────────────────────────────

    def test_ll_hls_block_download_mode(self):
        """URL with _HLS_ms query param should be detected as LL-HLS."""
        url = "https://example.com/playlist.m3u8?_HLS_ms=1000"
        self.assertTrue(is_ll_hls_url(url))

    def test_ll_hls_delta_playlist(self):
        """URL with 'delta' in query should be detected as LL-HLS."""
        url = "https://example.com/playlist.m3u8?delta=1"
        self.assertTrue(is_ll_hls_url(url))

    def test_ll_hls_partial_segment(self):
        """URL with 'part=' query should be detected as LL-HLS."""
        url = "https://example.com/playlist.m3u8?part=1"
        self.assertTrue(is_ll_hls_url(url))

    def test_standard_hls_not_ll(self):
        """Standard HLS URL without LL params should NOT be detected as LL-HLS."""
        url = "https://example.com/stream.m3u8"
        self.assertFalse(is_ll_hls_url(url))

    def test_ll_hls_with_skip_param(self):
        """URL with skip parameter should be detected as LL-HLS."""
        url = "https://example.com/playlist.m3u8?skip=YES"
        self.assertTrue(is_ll_hls_url(url))

    def test_ll_hls_with_HLS_part_param(self):
        """URL with _HLS_part should be detected as LL-HLS."""
        url = "https://example.com/playlist.m3u8?_HLS_part=1"
        self.assertTrue(is_ll_hls_url(url))

    # ─── CMAF detection ──────────────────────────────────────────────────

    def test_cmaf_audio_extension(self):
        """URL with .cmfa extension should be detected as CMAF."""
        url = "https://example.com/stream.cmfa"
        self.assertTrue(is_cmaf_url(url))

    def test_cmaf_video_extension(self):
        """URL with .cmfv extension should be detected as CMAF."""
        url = "https://example.com/stream.cmfv"
        self.assertTrue(is_cmaf_url(url))

    def test_cmaf_path_segment(self):
        """URL with /cmaf/ in path should be detected as CMAF."""
        url = "https://cdn.example.com/cmaf/video/segment.m4s"
        self.assertTrue(is_cmaf_url(url))

    def test_standard_mp4_not_cmaf(self):
        """Standard .mp4 URL without CMAF markers should NOT be detected."""
        url = "https://example.com/video.mp4"
        self.assertFalse(is_cmaf_url(url))

    def test_standard_m3u8_not_cmaf(self):
        """Standard .m3u8 URL without CMAF markers should NOT be detected."""
        url = "https://example.com/stream.m3u8"
        self.assertFalse(is_cmaf_url(url))

    def test_cmaf_generic_cmf_extension(self):
        """URL with .cmf extension should be detected as CMAF."""
        url = "https://example.com/stream.cmf"
        self.assertTrue(is_cmaf_url(url))

    # ─── Low-latency stream detection (combined) ─────────────────────────

    def test_low_latency_ll_hls(self):
        """LL-HLS URLs should be detected by is_low_latency_stream."""
        url = "https://example.com/playlist.m3u8?_HLS_ms=500"
        self.assertTrue(is_low_latency_stream(url))

    def test_low_latency_cmaf(self):
        """CMAF URLs should be detected by is_low_latency_stream."""
        url = "https://example.com/stream.cmfv"
        self.assertTrue(is_low_latency_stream(url))

    def test_standard_url_not_low_latency(self):
        """Standard video URLs should NOT be detected as low-latency."""
        url = "https://example.com/video.mp4"
        self.assertFalse(is_low_latency_stream(url))

    def test_low_latency_empty_url(self):
        """Empty URL should not crash and return False."""
        self.assertFalse(is_low_latency_stream(""))

    def test_low_latency_with_media_format(self):
        """Non-M3U8 media format should skip LL-HLS check."""
        url = "https://example.com/playlist.m3u8?_HLS_ms=500"
        self.assertFalse(is_ll_hls_url(url, media_format="MP4"))


if __name__ == "__main__":
    unittest.main()
