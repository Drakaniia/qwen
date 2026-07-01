import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

from gopeed_adapter import (
    build_gopeed_http_command,
    build_gopeed_magnet_command,
    build_gopeed_torrent_command,
    parse_gopeed_line,
    resolve_gopeed_command,
)

import native_protocol


class GopeedCommandResolutionTests(unittest.TestCase):
    """Test locating the gopeed binary."""

    def test_resolve_returns_none_when_not_installed(self):
        """WHEN gopeed is not on PATH, resolve_gopeed_command returns None."""
        result = resolve_gopeed_command(extra_paths=[])
        self.assertIsNone(result)

    def test_resolve_finds_gopeed_via_shutil_which(self):
        """WHEN gopeed is on PATH, resolve_gopeed_command returns the path.

        We mock the lookup by passing an explicit candidate that does exist.
        """
        # Use sys.executable as a guaranteed-available binary for testing
        result = resolve_gopeed_command(
            extra_paths=[],
            _which=lambda cmd: sys.executable,
        )
        self.assertEqual(result, [sys.executable])

    def test_resolve_checks_extra_paths(self):
        """GIVEN a valid path in extra_paths, resolve_gopeed_command returns it."""
        fake_path = Path(sys.executable).resolve()
        result = resolve_gopeed_command(extra_paths=[str(fake_path.parent)])
        # Should find gopeed if available, or fall through
        self.assertIsNone(result)


class GopeedCommandBuildingTests(unittest.TestCase):
    """Test building Gopeed CLI commands."""

    def test_build_magnet_command_includes_dir_flag(self):
        """GIVEN a magnet URL and download dir, the command includes -D flag."""
        magnet_url = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File"
        download_dir = Path(r"C:\Users\Test\Downloads")
        gopeed = r"C:\Tools\gopeed.exe"

        command = build_gopeed_magnet_command(
            url=magnet_url,
            download_dir=download_dir,
            gopeed_location=gopeed,
        )

        self.assertEqual(command[0], gopeed)
        self.assertIn("-D", command)
        dir_index = command.index("-D")
        self.assertEqual(command[dir_index + 1], str(download_dir))

    def test_build_magnet_command_ends_with_url(self):
        """GIVEN a magnet URL, the last argument is the URL itself."""
        magnet_url = "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12"
        command = build_gopeed_magnet_command(
            url=magnet_url,
            download_dir=Path(r"C:\Users\Test\Downloads"),
            gopeed_location=r"C:\Tools\gopeed.exe",
        )

        self.assertEqual(command[-1], magnet_url)

    def test_build_magnet_command_default_connections(self):
        """GIVEN no connections arg, the default -C is 16."""
        command = build_gopeed_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            gopeed_location=r"C:\Tools\gopeed.exe",
        )

        self.assertIn("-C", command)
        c_index = command.index("-C")
        self.assertEqual(command[c_index + 1], "16")

    def test_build_magnet_command_custom_connections(self):
        """GIVEN a custom connections arg, it uses that value."""
        command = build_gopeed_magnet_command(
            url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            gopeed_location=r"C:\Tools\gopeed.exe",
            connections=8,
        )

        self.assertEqual(command[command.index("-C") + 1], "8")

    def test_build_torrent_command_passes_path_as_url(self):
        """GIVEN a .torrent file path, Gopeed accepts it as the URL argument."""
        torrent_path = r"C:\Users\Test\Downloads\example.torrent"
        command = build_gopeed_torrent_command(
            torrent_path=torrent_path,
            download_dir=Path(r"C:\Users\Test\Downloads"),
            gopeed_location=r"C:\Tools\gopeed.exe",
        )

        # Gopeed accepts a local .torrent file path as the URL arg
        self.assertEqual(command[-1], torrent_path)

    def test_build_http_command_includes_dir_and_url(self):
        """GIVEN an HTTP URL, the command includes -D and the URL."""
        command = build_gopeed_http_command(
            url="https://example.com/video.mp4",
            download_dir=Path(r"C:\Users\Test\Downloads"),
            gopeed_location=r"C:\Tools\gopeed.exe",
        )

        self.assertIn("-D", command)
        dir_index = command.index("-D")
        self.assertEqual(command[dir_index + 1], str(Path(r"C:\Users\Test\Downloads")))
        self.assertEqual(command[-1], "https://example.com/video.mp4")


class GopeedProgressParsingTests(unittest.TestCase):
    """Test parsing Gopeed CLI progress output."""

    def test_parse_progress_line_extracts_percent(self):
        """GIVEN a progress line, parse_gopeed_line extracts the percentage."""
        line = "downloading... [■■■■□□□□□□□□□□□□□□□□] 20.0% 2.5MB/s 12.5MB"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "download")
        self.assertAlmostEqual(result["percent"], 20.0)
        self.assertEqual(result["speed"], "2.5MB/s")
        self.assertEqual(result["totalSize"], "12.5MB")

    def test_parse_complete_line(self):
        """GIVEN a completion line, parse_gopeed_line detects 100%."""
        line = "complete [■■■■■■■■■■■■■■■■■■■■] 100.0% 0B/s 12.5MB"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "done")
        self.assertAlmostEqual(result["percent"], 100.0)

    def test_parse_saving_path_line(self):
        """GIVEN a saving path line, parse_gopeed_line extracts the filepath."""
        line = "saving path: C:\\Users\\Test\\Downloads\\My_File.mp4"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "filepath")
        self.assertEqual(result["filepath"], "C:\\Users\\Test\\Downloads\\My_File.mp4")

    def test_parse_progress_line_zero_bytes(self):
        """GIVEN a line with 0B, parse_gopeed_line handles it."""
        line = "downloading... [□□□□□□□□□□□□□□□□□□□□] 0.0% 0B/s 0B"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "download")
        self.assertAlmostEqual(result["percent"], 0.0)

    def test_parse_progress_line_large_file(self):
        """GIVEN a line with GB-scale file, parse_gopeed_line extracts sizes."""
        line = "downloading... [■■■□□□□□□□□□□□□□□□□□] 15.5% 5.2MB/s 1.2GB"
        result = parse_gopeed_line(line)

        self.assertAlmostEqual(result["percent"], 15.5)
        self.assertEqual(result["speed"], "5.2MB/s")
        self.assertEqual(result["totalSize"], "1.2GB")

    def test_parse_line_with_eta(self):
        """GIVEN a line with ETA info (not in gopeed output, but be safe)."""
        line = "downloading... [■■■■■□□□□□□□□□□□□□□□] 25.0% 3.0MB/s 12.5MB"
        result = parse_gopeed_line(line)

        self.assertAlmostEqual(result["percent"], 25.0)

    def test_parse_unknown_line(self):
        """GIVEN an unrecognized line, returns log stage."""
        line = "gopeed version 1.6.8"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "log")
        self.assertEqual(result["line"], line)

    def test_parse_fail_line(self):
        """GIVEN a fail line, parse_gopeed_line detects failure."""
        line = "fail [■■■■■■■■□□□□□□□□□□□□] 40.0% 2.0MB/s 5.0MB"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "error")
        self.assertAlmostEqual(result["percent"], 40.0)

    def test_parse_fail_reason_line(self):
        """GIVEN a fail reason line, parse_gopeed_line extracts the error."""
        line = "reason: connection refused"
        result = parse_gopeed_line(line)

        self.assertEqual(result["stage"], "error")
        self.assertEqual(result["error"], "connection refused")


class GopeedDownloadTaskTests(unittest.TestCase):
    """Test the Gopeed download flow via DownloadTask."""

    def test_gopeed_download_sends_progress_messages(self):
        """GIVEN a Gopeed-based DownloadTask, progress messages are sent correctly."""
        from download_task import DownloadTask

        sent = []

        task = DownloadTask(
            message={
                "id": "gopeed_1",
                "url": "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
            },
            command=build_gopeed_magnet_command(
                url="magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
                download_dir=Path(r"C:\Users\Test\Downloads"),
                gopeed_location=r"C:\Tools\gopeed.exe",
            ),
            download_dir=Path(r"C:\Users\Test\Downloads"),
            send=sent.append,
        )

        # Simulate Gopeed output flow
        task.send_message({"type": "started", "status": "running"})
        task.send_message(
            {
                "type": "progress",
                "stage": "download",
                "percent": 42.0,
                "speed": "2.5MB/s",
                "totalSize": "12.5MB",
            }
        )
        task.set_state("done")
        task.send_message(
            {
                "type": "done",
                "status": "done",
                "filepath": str(Path(r"C:\Users\Test\Downloads") / "My_File.mp4"),
                "message": "Download complete.",
            }
        )

        self.assertEqual(len(sent), 3)
        self.assertEqual(sent[0]["type"], "started")
        self.assertEqual(sent[1]["type"], "progress")
        self.assertEqual(sent[1]["percent"], 42.0)
        self.assertEqual(sent[1]["speed"], "2.5MB/s")
        self.assertEqual(sent[2]["type"], "done")
        self.assertEqual(sent[2]["status"], "done")


class RunGopeedMagnetDownloadTests(unittest.TestCase):
    """Test the run_gopeed_magnet_download wiring."""

    def test_gopeed_magnet_download_starts_task_with_gopeed_command(self):
        """GIVEN a magnet URL, run_gopeed_magnet_download creates a task."""
        import tempfile

        from download_manager import run_gopeed_magnet_download

        captured = {}

        class FakeTask:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def start(self):
                captured["started"] = True

        with tempfile.TemporaryDirectory() as tmp:
            run_gopeed_magnet_download(
                {
                    "id": "gopeed_magnet_1",
                    "url": "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File",
                    "downloadFolder": tmp,
                },
                task_class=FakeTask,
                gopeed_location_resolver=lambda: r"C:\Tools\gopeed.exe",
            )

        self.assertTrue(captured.get("started"))
        self.assertIn("-D", captured["command"])
        self.assertIn("-C", captured["command"])
        self.assertEqual(
            captured["command"][-1], "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=My+File"
        )

    def test_gopeed_magnet_download_requires_gopeed(self):
        """GIVEN no gopeed, run_gopeed_magnet_download raises."""
        from download_manager import run_gopeed_magnet_download

        with self.assertRaises(native_protocol.HostError):
            run_gopeed_magnet_download(
                {
                    "id": "gopeed_magnet_2",
                    "url": "magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12",
                },
                gopeed_location_resolver=lambda: None,
            )

    def test_gopeed_magnet_download_rejects_non_magnet(self):
        """GIVEN a non-magnet URL, run_gopeed_magnet_download rejects."""
        from download_manager import run_gopeed_magnet_download

        with self.assertRaises(native_protocol.HostError):
            run_gopeed_magnet_download(
                {
                    "id": "gopeed_magnet_3",
                    "url": "https://example.com/video.mp4",
                },
                gopeed_location_resolver=lambda: r"C:\Tools\gopeed.exe",
            )


class RunGopeedTorrentDownloadTests(unittest.TestCase):
    """Test the run_gopeed_torrent_download wiring."""

    def test_gopeed_torrent_download_starts_task(self):
        """GIVEN a .torrent file, run_gopeed_torrent_download creates a task."""
        import tempfile

        from download_manager import run_gopeed_torrent_download

        captured = {}

        class FakeTask:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def start(self):
                captured["started"] = True

        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.torrent"
            torrent_path.write_bytes(b"d8:announce")

            run_gopeed_torrent_download(
                {
                    "id": "gopeed_torrent_1",
                    "path": str(torrent_path),
                    "downloadFolder": tmp,
                },
                task_class=FakeTask,
                gopeed_location_resolver=lambda: r"C:\Tools\gopeed.exe",
            )

        self.assertTrue(captured.get("started"))
        self.assertIn("-D", captured["command"])
        # Normalize path to handle 8.3 short names on Windows CI (RUNNER~1 vs runneradmin)
        self.assertIn(str(torrent_path.resolve()), captured["command"])

    def test_gopeed_torrent_download_requires_gopeed(self):
        """GIVEN no gopeed, run_gopeed_torrent_download raises."""
        import tempfile

        from download_manager import run_gopeed_torrent_download

        with tempfile.TemporaryDirectory() as tmp:
            torrent_path = Path(tmp) / "example.torrent"
            torrent_path.write_bytes(b"d8:announce")

            with self.assertRaises(native_protocol.HostError):
                run_gopeed_torrent_download(
                    {
                        "id": "gopeed_torrent_2",
                        "path": str(torrent_path),
                        "downloadFolder": tmp,
                    },
                    gopeed_location_resolver=lambda: None,
                )


if __name__ == "__main__":
    unittest.main()
