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


if __name__ == "__main__":
    unittest.main()
