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
        import native_paths
        import native_protocol
        import yt_dlp_adapter

        self.assertIs(host.HostError, native_protocol.HostError)
        self.assertIs(host.sanitize_filename, native_paths.sanitize_filename)
        self.assertIs(host.clean_request_headers, browser_context.clean_request_headers)
        self.assertIs(host.build_yt_dlp_command, yt_dlp_adapter.build_yt_dlp_command)
        self.assertIs(host.parse_yt_dlp_line, yt_dlp_adapter.parse_yt_dlp_line)
        self.assertIs(host.DownloadTask, download_task.DownloadTask)
        self.assertIs(host.delete_download_artifacts, artifacts.delete_download_artifacts)

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

    def test_build_yt_dlp_command_defaults_to_full_power_parallel_downloads_when_aria2c_available(self):
        command = host.build_yt_dlp_command(
            url="https://cdn.example.com/video.mp4",
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            yt_dlp_command=["yt-dlp"],
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        args = command[command.index("--downloader-args") + 1]

        self.assertEqual(command[command.index("--concurrent-fragments") + 1], str(host.MAX_FAST_CONNECTIONS))
        self.assertIn(f"--max-connection-per-server={host.MAX_FAST_CONNECTIONS}", args)
        self.assertIn(f"--split={host.MAX_FAST_CONNECTIONS}", args)
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
        self.assertIn("--max-connection-per-server=20", args)
        self.assertIn("--split=20", args)
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
