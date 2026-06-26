import io
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native-host"))

import host
import download_manager as dm


class HostDownloadTaskTests(unittest.TestCase):

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

        with (
            patch.object(download_task, "creation_flags", return_value=123),
            patch.object(download_task.subprocess, "Popen", return_value=FakeProcess()) as popen,
        ):
            task.run_process_once()

        self.assertEqual(popen.call_args.kwargs["creationflags"], 123)
        self.assertEqual(popen.call_args.kwargs["cwd"], str(Path(r"C:\Users\Viewer\Downloads")))

    def test_download_task_retries_next_fallback_after_aria2_access_refusal(self):
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
            fallback_command=None,
            fallback_commands=[
                {
                    "command": ["yt-dlp", "--no-check-certificate", "https://cdn.example.com/video.mp4"],
                    "label": "yt-dlp (no SSL check)",
                }
            ],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=sent.append,
        )

        task.run()

        self.assertEqual(
            commands[0], ["yt-dlp", "--downloader", r"C:\Tools\aria2c.exe", "https://cdn.example.com/video.mp4"]
        )
        self.assertEqual(commands[1], ["yt-dlp", "--no-check-certificate", "https://cdn.example.com/video.mp4"])
        self.assertEqual(sent[-1]["type"], "done")

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
        self.assertTrue(
            any(message.get("type") == "progress" and "N_m3u8DL-RE" in message.get("line", "") for message in sent)
        )

    def test_download_task_retries_after_ssl_verification_error(self):
        commands = []
        sent = []

        class SSLFallbackTask(host.DownloadTask):
            def run_process_once(self, command=None):
                commands.append(command)
                if len(commands) == 1:
                    self.recent_lines.append("ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
                    return 1
                return 0

        task = SSLFallbackTask(
            message={"id": "job_1"},
            command=["yt-dlp", "https://example.com/video.mp4"],
            fallback_commands=[
                {
                    "command": ["yt-dlp", "--no-check-certificate", "https://example.com/video.mp4"],
                    "label": "yt-dlp (no SSL check)",
                }
            ],
            download_dir=Path(r"C:\Users\Viewer\Downloads"),
            send=sent.append,
        )

        task.run()

        self.assertEqual(commands[0], ["yt-dlp", "https://example.com/video.mp4"])
        self.assertEqual(commands[1], ["yt-dlp", "--no-check-certificate", "https://example.com/video.mp4"])
        self.assertEqual(sent[-1]["type"], "done")
        self.assertTrue(
            any(
                message.get("type") == "progress" and "yt-dlp (no SSL check)" in message.get("line", "")
                for message in sent
            )
        )


class TestCurlCffiFallbackChain(unittest.TestCase):
    """Verify curl_cffi is included/excluded correctly in the fallback chain."""

    def _capture_fallback(self, url, format_id=None):
        """Run run_download and capture the fallback_commands list."""
        import tempfile

        captured = []

        class CapturingTask:
            def __init__(
                self,
                message,
                command,
                download_dir,
                send=None,
                fallback_command=None,
                fallback_commands=None,
                temp_files=None,
                logger=None,
            ):
                captured.extend(list(fallback_commands or []))

            def start(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dl_dir = Path(tmpdir) / "Downloads"
            dl_dir.mkdir(parents=True)

            msg = {
                "id": "test_1",
                "url": url,
                "pageUrl": "https://example.com/watch",
                "formatId": "best",
            }
            if format_id:
                msg["format"] = format_id

            with (
                patch.object(dm, "resolve_download_dir", return_value=dl_dir),
                patch.object(dm, "write_cookie_file_from_headers", return_value=None),
                patch.object(dm, "validate_download_url", return_value=None),
            ):
                dm.run_download(
                    message=msg,
                    task_class=CapturingTask,
                    aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: ["yt-dlp"],
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                )

        return captured

    def test_curl_cffi_in_fallback_for_direct_mp4(self):
        """curl-cffi should be in the fallback chain for direct .mp4 URLs."""
        fallbacks = self._capture_fallback("https://cdn.example.com/video.mp4")
        labels = [cmd.get("label", "") for cmd in fallbacks]
        self.assertIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should be in fallback for .mp4 URLs. Got: {labels}",
        )

    def test_curl_cffi_first_fallback_after_primary(self):
        """curl-cffi should be the first fallback entry (position 2 in chain)."""
        fallbacks = self._capture_fallback("https://cdn.example.com/video.mp4")
        self.assertGreater(len(fallbacks), 0)
        first_label = fallbacks[0].get("label", "")
        self.assertEqual(
            first_label,
            "curl-cffi (direct download)",
            f"First fallback should be curl-cffi. Got: {first_label}",
        )

    def test_curl_cffi_not_in_fallback_for_m3u8(self):
        """curl-cffi should NOT be in the fallback chain for HLS URLs."""
        fallbacks = self._capture_fallback("https://cdn.example.com/hls/master.m3u8", format_id="M3U8")
        labels = [cmd.get("label", "") for cmd in fallbacks]
        self.assertNotIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should NOT be in fallback for .m3u8 URLs. Got: {labels}",
        )

    def test_curl_cffi_not_in_fallback_for_mpd(self):
        """curl-cffi should NOT be in the fallback chain for DASH URLs."""
        fallbacks = self._capture_fallback("https://cdn.example.com/dash/manifest.mpd", format_id="MPD")
        labels = [cmd.get("label", "") for cmd in fallbacks]
        self.assertNotIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should NOT be in fallback for .mpd URLs. Got: {labels}",
        )

    def test_curl_cffi_in_fallback_for_webm(self):
        """curl-cffi should be in the fallback chain for .webm URLs."""
        fallbacks = self._capture_fallback("https://cdn.example.com/video.webm")
        labels = [cmd.get("label", "") for cmd in fallbacks]
        self.assertIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should be in fallback for .webm URLs. Got: {labels}",
        )

    def test_curl_cffi_not_in_fallback_for_youtube(self):
        """curl-cffi should NOT be in the fallback chain for YouTube URLs.

        YouTube URLs are handled by yt-dlp with dedicated extractors;
        curl_cffi is intended for direct CDN-style media URLs.
        """
        fallbacks = self._capture_fallback("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        labels = [cmd.get("label", "") for cmd in fallbacks]
        self.assertNotIn(
            "curl-cffi (direct download)",
            labels,
            f"curl-cffi should NOT be in fallback for YouTube URLs. Got: {labels}",
        )


class TestRunDownloadFallbackChain(unittest.TestCase):
    """Verify the fallback chain built by run_download is correct for different URL types."""

    def test_run_download_does_not_include_gallery_dl_for_cdn_url(self):
        """gallery-dl should NOT be in the fallback chain for direct CDN video URLs.

        Gallery-dl is an image/gallery site downloader (Pixiv, DeviantArt, etc.).
        It should NOT be used as a catch-all fallback for direct CDN video URLs,
        because it always fails with "Unsupported URL" for such URLs, producing
        a misleading error that replaces the real cause of failure.

        This test verifies that when downloading a direct CDN URL (like those
        used by video hosting sites), the fallback chain does not include
        gallery-dl. It will currently FAIL until the unconditional gallery-dl
        fallback is removed from download_manager.run_download().
        """
        import tempfile

        captured_fallback_commands = []

        class CapturingTask:
            def __init__(
                self,
                message,
                command,
                download_dir,
                send=None,
                fallback_command=None,
                fallback_commands=None,
                temp_files=None,
                logger=None,
            ):
                captured_fallback_commands.extend(list(fallback_commands or []))

            def start(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dl_dir = Path(tmpdir) / "Downloads"
            dl_dir.mkdir(parents=True)

            with (
                patch.object(dm, "resolve_download_dir", return_value=dl_dir),
                patch.object(dm, "write_cookie_file_from_headers", return_value=None),
                patch.object(dm, "validate_download_url", return_value=None),
            ):
                dm.run_download(
                    message={
                        "id": "test_cdn_1",
                        "url": "https://cdn.example.com/video.mp4?token=abc&expiry=123",
                        "pageUrl": "https://example.com/watch",
                        "formatId": "best",
                    },
                    task_class=CapturingTask,
                    aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: ["yt-dlp"],
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                )

        # Verify gallery-dl is NOT in the fallback chain for direct CDN URLs
        gallery_dl_entries = [
            cmd
            for cmd in captured_fallback_commands
            if "gallery-dl" in cmd.get("label", "").lower()
            or "gallery_dl" in str(cmd.get("command", []))
        ]
        self.assertEqual(
            len(gallery_dl_entries),
            0,
            f"gallery-dl should NOT be in fallback chain for CDN URLs. "
            f"Found {len(gallery_dl_entries)} entry(ies): {gallery_dl_entries}",
        )

    def test_run_download_includes_native_downloader_for_cdn_url(self):
        """yt-dlp (native downloader) should be in the fallback chain for CDN URLs.

        After removing the unconditional gallery-dl fallback, a yt-dlp variant
        without aria2c (using yt-dlp's native downloader) is added instead.
        This ensures direct CDN URLs can be downloaded even when aria2c fails.
        """
        import tempfile

        captured_fallback_commands = []

        class CapturingTask:
            def __init__(
                self,
                message,
                command,
                download_dir,
                send=None,
                fallback_command=None,
                fallback_commands=None,
                temp_files=None,
                logger=None,
            ):
                captured_fallback_commands.extend(list(fallback_commands or []))

            def start(self):
                pass

        with tempfile.TemporaryDirectory() as tmpdir:
            dl_dir = Path(tmpdir) / "Downloads"
            dl_dir.mkdir(parents=True)

            with (
                patch.object(dm, "resolve_download_dir", return_value=dl_dir),
                patch.object(dm, "write_cookie_file_from_headers", return_value=None),
                patch.object(dm, "validate_download_url", return_value=None),
            ):
                dm.run_download(
                    message={
                        "id": "test_cdn_2",
                        "url": "https://cdn.example.com/video.mp4?token=abc&expiry=123",
                        "pageUrl": "https://example.com/watch",
                        "formatId": "best",
                    },
                    task_class=CapturingTask,
                    aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: ["yt-dlp"],
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                )

        native_labels = [
            cmd.get("label", "")
            for cmd in captured_fallback_commands
            if "native downloader" in cmd.get("label", "").lower()
        ]
        self.assertGreater(
            len(native_labels),
            0,
            f"yt-dlp (native downloader) SHOULD be in fallback chain for CDN URLs. "
            f"Found {len(native_labels)} matching entries. Full chain: {captured_fallback_commands}",
        )


if __name__ == "__main__":
    unittest.main()
