import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

import native_protocol
from download_manager import build_aria2c_torrent_command, run_torrent_download
from native_paths import validate_torrent_file


class TorrentFileValidationTests(unittest.TestCase):
    """Test .torrent file path validation."""

    def test_accepts_existing_torrent_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.torrent"
            torrent_path.write_bytes(b"d8:announce")
            result = validate_torrent_file(str(torrent_path))
            self.assertEqual(result, str(torrent_path.resolve()))

    def test_rejects_empty_path(self):
        with self.assertRaises(native_protocol.HostError):
            validate_torrent_file("")

    def test_rejects_non_torrent_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            other_path = Path(tmp) / "example.mp4"
            other_path.write_bytes(b"data")
            with self.assertRaises(native_protocol.HostError):
                validate_torrent_file(str(other_path))

    def test_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.torrent"
            with self.assertRaises(native_protocol.HostError):
                validate_torrent_file(str(missing))

    def test_extension_check_is_case_insensitive(self):
        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.TORRENT"
            torrent_path.write_bytes(b"d8:announce")
            result = validate_torrent_file(str(torrent_path))
            self.assertEqual(result, str(torrent_path.resolve()))


class TorrentCommandTests(unittest.TestCase):
    """Test building aria2c commands for .torrent files."""

    def test_build_torrent_command_uses_seed_time_zero(self):
        command = build_aria2c_torrent_command(
            torrent_path=r"C:\Users\Test\Downloads\example.torrent",
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

    def test_build_torrent_command_passes_torrent_file_with_flag(self):
        torrent_path = r"C:\Users\Test\Downloads\example.torrent"
        command = build_aria2c_torrent_command(
            torrent_path=torrent_path,
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        # aria2c reads a local metainfo file via --torrent-file.
        self.assertIn("--torrent-file", command)
        self.assertEqual(command[command.index("--torrent-file") + 1], torrent_path)

    def test_build_torrent_command_sets_output_dir(self):
        command = build_aria2c_torrent_command(
            torrent_path=r"C:\Users\Test\Downloads\example.torrent",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertIn("--dir", command)
        dir_index = command.index("--dir")
        self.assertEqual(command[dir_index + 1], str(Path(r"C:\Users\Test\Downloads")))

    def test_build_torrent_command_console_output(self):
        command = build_aria2c_torrent_command(
            torrent_path=r"C:\Users\Test\Downloads\example.torrent",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            aria2c_location=r"C:\Tools\aria2c.exe",
        )

        self.assertIn("--console-log-level", command)
        self.assertEqual(command[command.index("--console-log-level") + 1], "warn")
        self.assertIn("--summary-interval", command)
        self.assertEqual(command[command.index("--summary-interval") + 1], "1")


class RunTorrentDownloadTests(unittest.TestCase):
    """Test the run_torrent_download wiring (validation + command + task)."""

    def test_run_torrent_download_starts_task_with_torrent_command(self):
        captured = {}

        class FakeTask:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def start(self):
                captured["started"] = True

        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.torrent"
            torrent_path.write_bytes(b"d8:announce")

            run_torrent_download(
                {"id": "torrent_1", "path": str(torrent_path), "downloadFolder": tmp},
                task_class=FakeTask,
                aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
            )

        self.assertTrue(captured.get("started"))
        self.assertIn("--torrent-file", captured["command"])

    def test_run_torrent_download_requires_aria2c(self):
        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.torrent"
            torrent_path.write_bytes(b"d8:announce")

            with self.assertRaises(native_protocol.HostError):
                run_torrent_download(
                    {"id": "torrent_2", "path": str(torrent_path), "downloadFolder": tmp},
                    aria2c_location_resolver=lambda: None,
                )

    def test_run_torrent_download_rejects_non_torrent(self):
        with self.assertRaises(native_protocol.HostError):
            run_torrent_download(
                {"id": "torrent_3", "path": "not_a_torrent.mp4"},
                aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
            )


if __name__ == "__main__":
    unittest.main()
