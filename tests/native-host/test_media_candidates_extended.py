import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

import media_candidates


class MediaCandidatesServiceWorkerAndWebSocketTests(unittest.TestCase):

    # ── Service Worker scope detection ─────────────────────────────────────

    def test_detect_service_worker_scope_sw_prefix_path(self):
        """Service Worker scope detected when initiator contains 'sw.js' or 'serviceworker.js'"""
        self.assertTrue(
            media_candidates.is_service_worker_scope(
                "https://example.com/sw.js"
            )
        )

    def test_detect_service_worker_scope_standard_paths(self):
        """Common SW file names are recognized"""
        for path in [
            "https://cdn.example.com/serviceworker.js",
            "https://player.example.com/service-worker.js",
            "https://site.com/sw.js?v=2",
            "https://streaming.example.com/worker.js",
        ]:
            with self.subTest(path=path):
                self.assertTrue(media_candidates.is_service_worker_scope(path))

    def test_detect_service_worker_scope_non_sw_urls(self):
        """Normal page URLs and CDN paths are not classified as SW scopes"""
        for path in [
            "https://example.com/video.mp4",
            "https://cdn.example.com/master.m3u8",
            "https://example.com/page.html",
            "https://fonts.googleapis.com/css",
        ]:
            with self.subTest(path=path):
                self.assertFalse(media_candidates.is_service_worker_scope(path))

    # ── WebSocket URL detection ────────────────────────────────────────────

    def test_detect_websocket_urls(self):
        """WebSocket URLs (ws:// and wss://) are correctly identified"""
        self.assertTrue(media_candidates.is_websocket_url("wss://example.com/live-stream"))
        self.assertTrue(media_candidates.is_websocket_url("ws://chat.example.com:8080/video"))
        self.assertFalse(media_candidates.is_websocket_url("https://example.com/video.mp4"))
        self.assertFalse(media_candidates.is_websocket_url("http://example.com/stream.m3u8"))

    # ── SW-scoped video content detection ──────────────────────────────────

    def test_classify_video_from_service_worker(self):
        """Content-Type from SW-scoped requests is classified correctly"""
        self.assertEqual(
            media_candidates.classify_media_url(
                "https://cdn.example.com/segment.mp4",
                "video/mp4",
            ),
            "MP4",
        )
        self.assertEqual(
            media_candidates.classify_media_url(
                "https://cdn.example.com/live.m3u8",
                "application/vnd.apple.mpegurl",
            ),
            "M3U8",
        )


if __name__ == "__main__":
    unittest.main()
