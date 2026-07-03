import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from path_setup import *

import host


class HostCommandsTests(unittest.TestCase):
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

    def test_build_yt_dlp_command_supports_nocheckcertificate(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            nocheckcertificate=True,
        )

        self.assertIn("--no-check-certificate", command)

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

        path_values = [command[index + 1] for index, value in enumerate(command) if value == "--paths"]
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

    def test_build_yt_dlp_command_includes_subtitle_flags(self):
        command = host.build_yt_dlp_command(
            url="https://www.youtube.com/watch?v=Aa89MC8jX2c",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--write-subs", command)
        self.assertIn("--write-auto-subs", command)
        self.assertIn("--sub-langs", command)
        self.assertEqual(command[command.index("--sub-langs") + 1], "all")
        self.assertIn("--embed-subs", command)

    def test_build_yt_dlp_command_skips_subtitle_flags_for_audio_extraction(self):
        command = host.build_yt_dlp_command(
            url="https://www.youtube.com/watch?v=Aa89MC8jX2c",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            extract_audio=True,
            audio_format="mp3",
        )

        self.assertNotIn("--write-subs", command)
        self.assertNotIn("--write-auto-subs", command)
        self.assertNotIn("--sub-langs", command)
        self.assertNotIn("--embed-subs", command)

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
            aria2_connections=16,
        )

        self.assertIn("--downloader", command)
        self.assertEqual(command[command.index("--downloader") + 1], r"C:\Tools\aria2c.exe")
        self.assertEqual(command[command.index("--concurrent-fragments") + 1], "12")

        args = command[command.index("--downloader-args") + 1]
        self.assertTrue(args.startswith("aria2c:"))
        self.assertIn("--max-connection-per-server=16", args)
        self.assertIn("--split=16", args)
        self.assertIn("--continue=true", args)

    def test_build_yt_dlp_command_keeps_hls_and_dash_on_native_fragment_downloader(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        downloader_values = [command[index + 1] for index, value in enumerate(command) if value == "--downloader"]

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

    def test_resolve_n_m3u8dl_re_location_uses_local_portable_fallback(self):
        with patch("host.shutil.which", return_value=None):
            with tempfile.TemporaryDirectory() as temp:
                local_tool = Path(temp) / "tools" / "n_m3u8dl-re" / "N_m3u8DL-RE.exe"
                local_tool.parent.mkdir(parents=True)
                local_tool.write_text("portable downloader", encoding="utf-8")

                with patch.object(host, "LOCAL_N_M3U8DL_RE", local_tool), patch.dict(host.os.environ, {}, clear=True):
                    self.assertEqual(host.resolve_n_m3u8dl_re_location(), str(local_tool))

    def test_resolve_streamlink_command_falls_back_to_python_module(self):
        with (
            patch("host.shutil.which", return_value=None),
            patch("host.importlib.util.find_spec", return_value=object()),
        ):
            command = host.resolve_streamlink_command()
            self.assertEqual(command, [host.sys.executable, "-m", "streamlink"])

    def test_resolve_yt_dlp_command_falls_back_to_python_module(self):
        with (
            patch("host.shutil.which", return_value=None),
            patch("host.importlib.util.find_spec", return_value=object()),
        ):
            command = host.resolve_yt_dlp_command()
            self.assertEqual(command, [host.sys.executable, "-m", "yt_dlp"])

    def test_resolve_ffmpeg_location_uses_imageio_ffmpeg_fallback(self):
        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("host.shutil.which", return_value=None),
            patch("host.get_imageio_ffmpeg_exe", return_value=r"C:\Python\site-packages\ffmpeg.exe"),
        ):
            self.assertEqual(host.resolve_ffmpeg_location(), r"C:\Python\site-packages\ffmpeg.exe")

    def test_resolve_ffmpeg_location_uses_adapter_imageio_without_recursing(self):
        import yt_dlp_adapter

        with (
            patch("pathlib.Path.exists", return_value=True),
            patch("host.shutil.which", return_value=None),
            patch.object(yt_dlp_adapter, "get_imageio_ffmpeg_exe", return_value=r"C:\Python\site-packages\ffmpeg.exe"),
        ):
            self.assertEqual(host.resolve_ffmpeg_location(), r"C:\Python\site-packages\ffmpeg.exe")

    def test_resolve_aria2c_location_uses_local_portable_fallback(self):
        with patch("host.shutil.which", return_value=None):
            with tempfile.TemporaryDirectory() as temp:
                local_aria2c = Path(temp) / "tools" / "aria2" / "aria2c.exe"
                local_aria2c.parent.mkdir(parents=True)
                local_aria2c.write_text("portable aria2c")

                with patch.object(host, "LOCAL_ARIA2C", local_aria2c), patch.dict(host.os.environ, {}, clear=True):
                    self.assertEqual(host.resolve_aria2c_location(), str(local_aria2c))


if __name__ == "__main__":
    unittest.main()
