import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

import host


class HostFormatParsingTests(unittest.TestCase):
    def test_summarize_formats_returns_title_and_sorted_video_choices(self):
        info = {
            "title": "Sample Video",
            "formats": [
                {"format_id": "audio", "ext": "m4a", "acodec": "mp4a", "vcodec": "none", "abr": 128},
                {
                    "format_id": "18",
                    "ext": "mp4",
                    "width": 640,
                    "height": 360,
                    "fps": 30,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "tbr": 700,
                    "filesize_approx": 12_000_000,
                },
                {
                    "format_id": "137",
                    "ext": "mp4",
                    "width": 1920,
                    "height": 1080,
                    "fps": 30,
                    "vcodec": "avc1",
                    "acodec": "none",
                    "tbr": 4500,
                    "filesize_approx": 98_000_000,
                },
            ],
        }

        summarized = host.summarize_formats(info)

        self.assertEqual(summarized["title"], "Sample Video")
        self.assertEqual(summarized["formats"][0]["id"], "best")
        self.assertEqual(summarized["formats"][1]["id"], "137")
        self.assertEqual(summarized["formats"][1]["label"], "1080p MP4")
        self.assertEqual(summarized["formats"][2]["id"], "18")
        self.assertIs(summarized["hasSubtitles"], False, "No subtitles in test data")

    def test_summarize_formats_includes_subtitle_data(self):
        info = {
            "title": "Video With Subs",
            "formats": [
                {
                    "format_id": "18",
                    "ext": "mp4",
                    "width": 640,
                    "height": 360,
                    "fps": 30,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "tbr": 700,
                },
            ],
            "subtitles": {
                "en": [{"url": "https://example.com/sub/en.vtt", "ext": "vtt"}],
                "es": [{"url": "https://example.com/sub/es.vtt", "ext": "vtt"}],
                "fr": [{"url": "https://example.com/sub/fr.vtt", "ext": "vtt"}],
            },
            "automatic_captions": {
                "en": [{"url": "https://example.com/auto/en.vtt", "ext": "vtt"}],
                "de": [{"url": "https://example.com/auto/de.vtt", "ext": "vtt"}],
            },
        }

        summarized = host.summarize_formats(info)

        self.assertIs(summarized["hasSubtitles"], True, "Subtitles present in data")
        self.assertEqual(summarized["subtitleLanguages"], 4, "en, es, fr, de = 4 unique languages")

    def test_summarize_formats_hides_segmented_hls_and_dash_choices(self):
        info = {
            "title": "Segmented Video",
            "formats": [
                {
                    "format_id": "hls-720",
                    "ext": "mp4",
                    "protocol": "m3u8_native",
                    "url": "https://cdn.example.com/hls/720p/index.m3u8",
                    "width": 1280,
                    "height": 720,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "tbr": 2200,
                },
                {
                    "format_id": "dash-1080",
                    "ext": "mp4",
                    "protocol": "http_dash_segments",
                    "url": "https://cdn.example.com/dash/1080p/manifest.mpd",
                    "width": 1920,
                    "height": 1080,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "tbr": 4500,
                },
                {
                    "format_id": "18",
                    "ext": "mp4",
                    "protocol": "https",
                    "url": "https://cdn.example.com/full-video.mp4",
                    "width": 640,
                    "height": 360,
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                    "tbr": 700,
                },
            ],
        }

        summarized = host.summarize_formats(info)
        format_ids = [item["id"] for item in summarized["formats"]]

        self.assertEqual(format_ids, ["best", "18"])
        self.assertEqual(summarized["formats"][0]["label"], "Best available MP4")

    def test_summarize_formats_does_not_offer_fake_best_when_only_storyboards_exist(self):
        info = {
            "title": "Storyboard Only",
            "formats": [
                {
                    "format_id": "sb0",
                    "ext": "mhtml",
                    "protocol": "mhtml",
                    "format_note": "storyboard",
                    "width": 320,
                    "height": 180,
                    "vcodec": "none",
                    "acodec": "none",
                }
            ],
        }

        summarized = host.summarize_formats(info)

        self.assertEqual(summarized["title"], "Storyboard Only")
        self.assertEqual(summarized["formats"], [])

    def test_extract_media_candidates_from_text_decodes_and_filters_reusable_media_urls(self):
        text = r"""
        var direct = "https:\/\/cdn.example.com\/media\/movie%2Emp4?token=one";
        var hls = "\/streams\/master.m3u8?token=two";
        var dash = "//cdn.example.com/dash/manifest.mpd";
        var ism = "https://cdn.example.com/live/channel.ism/Manifest";
        var ad = "https://ads.example.com/preroll.mp4";
        var segment = "https://cdn.example.com/hls/segment-00001.ts";
        var blob = "blob:https://player.example.com/abc";
        """

        candidates = host.extract_media_candidates_from_text(
            text, "https://player.example.com/player/index.php?data=abc"
        )
        urls = [item["url"] for item in candidates]
        formats = {item["url"]: item["format"] for item in candidates}

        self.assertIn("https://cdn.example.com/media/movie.mp4?token=one", urls)
        self.assertIn("https://player.example.com/streams/master.m3u8?token=two", urls)
        self.assertIn("https://cdn.example.com/dash/manifest.mpd", urls)
        self.assertIn("https://cdn.example.com/live/channel.ism/Manifest", urls)
        self.assertNotIn("https://ads.example.com/preroll.mp4", urls)
        self.assertNotIn("https://cdn.example.com/hls/segment-00001.ts", urls)
        self.assertEqual(formats["https://cdn.example.com/media/movie.mp4?token=one"], "MP4")
        self.assertEqual(formats["https://player.example.com/streams/master.m3u8?token=two"], "M3U8")
        self.assertEqual(formats["https://cdn.example.com/dash/manifest.mpd"], "MPD")
        self.assertEqual(formats["https://cdn.example.com/live/channel.ism/Manifest"], "ISM")

    def test_extract_media_candidates_from_text_builds_dynamic_loader_url(self):
        text = """
        window.PLAYER_ID = "video_abc123456";
        var loader = "https://example-player.xyz/api/xs1.php?data=";
        player.setup({ sources: { file: loader + window.PLAYER_ID } });
        """

        candidates = host.extract_media_candidates_from_text(
            text,
            "https://example-player.xyz/player/v123",
        )

        self.assertIn(
            {
                "url": "https://example-player.xyz/api/xs1.php?data=video_abc123456",
                "format": "M3U8",
                "source": "player-config",
                "confidence": 96,
            },
            candidates,
        )

    def test_extract_media_candidates_from_text_builds_mogo_loader_url(self):
        text = """
        var data = "https://example-mogo.com/loader.php?data=";
        var video_id = "uz9sj7xd3l1r";
        """

        candidates = host.extract_media_candidates_from_text(
            text,
            "https://example-mogo.com/e/uz9sj7xd3l1r",
        )

        self.assertIn(
            {
                "url": "https://example-mogo.com/loader.php?data=uz9sj7xd3l1r",
                "format": "M3U8",
                "source": "player-config",
                "confidence": 96,
            },
            candidates,
        )

    def test_handle_resolve_media_candidates_fetches_page_with_browser_headers(self):
        class FakeResponse:
            def __init__(self):
                self.headers = {"Content-Type": "text/html; charset=utf-8"}

            def read(self, _size=-1):
                return b'<script>var file="/hls/master.m3u8?token=abc";</script>'

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        requests = []

        def fake_urlopen(request, timeout):
            requests.append((request, timeout))
            return FakeResponse()

        sent = []
        with (
            patch.object(host, "urlopen", side_effect=fake_urlopen),
            patch.object(host, "send_native_message", side_effect=sent.append),
        ):
            host.handle_message(
                {
                    "type": "resolveMediaCandidates",
                    "id": "resolve_1",
                    "url": "https://player.example.com/player/index.php?data=abc",
                    "pageUrl": "https://example.com/watch/movie",
                    "userAgent": "Qwin Test Browser",
                    "requestHeaders": [{"name": "Cookie", "value": "sid=abc"}],
                }
            )

        self.assertEqual(sent[0]["type"], "mediaCandidates")
        self.assertEqual(sent[0]["id"], "resolve_1")
        self.assertEqual(sent[0]["candidates"][0]["url"], "https://player.example.com/hls/master.m3u8?token=abc")
        self.assertEqual(requests[0][0].headers["User-agent"], "Qwin Test Browser")
        self.assertEqual(requests[0][0].headers["Cookie"], "sid=abc")


if __name__ == "__main__":
    unittest.main()
