import io
import json
import os
import struct
import tempfile
import unittest
import threading
from pathlib import Path
from unittest.mock import patch
import sys

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native-host"))

import host


class HostHelperTests(unittest.TestCase):
    def test_native_host_uses_split_modules_for_core_logic(self):
        import artifacts
        import browser_context
        import download_task
        import folder_picker
        import media_resolver
        import native_paths
        import native_protocol
        import process_control
        import progress_parser
        import stream_backends
        import yt_dlp_command
        import yt_dlp_adapter

        self.assertIs(host.HostError, native_protocol.HostError)
        self.assertIs(host.sanitize_filename, native_paths.sanitize_filename)
        self.assertIs(host.clean_request_headers, browser_context.clean_request_headers)
        self.assertIs(host.build_yt_dlp_command, yt_dlp_adapter.build_yt_dlp_command)
        self.assertIs(host.build_yt_dlp_command, yt_dlp_command.build_yt_dlp_command)
        self.assertIs(host.parse_yt_dlp_line, yt_dlp_adapter.parse_yt_dlp_line)
        self.assertIs(host.parse_yt_dlp_line, progress_parser.parse_yt_dlp_line)
        self.assertIs(host.DownloadTask, download_task.DownloadTask)
        self.assertIs(host.delete_download_artifacts, artifacts.delete_download_artifacts)
        self.assertIs(host.creation_flags, process_control.creation_flags)
        self.assertIs(host.choose_download_folder, folder_picker.choose_download_folder)
        self.assertIs(host.extract_media_candidates_from_text, media_resolver.extract_media_candidates_from_text)
        self.assertIs(host.build_n_m3u8dl_re_command, stream_backends.build_n_m3u8dl_re_command)
        self.assertIs(host.build_streamlink_command, stream_backends.build_streamlink_command)
        self.assertIs(download_task.parse_yt_dlp_line, progress_parser.parse_yt_dlp_line)
        self.assertIs(artifacts.creation_flags, process_control.creation_flags)

    def test_sanitize_filename_removes_windows_invalid_characters(self):
        self.assertEqual(host.sanitize_filename('bad<>:"/\\|?* name'), "bad name")

    def test_sanitize_filename_uses_fallback_for_empty_name(self):
        self.assertEqual(host.sanitize_filename("...   "), "video")

    def test_validate_download_url_accepts_http_and_https_only(self):
        host.validate_download_url("https://example.com/video.m3u8")
        host.validate_download_url("http://example.com/video.mp4")

        with self.assertRaises(host.HostError):
            host.validate_download_url("blob:https://example.com/id")

        with self.assertRaises(host.HostError):
            host.validate_download_url("file:///C:/secret.mp4")

    def test_default_download_dir_uses_userprofile_downloads(self):
        env = {"USERPROFILE": r"C:\Users\Viewer"}
        self.assertEqual(
            host.default_download_dir(env),
            Path(r"C:\Users\Viewer\Downloads"),
        )

    def test_build_yt_dlp_command_uses_best_mp4_and_output_template(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            referer="https://example.com/watch",
            yt_dlp_command=["yt-dlp"],
        )

        self.assertEqual(command[0], "yt-dlp")
        self.assertIn("--ignore-config", command)
        self.assertIn("--merge-output-format", command)
        self.assertIn("--no-keep-fragments", command)
        self.assertNotIn("--prefer-ffmpeg", command)
        self.assertIn("mp4", command)
        self.assertIn("--recode-video", command)
        self.assertIn("--concurrent-fragments", command)
        self.assertEqual(command[command.index("--concurrent-fragments") + 1], str(host.MAX_FAST_CONNECTIONS))
        self.assertIn("https://cdn.example.com/master.m3u8", command)
        self.assertIn("--add-header", command)
        self.assertIn("Referer:https://example.com/watch", command)
        self.assertTrue(any(str(Path(r"C:\Users\Viewer\Downloads")) in part for part in command))

    def test_build_yt_dlp_command_enables_youtube_ejs_remote_components(self):
        command = host.build_yt_dlp_command(
            url="https://www.youtube.com/watch?v=Aa89MC8jX2c",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--remote-components", command)
        self.assertEqual(command[command.index("--remote-components") + 1], "ejs:github")

    def test_build_yt_dlp_command_enables_generic_impersonation(self):
        command = host.build_yt_dlp_command(
            url="https://example.com/protected-player",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--extractor-args", command)
        self.assertEqual(command[command.index("--extractor-args") + 1], "generic:impersonate")

    def test_build_yt_dlp_command_places_video_inside_title_folder(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        output_template = command[command.index("-o") + 1]

        self.assertEqual(
            output_template,
            "%(title).180B/%(title).180B [%(id)s].%(ext)s",
        )

    def test_build_yt_dlp_command_keeps_fragment_temp_files_with_templated_output(self):
        download_dir = Path(r"C:\Users\Viewer\Downloads")
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=download_dir,
            yt_dlp_command=["yt-dlp"],
        )

        path_values = [
            command[index + 1]
            for index, value in enumerate(command)
            if value == "--paths"
        ]
        output_template = command[command.index("-o") + 1]

        self.assertIn(f"home:{download_dir}", path_values)
        self.assertNotIn(f"temp:{download_dir}", path_values)
        self.assertEqual(output_template, "%(title).180B/%(title).180B [%(id)s].%(ext)s")

    def test_build_yt_dlp_command_supports_python_module_and_ffmpeg_location(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["C:\\Python314\\python.exe", "-m", "yt_dlp"],
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(command[:3], ["C:\\Python314\\python.exe", "-m", "yt_dlp"])
        self.assertIn("--ffmpeg-location", command)
        self.assertIn(r"C:\Tools\ffmpeg.exe", command)

    def test_build_yt_dlp_command_accepts_selected_format_id(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            selected_format="137",
        )

        format_index = command.index("-f")
        self.assertEqual(command[format_index + 1], "137+bestaudio/best")

    def test_build_yt_dlp_command_defaults_to_safe_aria2_parallel_downloads_when_available(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        args = command[command.index("--downloader-args") + 1]

        self.assertEqual(command[command.index("--concurrent-fragments") + 1], str(host.MAX_FAST_CONNECTIONS))
        self.assertIn(f"--max-connection-per-server={host.MAX_ARIA2_CONNECTIONS}", args)
        self.assertIn(f"--split={host.MAX_ARIA2_CONNECTIONS}", args)
        self.assertIn("--min-split-size=1M", args)

    def test_build_yt_dlp_command_uses_aria2c_fast_downloader_when_available(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
            concurrent_fragments=12,
            aria2_connections=20,
        )

        self.assertIn("--downloader", command)
        self.assertEqual(command[command.index("--downloader") + 1], r"C:\Tools\aria2c.exe")
        self.assertEqual(command[command.index("--concurrent-fragments") + 1], "12")

        args = command[command.index("--downloader-args") + 1]
        self.assertTrue(args.startswith("aria2c:"))
        self.assertIn(f"--max-connection-per-server={host.MAX_ARIA2_CONNECTIONS}", args)
        self.assertIn(f"--split={host.MAX_ARIA2_CONNECTIONS}", args)
        self.assertIn("--continue=true", args)

    def test_build_yt_dlp_command_keeps_hls_and_dash_on_native_fragment_downloader(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        downloader_values = [
            command[index + 1]
            for index, value in enumerate(command)
            if value == "--downloader"
        ]

        self.assertIn(r"C:\Tools\aria2c.exe", downloader_values)
        self.assertIn("dash,m3u8:native", downloader_values)

    def test_build_formats_command_uses_dump_json_without_playlist(self):
        command = host.build_formats_command(
            url="https://cdn.example.com/master.m3u8",
            referer="https://example.com/watch",
            yt_dlp_command=["yt-dlp"],
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(command[0], "yt-dlp")
        self.assertIn("--ignore-config", command)
        self.assertIn("--dump-single-json", command)
        self.assertIn("--no-playlist", command)
        self.assertIn("--add-header", command)
        self.assertIn("Referer:https://example.com/watch", command)
        self.assertIn("--ffmpeg-location", command)
        self.assertEqual(command[-1], "https://cdn.example.com/master.m3u8")

    def test_build_formats_command_enables_youtube_ejs_remote_components(self):
        command = host.build_formats_command(
            url="https://www.youtube.com/watch?v=Aa89MC8jX2c",
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--remote-components", command)
        self.assertEqual(command[command.index("--remote-components") + 1], "ejs:github")

    def test_build_formats_command_enables_generic_impersonation(self):
        command = host.build_formats_command(
            url="https://example.com/protected-player",
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--extractor-args", command)
        self.assertEqual(command[command.index("--extractor-args") + 1], "generic:impersonate")

    def test_build_yt_dlp_command_passes_sanitized_browser_headers(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            referer="https://example.com/watch",
            user_agent="Mozilla/5.0 Test",
            request_headers=[
                {"name": "Cookie", "value": "sid=abc"},
                {"name": "Origin", "value": "https://example.com\r\nBad: nope"},
                {"name": "Host", "value": "evil.example.com"},
            ],
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--user-agent", command)
        self.assertIn("Mozilla/5.0 Test", command)
        self.assertNotIn("Cookie:sid=abc", command)
        self.assertIn("Origin:https://example.com Bad: nope", command)
        self.assertIn("User-Agent:Mozilla/5.0 Test", command)
        self.assertNotIn("Host:evil.example.com", command)

    def test_build_yt_dlp_command_uses_cookie_file_instead_of_raw_cookie_header(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            request_headers=[
                {"name": "Cookie", "value": "sid=abc"},
                {"name": "Origin", "value": "https://example.com"},
            ],
            yt_dlp_command=["yt-dlp"],
            cookies_file=r"C:\Temp\qwin-cookies.txt",
        )

        self.assertIn("--cookies", command)
        self.assertEqual(command[command.index("--cookies") + 1], r"C:\Temp\qwin-cookies.txt")
        self.assertIn("Origin:https://example.com", command)
        self.assertNotIn("Cookie:sid=abc", command)

    def test_write_cookie_file_from_headers_scopes_cookies_to_url_host(self):
        with tempfile.TemporaryDirectory() as temp:
            cookie_file = host.write_cookie_file_from_headers(
                url="https://cdn.example.com/video.mp4",
                request_headers=[{"name": "Cookie", "value": "sid=abc; token=def"}],
                temp_dir=Path(temp),
            )

            content = Path(cookie_file).read_text(encoding="utf-8")

        self.assertIn("cdn.example.com\tFALSE\t/\tTRUE\t0\tsid\tabc", content)
        self.assertIn("cdn.example.com\tFALSE\t/\tTRUE\t0\ttoken\tdef", content)

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

        candidates = host.extract_media_candidates_from_text(text, "https://player.example.com/player/index.php?data=abc")
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

    def test_extract_media_candidates_from_text_builds_xtremestream_loader_url(self):
        text = """
        window.XS_VIDEO_ID = "40542c0b28735b6a870c5cf8bc13269d";
        var video_id = `40542c0b28735b6a870c5cf8bc13269d`;
        var m3u8_loader_url = `https://george.xtremestream.xyz/player/xs1.php?data=`;
        player.setup({ sources: { file: m3u8_loader_url + video_id } });
        """

        candidates = host.extract_media_candidates_from_text(
            text,
            "https://george.xtremestream.xyz/player/index.php?data=40542c0b28735b6a870c5cf8bc13269d",
        )

        self.assertIn(
            {
                "url": "https://george.xtremestream.xyz/player/xs1.php?data=40542c0b28735b6a870c5cf8bc13269d",
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
        with patch.object(host, "urlopen", side_effect=fake_urlopen), patch.object(
            host, "send_native_message", side_effect=sent.append
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

    @patch("host.shutil.which", return_value=None)
    def test_resolve_n_m3u8dl_re_location_uses_local_portable_fallback(self, _which):
        with tempfile.TemporaryDirectory() as temp:
            local_tool = Path(temp) / "tools" / "n_m3u8dl-re" / "N_m3u8DL-RE.exe"
            local_tool.parent.mkdir(parents=True)
            local_tool.write_text("portable downloader", encoding="utf-8")

            with patch.object(host, "LOCAL_N_M3U8DL_RE", local_tool), patch.dict(host.os.environ, {}, clear=True):
                self.assertEqual(host.resolve_n_m3u8dl_re_location(), str(local_tool))

    @patch("host.shutil.which", return_value=None)
    @patch("host.importlib.util.find_spec")
    def test_resolve_streamlink_command_falls_back_to_python_module(self, find_spec, _which):
        find_spec.return_value = object()

        command = host.resolve_streamlink_command()

        self.assertEqual(command, [host.sys.executable, "-m", "streamlink"])

    def test_build_n_m3u8dl_re_command_passes_headers_and_ffmpeg_path(self):
        final_path = Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4")
        command = host.build_n_m3u8dl_re_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=final_path,
            request_headers=[{"name": "Referer", "value": "https://example.com/watch"}],
            n_m3u8dl_re_location=r"C:\Tools\N_m3u8DL-RE.exe",
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(command[0], r"C:\Tools\N_m3u8DL-RE.exe")
        self.assertIn("--save-dir", command)
        self.assertIn(str(final_path.parent), command)
        self.assertIn("--save-name", command)
        self.assertIn("Movie", command)
        self.assertIn("-H", command)
        self.assertIn("Referer: https://example.com/watch", command)
        self.assertIn("--ffmpeg-binary-path", command)
        self.assertIn(r"C:\Tools\ffmpeg.exe", command)
        self.assertEqual(command[-1], "https://cdn.example.com/hls/master.m3u8")

    def test_build_streamlink_command_passes_headers_cookies_and_mp4_muxing(self):
        command = host.build_streamlink_command(
            url="https://cdn.example.com/hls/master.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4"),
            request_headers=[{"name": "Origin", "value": "https://example.com"}],
            cookies_file=r"C:\Temp\qwin-cookies.txt",
            streamlink_command=["python", "-m", "streamlink"],
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(command[:3], ["python", "-m", "streamlink"])
        self.assertIn("--http-header", command)
        self.assertIn("Origin=https://example.com", command)
        self.assertIn("--http-cookies-file", command)
        self.assertIn(r"C:\Temp\qwin-cookies.txt", command)
        self.assertIn("--ffmpeg-ffmpeg", command)
        self.assertIn("--ffmpeg-fout", command)
        self.assertIn("mp4", command)
        self.assertEqual(command[-2:], ["https://cdn.example.com/hls/master.m3u8", "best"])

    @patch("host.shutil.which", return_value=None)
    @patch("host.importlib.util.find_spec")
    def test_resolve_yt_dlp_command_falls_back_to_python_module(self, find_spec, _which):
        find_spec.return_value = object()

        command = host.resolve_yt_dlp_command()

        self.assertEqual(command, [host.sys.executable, "-m", "yt_dlp"])

    @patch("host.Path.exists", return_value=True)
    @patch("host.shutil.which", return_value=None)
    @patch("host.get_imageio_ffmpeg_exe", return_value=r"C:\Python\site-packages\ffmpeg.exe")
    def test_resolve_ffmpeg_location_uses_imageio_ffmpeg_fallback(self, _imageio, _which, _exists):
        self.assertEqual(host.resolve_ffmpeg_location(), r"C:\Python\site-packages\ffmpeg.exe")

    @patch("host.Path.exists", return_value=True)
    @patch("host.shutil.which", return_value=None)
    def test_resolve_ffmpeg_location_uses_adapter_imageio_without_recursing(self, _which, _exists):
        import yt_dlp_adapter

        with patch.object(yt_dlp_adapter, "get_imageio_ffmpeg_exe", return_value=r"C:\Python\site-packages\ffmpeg.exe"):
            self.assertEqual(host.resolve_ffmpeg_location(), r"C:\Python\site-packages\ffmpeg.exe")

    @patch("host.shutil.which", return_value=None)
    def test_resolve_aria2c_location_uses_local_portable_fallback(self, _which):
        with tempfile.TemporaryDirectory() as temp:
            local_aria2c = Path(temp) / "tools" / "aria2" / "aria2c.exe"
            local_aria2c.parent.mkdir(parents=True)
            local_aria2c.write_text("portable aria2c")

            with patch.object(host, "LOCAL_ARIA2C", local_aria2c), patch.dict(host.os.environ, {}, clear=True):
                self.assertEqual(host.resolve_aria2c_location(), str(local_aria2c))

    def test_native_message_round_trip_uses_length_prefixed_json(self):
        payload = {"type": "progress", "percent": 42.5}
        encoded = host.encode_native_message(payload)
        length = struct.unpack("=I", encoded[:4])[0]

        self.assertEqual(length, len(encoded[4:]))
        self.assertEqual(host.read_native_message(io.BytesIO(encoded)), payload)

    def test_handle_choose_folder_sends_selected_path(self):
        sent = []

        with patch.object(host, "choose_download_folder", return_value=Path(r"C:\Users\Viewer\Videos")), patch.object(
            host, "send_native_message", side_effect=sent.append
        ):
            host.handle_message({"type": "chooseFolder", "id": "folder_1", "initialFolder": r"C:\Users\Viewer\Downloads"})

        self.assertEqual(
            sent,
            [
                {
                    "type": "folder",
                    "id": "folder_1",
                    "path": r"C:\Users\Viewer\Videos",
                }
            ],
        )

    def test_handle_choose_folder_reports_cancel(self):
        sent = []

        with patch.object(host, "choose_download_folder", return_value=None), patch.object(
            host, "send_native_message", side_effect=sent.append
        ):
            host.handle_message({"type": "chooseFolder", "id": "folder_1"})

        self.assertEqual(sent, [{"type": "folder", "id": "folder_1", "canceled": True}])

    def test_main_does_not_cancel_active_downloads_when_browser_pipe_closes(self):
        with patch.object(host, "configure_binary_stdio"), patch.object(
            host, "read_native_message", side_effect=EOFError
        ), patch.object(host, "cancel_active_downloads") as cancel_active_downloads:
            result = host.main()

        self.assertEqual(result, 0)
        cancel_active_downloads.assert_not_called()

    def test_parse_progress_line_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("[download]  57.3% of 10.00MiB at 1.2MiB/s ETA 00:03")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 57.3)
        self.assertIn("57.3%", parsed["line"])
        self.assertEqual(parsed["totalSize"], "10.00MiB")
        self.assertEqual(parsed["speed"], "1.2MiB/s")
        self.assertEqual(parsed["eta"], "00:03")

    def test_parse_aria2_progress_line_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])
        self.assertEqual(parsed["downloadedSize"], "8.1MiB")
        self.assertEqual(parsed["totalSize"], "40MiB")
        self.assertEqual(parsed["connections"], 16)
        self.assertEqual(parsed["speed"], "2.0MiB/s")
        self.assertEqual(parsed["eta"], "16s")

    def test_parse_aria2_progress_line_with_leading_text_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("  [#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])

    def test_parse_aria2_fragment_status_without_percent_still_reports_download_activity(self):
        parsed = host.parse_yt_dlp_line(
            "[DL:8.2MiB][#528371 1.8MiB/0B][#d07353 1.0MiB/0B][#55c62a 1.2MiB/0B](+1)"
        )

        self.assertEqual(parsed["stage"], "download")
        self.assertNotIn("percent", parsed)
        self.assertEqual(parsed["speed"], "8.2MiB/s")
        self.assertEqual(parsed["fragment"], "3 active")
        self.assertIn("DL:8.2MiB", parsed["line"])

    def test_parse_total_fragments_line_reports_fragment_count(self):
        parsed = host.parse_yt_dlp_line("[hlsnative] Total fragments: 803")

        self.assertEqual(parsed["stage"], "extract")
        self.assertEqual(parsed["fragment"], "0/803")
        self.assertIn("Total fragments", parsed["line"])

    def test_parse_carriage_return_progress_uses_latest_status(self):
        parsed = host.parse_yt_dlp_line(
            "\r[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]"
            "\r[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]"
        )

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])

    def test_process_output_iterator_splits_carriage_return_progress(self):
        lines = list(
            host.iter_process_output_lines(
                io.StringIO(
                    "[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]\r"
                    "[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]\n"
                    "[download] 100% of 40MiB"
                )
            )
        )

        self.assertEqual(
            lines,
            [
                "[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]",
                "[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]",
                "[download] 100% of 40MiB",
            ],
        )

    def test_parse_after_move_filepath_marker(self):
        parsed = host.parse_yt_dlp_line("__QWIN_FILEPATH__:C:\\Users\\Viewer\\Downloads\\clip.mp4")

        self.assertEqual(parsed["stage"], "filepath")
        self.assertEqual(parsed["filepath"], r"C:\Users\Viewer\Downloads\clip.mp4")

    def test_parse_destination_line_extracts_filepath_and_artifact_root(self):
        parsed = host.parse_yt_dlp_line(
            r"[download] Destination: C:\Users\Viewer\Downloads\Sample Video\Sample Video [abc].f137.mp4"
        )

        self.assertEqual(parsed["stage"], "destination")
        self.assertEqual(
            parsed["filepath"],
            r"C:\Users\Viewer\Downloads\Sample Video\Sample Video [abc].f137.mp4",
        )
        self.assertEqual(parsed["artifactRoot"], r"C:\Users\Viewer\Downloads\Sample Video")

    def test_download_task_pause_terminates_active_process(self):
        class FakeProcess:
            def __init__(self):
                self.terminated = False

            def poll(self):
                return None

            def terminate(self):
                self.terminated = True

        task = host.DownloadTask(
            message={"id": "job_1"},
            command=["yt-dlp"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=lambda _message: None,
        )
        task.process = FakeProcess()
        task.state = "running"

        response = task.pause()

        self.assertEqual(response["type"], "control")
        self.assertEqual(response["status"], "pausing")
        self.assertTrue(task.pause_requested.is_set())
        self.assertTrue(task.process.terminated)

    def test_download_task_resume_releases_paused_download(self):
        task = host.DownloadTask(
            message={"id": "job_1"},
            command=["yt-dlp"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=lambda _message: None,
        )
        task.state = "paused"
        task.pause_requested.set()
        task.resume_requested = threading.Event()

        response = task.resume()

        self.assertEqual(response["type"], "resumed")
        self.assertEqual(response["status"], "running")
        self.assertFalse(task.pause_requested.is_set())
        self.assertTrue(task.resume_requested.is_set())

    def test_download_task_cancel_before_process_start_reports_canceled(self):
        sent = []

        class CancelBeforeStartTask(host.DownloadTask):
            def run_process_once(self, command=None):
                raise AssertionError("Canceled task should not start yt-dlp")

        task = CancelBeforeStartTask(
            message={"id": "job_1"},
            command=["yt-dlp"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=sent.append,
        )

        task.cancel()
        task.run()

        self.assertEqual(sent[-1]["type"], "canceled")
        self.assertEqual(sent[-1]["status"], "canceled")

    def test_download_task_cancel_removes_partial_artifact_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            download_dir = Path(temp) / "Downloads"
            title_dir = download_dir / "Sample Video"
            title_dir.mkdir(parents=True)
            partial_file = title_dir / "Sample Video [abc].mp4.part"
            fragment_file = title_dir / "Sample Video [abc].mp4.part-Frag207.part"
            state_file = title_dir / "Sample Video [abc].mp4.ytdl"
            partial_file.write_text("partial", encoding="utf-8")
            fragment_file.write_text("fragment", encoding="utf-8")
            state_file.write_text("{}", encoding="utf-8")
            sent = []

            class CancelDuringProcessTask(host.DownloadTask):
                def run_process_once(self, command=None):
                    self.current_path = str(partial_file)
                    self.artifact_root = str(title_dir)
                    self.cancel_requested.set()
                    return 1

            task = CancelDuringProcessTask(
                message={"id": "job_1"},
                command=["yt-dlp"],
                download_dir=download_dir,
                send=sent.append,
            )

            task.run()

            self.assertFalse(title_dir.exists())
            self.assertEqual(sent[-1]["type"], "canceled")
            self.assertEqual(sent[-1]["artifactCleanupDeleted"], [str(title_dir.resolve())])

    def test_download_task_keeps_running_when_browser_pipe_disconnects(self):
        class CompleteAfterDisconnectTask(host.DownloadTask):
            def run_process_once(self, command=None):
                self.final_path = r"C:\Users\Viewer\Downloads\clip.mp4"
                return 0

        def disconnected_send(_message):
            raise BrokenPipeError("native messaging pipe closed")

        task = CompleteAfterDisconnectTask(
            message={"id": "job_1"},
            command=["yt-dlp"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=disconnected_send,
        )

        task.run()

        self.assertEqual(task.state, "done")
        self.assertEqual(task.final_path, r"C:\Users\Viewer\Downloads\clip.mp4")

    def test_download_task_starts_process_with_creation_flags(self):
        import download_task

        class FakeProcess:
            stdout = io.StringIO("")

            def wait(self):
                return 0

        task = host.DownloadTask(
            message={"id": "job_1"},
            command=["yt-dlp"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=lambda _message: None,
        )

        with patch.object(download_task, "creation_flags", return_value=123), patch.object(
            download_task.subprocess, "Popen", return_value=FakeProcess()
        ) as popen:
            task.run_process_once()

        self.assertEqual(popen.call_args.kwargs["creationflags"], 123)
        self.assertEqual(popen.call_args.kwargs["cwd"], str(Path(r"C:\Users\Viewer\Downloads")))

    def test_download_task_retries_standard_command_after_aria2_access_refusal(self):
        commands = []
        sent = []

        class FallbackTask(host.DownloadTask):
            def run_process_once(self, command=None):
                commands.append(command)
                if len(commands) == 1:
                    self.recent_lines.append("ERROR: aria2c exited with code 22")
                    self.recent_lines.append("status=403")
                    return 22
                self.final_path = r"C:\Users\Viewer\Downloads\clip.mp4"
                return 0

        task = FallbackTask(
            message={"id": "job_1"},
            command=["yt-dlp", "--downloader", r"C:\Tools\aria2c.exe", "https://cdn.example.com/video.mp4"],
            fallback_command=["yt-dlp", "https://cdn.example.com/video.mp4"],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=sent.append,
        )

        task.run()

        self.assertEqual(commands[0], ["yt-dlp", "--downloader", r"C:\Tools\aria2c.exe", "https://cdn.example.com/video.mp4"])
        self.assertEqual(commands[1], ["yt-dlp", "https://cdn.example.com/video.mp4"])
        self.assertEqual(sent[-1]["type"], "done")
        self.assertTrue(any(message.get("type") == "progress" and "standard mode" in message.get("line", "") for message in sent))

    def test_download_task_retries_stream_backend_after_retryable_yt_dlp_error(self):
        commands = []
        sent = []

        class StreamFallbackTask(host.DownloadTask):
            def run_process_once(self, command=None):
                commands.append(command)
                if len(commands) == 1:
                    self.recent_lines.append("ERROR: Unsupported URL: https://cdn.example.com/hls/master.m3u8")
                    return 1
                return 0

        final_path = r"C:\Users\Viewer\Downloads\Movie\Movie.mp4"
        task = StreamFallbackTask(
            message={"id": "job_1"},
            command=["yt-dlp", "https://cdn.example.com/hls/master.m3u8"],
            fallback_commands=[
                {
                    "command": ["N_m3u8DL-RE", "https://cdn.example.com/hls/master.m3u8"],
                    "label": "N_m3u8DL-RE",
                    "final_path": final_path,
                    "artifact_root": r"C:\Users\Viewer\Downloads\Movie",
                }
            ],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=sent.append,
        )

        task.run()

        self.assertEqual(commands[0], ["yt-dlp", "https://cdn.example.com/hls/master.m3u8"])
        self.assertEqual(commands[1], ["N_m3u8DL-RE", "https://cdn.example.com/hls/master.m3u8"])
        self.assertEqual(sent[-1]["type"], "done")
        self.assertEqual(sent[-1]["filepath"], final_path)
        self.assertTrue(any(message.get("type") == "progress" and "N_m3u8DL-RE" in message.get("line", "") for message in sent))

    def test_build_open_path_command_reveals_file_on_windows(self):
        with patch.object(host.os, "name", "nt"):
            command = host.build_open_path_command(Path(r"C:\Users\Viewer\Downloads\clip.mp4"), reveal=True)

        self.assertEqual(command, ["explorer.exe", "/select,", r"C:\Users\Viewer\Downloads\clip.mp4"])

    def test_build_open_path_command_opens_folder_on_non_windows(self):
        with patch.object(host.os, "name", "posix"):
            command = host.build_open_path_command(Path("/home/viewer/Downloads"), reveal=False)

        self.assertEqual(command, ["xdg-open", "/home/viewer/Downloads"])

    def test_delete_download_artifacts_removes_title_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            download_dir = Path(temp) / "Downloads"
            title_dir = download_dir / "Sample Video"
            title_dir.mkdir(parents=True)
            final_file = title_dir / "Sample Video [abc].mp4"
            partial_file = title_dir / "Sample Video [abc].mp4.part"
            fragment_file = title_dir / "Sample Video [abc].f137.mp4"
            final_file.write_text("final", encoding="utf-8")
            partial_file.write_text("partial", encoding="utf-8")
            fragment_file.write_text("fragment", encoding="utf-8")

            sent = []
            host.delete_download_artifacts(
                {
                    "id": "delete_1",
                    "path": str(final_file),
                    "artifactRoot": str(title_dir),
                    "downloadFolder": str(download_dir),
                },
                send=sent.append,
            )

            self.assertFalse(title_dir.exists())
            self.assertEqual(sent[0]["type"], "deletedArtifacts")
            self.assertEqual(sent[0]["deleted"], [str(title_dir)])

    def test_delete_download_artifacts_uses_specific_file_when_artifact_root_is_download_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            download_dir = Path(temp) / "Downloads"
            download_dir.mkdir()
            missing_file = download_dir / "missing-video.mp4"

            sent = []
            host.delete_download_artifacts(
                {
                    "id": "delete_1",
                    "path": str(missing_file),
                    "artifactRoot": str(download_dir),
                    "downloadFolder": str(download_dir),
                },
                send=sent.append,
            )

            self.assertEqual(sent[0]["type"], "deletedArtifacts")
            self.assertEqual(sent[0]["deleted"], [])
            self.assertEqual(sent[0]["missing"], [str(missing_file)])

    def test_delete_download_artifacts_rejects_targets_outside_download_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            download_dir = Path(temp) / "Downloads"
            outside_dir = Path(temp) / "Outside"
            download_dir.mkdir()
            outside_dir.mkdir()
            outside_file = outside_dir / "keep.mp4"
            outside_file.write_text("keep", encoding="utf-8")

            with self.assertRaises(host.HostError):
                host.delete_download_artifacts(
                    {
                        "id": "delete_1",
                        "path": str(outside_file),
                        "artifactRoot": str(outside_dir),
                        "downloadFolder": str(download_dir),
                    },
                    send=lambda _message: None,
                )

            self.assertTrue(outside_file.exists())


if __name__ == "__main__":
    unittest.main()
