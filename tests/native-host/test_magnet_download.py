import unittest
from pathlib import Path

from path_setup import *

import native_protocol
from download_manager import build_aria2c_magnet_command
from download_task import DownloadTask
from native_paths import validate_magnet_url


class MagnetValidationTests(unittest.TestCase):
    """Test magnet URL validation."""

    def test_valid_magnet_link_with_info_hash(self):
        url = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File&tr=udp://tracker.example.com:6969/announce"
        result = validate_magnet_url(url)
        self.assertEqual(result, url)

    def test_valid_magnet_link_minimal(self):
        url = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12"
        result = validate_magnet_url(url)
        self.assertEqual(result, url)

    def test_rejects_empty_url(self):
        with self.assertRaises(native_protocol.HostError):
            validate_magnet_url("")

    def test_rejects_non_magnet_url(self):
        with self.assertRaises(native_protocol.HostError):
            validate_magnet_url("https://example.com/video.mp4")

    def test_rejects_non_magnet_url_with_invalid_xt_param(self):
        with self.assertRaises(native_protocol.HostError):
            validate_magnet_url("magnet:?xt=somethingelse:abc123")

    def test_rejects_magnet_with_empty_info_hash(self):
        with self.assertRaises(native_protocol.HostError):
            validate_magnet_url("magnet:?xt=urn:btih:")


class MagnetCommandTests(unittest.TestCase):
    """Test building aria2c commands for magnet links."""

    def test_build_magnet_command_uses_seed_time_zero(self):
        command = build_aria2c_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertEqual(command[0], r"C:\Tools\aria2c.exe")
        self.assertIn("--seed-time", command)
        self.assertEqual(command[command.index("--seed-time") + 1], "0")
        self.assertIn("--continue", command)
        self.assertEqual(command[command.index("--continue") + 1], "true")
        self.assertIn("--file-allocation", command)
        self.assertEqual(command[command.index("--file-allocation") + 1], "none")

    def test_build_magnet_command_includes_magnet_url(self):
        magnet_url = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File"
        command = build_aria2c_magnet_command(
            url=magnet_url,
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertEqual(command[-1], magnet_url)

    def test_build_magnet_command_sets_output_dir(self):
        command = build_aria2c_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertIn("--dir", command)
        dir_index = command.index("--dir")
        self.assertEqual(command[dir_index + 1], str(Path(r"C:\Users\Test\Downloads")))

    def test_build_magnet_command_bt_max_peers_default(self):
        command = build_aria2c_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertIn("--bt-max-peers", command)
        peers_index = command.index("--bt-max-peers")
        # Optimized from 50 to 100 for faster swarm discovery
        self.assertEqual(command[peers_index + 1], "100")

    def test_build_magnet_command_console_output(self):
        command = build_aria2c_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertIn("--console-log-level", command)
        self.assertEqual(command[command.index("--console-log-level") + 1], "warn")
        self.assertIn("--summary-interval", command)
        self.assertEqual(command[command.index("--summary-interval") + 1], "1")
        self.assertIn("--enable-color", command)
        self.assertEqual(command[command.index("--enable-color") + 1], "false")
        self.assertIn("--human-readable", command)
        self.assertEqual(command[command.index("--human-readable") + 1], "true")


class MagnetDownloadTaskTests(unittest.TestCase):
    """Test the full magnet download flow via DownloadTask."""

    def test_magnet_download_sends_progress_messages(self):
        sent = []

        # Create a DownloadTask that simulates aria2c output
        task = DownloadTask(
            message={"id": "magnet_1", "url": "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12"},
            command=[
                "aria2c",
                "--seed-time=0",
                "--dir",
                str(Path(r"C:\Users\Test\Downloads")),
                "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            ],
            download_dir=Path(r"C:\Users\Test\Downloads"),
            send=sent.append,
        )

        # Simulate aria2c progress output
        task.send_message({"type": "started", "status": "running"})
        task.send_message({"type": "progress", "stage": "download", "percent": 42.0, "speed": "2.0MiB/s", "eta": "30s"})
        task.set_state("done")
        task.send_message(
            {
                "type": "done",
                "status": "done",
                "filepath": str(Path(r"C:\Users\Test\Downloads") / "My_File" / "My_File.mp4"),
                "message": "Download complete.",
            }
        )

        # Verify the message flow
        self.assertEqual(len(sent), 3)
        self.assertEqual(sent[0]["type"], "started")
        self.assertEqual(sent[1]["type"], "progress")
        self.assertEqual(sent[1]["percent"], 42.0)
        self.assertEqual(sent[2]["type"], "done")
        self.assertEqual(sent[2]["status"], "done")


if __name__ == "__main__":
    unittest.main()
