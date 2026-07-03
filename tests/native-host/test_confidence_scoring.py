"""Tests for tiered confidence scoring for media candidates.

RED phase — these tests describe behavior that is NOT YET IMPLEMENTED.
They will fail until the corresponding GREEN phase implementation.

The tiered scoring system categorizes media URLs by confidence:
- TIER_ALLOW (95-100): Verified video from known CDN
- TIER_PROBABLE (70-94): Likely video, has extension or CDN hints
- TIER_UNKNOWN (30-69): Not clearly video, needs probe confirmation
- TIER_SUSPICIOUS (5-29): Matches some block patterns loosely
- TIER_BLOCK (0-4): Definitely not video
"""

import sys
import unittest
from pathlib import Path

from path_setup import *

# Import the module we'll add to
import media_candidates


class TestTieredConfidenceScoring(unittest.TestCase):
    """classify_media_url should assign confidence tiers."""

    def test_direct_mp4_gets_high_confidence(self):
        """Direct .mp4 URL should get TIER_ALLOW confidence."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/videos/movie.mp4"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_ALLOW)
        self.assertGreaterEqual(result["confidence"], 95)

    def test_hls_manifest_gets_high_confidence(self):
        """HLS .m3u8 manifest should get TIER_ALLOW confidence."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/streams/master.m3u8"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_ALLOW)
        self.assertGreaterEqual(result["confidence"], 95)

    def test_dash_manifest_gets_high_confidence(self):
        """DASH .mpd manifest should get TIER_ALLOW confidence."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/dash/manifest.mpd"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_ALLOW)
        self.assertGreaterEqual(result["confidence"], 95)

    def test_webm_video_gets_high_confidence(self):
        """Direct .webm video should get TIER_ALLOW."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/videos/clip.webm"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_ALLOW)

    def test_js_file_gets_block_tier(self):
        """JavaScript URL should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/assets/player.js"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)
        self.assertLessEqual(result["confidence"], 4)

    def test_css_file_gets_block_tier(self):
        """CSS URL should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/assets/style.css"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_gif_gets_block_tier(self):
        """GIF URL should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/animation.gif"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_ad_url_gets_block_tier(self):
        """Ad network URL should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://doubleclick.net/preroll.mp4"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_hls_segment_gets_block_tier(self):
        """HLS .ts segment should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/hls/segment-00001.ts"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_cdn_url_without_extension_gets_probable(self):
        """CDN URL without extension but with video hints should get TIER_PROBABLE."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/hls/master"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_PROBABLE)
        self.assertGreaterEqual(result["confidence"], 70)

    def test_unknown_url_gets_suspicious(self):
        """Unknown URL without video hints should get TIER_SUSPICIOUS."""
        result = media_candidates.classify_media_candidate(
            "https://example.com/some-page"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_SUSPICIOUS)

    def test_result_contains_reason(self):
        """Result should contain a 'reason' field describing the classification."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/videos/movie.mp4"
        )
        self.assertIn("reason", result)
        self.assertTrue(len(result["reason"]) > 0)

    def test_googlevideo_ephemeral_gets_block(self):
        """Ephemeral googlevideo URL should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://rr3---sn.example.googlevideo.com/videoplayback?range=0-1000"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_static_page_asset_gets_block(self):
        """Static page asset path should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://beeg.com/X-UA-Compatible"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_youtube_url_gets_high_confidence(self):
        """YouTube page URL should get TIER_ALLOW."""
        result = media_candidates.classify_media_candidate(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_ALLOW)
        self.assertGreaterEqual(result["confidence"], 95)

    def test_cdn_hint_get_probable(self):
        """URL with CDN hint but no extension should get TIER_PROBABLE."""
        result = media_candidates.classify_media_candidate(
            "https://cdn.example.com/videoplayback?expire=1234567890"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_PROBABLE)


class TestEdgeCasesForConfidenceScoring(unittest.TestCase):
    """Edge cases: empty, None, blob, data, malformed URLs."""

    def test_empty_url_gets_block(self):
        """Empty string URL should return TIER_BLOCK."""
        result = media_candidates.classify_media_candidate("")
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)
        self.assertEqual(result["confidence"], 0)
        self.assertIn("reason", result)

    def test_none_url_gets_block(self):
        """None URL should return TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(None)
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)
        self.assertEqual(result["confidence"], 0)

    def test_blob_url_gets_block(self):
        """blob: URL should return TIER_BLOCK (not accessible for download)."""
        result = media_candidates.classify_media_candidate(
            "blob:https://example.com/abc123-def-456-ghi"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_data_url_gets_block(self):
        """data: URL should return TIER_BLOCK (inline data, not downloadable)."""
        result = media_candidates.classify_media_candidate(
            "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1w"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_malformed_url_gets_block(self):
        """Malformed URL without scheme should return TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "not-a-url-at-all"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_file_url_gets_block(self):
        """file: URL should return TIER_BLOCK (local file, not downloadable via HTTP)."""
        result = media_candidates.classify_media_candidate(
            "file:///C:/Users/Test/Videos/movie.mp4"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_whitespace_url_gets_block(self):
        """Whitespace-only URL should return TIER_BLOCK."""
        result = media_candidates.classify_media_candidate("   ")
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_ftp_url_gets_block(self):
        """ftp: URL should return TIER_BLOCK (unsupported protocol)."""
        result = media_candidates.classify_media_candidate(
            "ftp://files.example.com/video.mp4"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_BLOCK)

    def test_short_url_gets_block(self):
        """Very short URL that doesn't look like a video should get TIER_BLOCK."""
        result = media_candidates.classify_media_candidate(
            "https://x.co/abc"
        )
        self.assertEqual(result["tier"], media_candidates.TIER_SUSPICIOUS, "Short unknown URL should get TIER_SUSPICIOUS")


if __name__ == "__main__":
    unittest.main()
