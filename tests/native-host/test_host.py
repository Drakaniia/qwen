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
        self.assertEqual(command[command.index("--concurrent-fragments") + 1], "8")
        self.assertIn("https://cdn.example.com/master.m3u8", command)
        self.assertIn("--add-header", command)
        self.assertIn("Referer:https://example.com/watch", command)
        self.assertTrue(any(str(Path(r"C:\Users\Viewer\Downloads")) in part for part in command))

    def test_build_yt_dlp_command_places_video_inside_title_folder(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/master.m3u8",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
        )

        output_template = command[command.index("-o") + 1]

        self.assertEqual(
            output_template,
            str(Path(r"C:\Users\Viewer\Downloads") / "%(title).180B" / "%(title).180B [%(id)s].%(ext)s"),
        )

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
        self.assertIn("--max-connection-per-server=20", args)
        self.assertIn("--split=20", args)
        self.assertIn("--continue=true", args)

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
        self.assertIn("Cookie:sid=abc", command)
        self.assertIn("Origin:https://example.com Bad: nope", command)
        self.assertIn("User-Agent:Mozilla/5.0 Test", command)
        self.assertNotIn("Host:evil.example.com", command)

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

    def test_parse_progress_line_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("[download]  57.3% of 10.00MiB at 1.2MiB/s ETA 00:03")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 57.3)
        self.assertIn("57.3%", parsed["line"])

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
                },
                send=sent.append,
            )

            self.assertFalse(title_dir.exists())
            self.assertEqual(sent[0]["type"], "deletedArtifacts")
            self.assertEqual(sent[0]["deleted"], [str(title_dir)])


if __name__ == "__main__":
    unittest.main()
