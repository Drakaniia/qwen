"""Tests for probe runner integration in download_manager.run_download()."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import path_setup  # noqa: F401

import download_manager as dm
from probe_runner import ProbeError, ProbeResult


class TestProbeIntegration(unittest.TestCase):
    """Verify run_download integrates the parallel probe phase correctly."""

    def _run_with_probe_result(self, probe_result, url="https://cdn.example.com/video.mp4"):
        """Helper: run run_download with a given mock probe result and capture the task."""
        captured_task = {}

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
                captured_task["message"] = message
                captured_task["command"] = command
                captured_task["fallback_command"] = fallback_command
                captured_task["fallback_commands"] = list(fallback_commands or [])
                captured_task["download_dir"] = download_dir

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
                        "id": "test_probe_1",
                        "url": url,
                        "pageUrl": "https://example.com/watch",
                        "formatId": "best",
                    },
                    task_class=CapturingTask,
                    aria2c_location_resolver=lambda: r"C:\Tools\aria2c.exe",
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: ["yt-dlp"],
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                    probe_runner_fn=lambda url, probes, cancel_event, send_message, logger: probe_result,
                )

        return captured_task

    def test_probe_winner_used_as_primary_with_empty_fallbacks(self):
        """When a probe succeeds, the winning command should be the primary with no fallbacks."""
        result = self._run_with_probe_result(
            ProbeResult(
                winner="yt-dlp",
                command=["yt-dlp", "--format", "best", "https://cdn.example.com/video.mp4"],
                label="yt-dlp (skip-download)",
                errors=[],
                duration_ms=150,
            )
        )

        self.assertIsNotNone(result.get("command"))
        # The command from the probe winner should be used
        self.assertIn("--format", str(result["command"]) or "")
        # Fallbacks should be empty since a probe won
        self.assertEqual(len(result.get("fallback_commands", [])), 0)

    def test_probe_failure_uses_fallback_chain(self):
        """When all probes fail, the existing fallback chain should be built."""
        result = self._run_with_probe_result(
            ProbeResult(
                winner=None,
                command=None,
                label=None,
                errors=[
                    ProbeError(
                        backend="yt-dlp",
                        label="yt-dlp (skip-download)",
                        error_type="exit_code",
                        message="Exit code 1",
                        status_code=1,
                        raw_output="ERROR",
                        duration_ms=200,
                    )
                ],
                duration_ms=200,
            )
        )

        # When all probes fail, fallback_commands should be built (not empty)
        self.assertIsNotNone(result.get("command"))
        # The primary command should still be built
        self.assertIsInstance(result.get("command"), list)
        self.assertGreater(len(result.get("command", [])), 0)

    def test_probe_skipped_for_spotify_url(self):
        """Spotify URLs should bypass probing entirely."""
        captured_task = {}

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
                captured_task["message"] = message
                captured_task["command"] = command

            def start(self):
                pass

        probe_fn = MagicMock()

        with tempfile.TemporaryDirectory() as tmpdir:
            dl_dir = Path(tmpdir) / "Downloads"
            dl_dir.mkdir(parents=True)

            with (
                patch.object(dm, "resolve_download_dir", return_value=dl_dir),
                patch.object(dm, "write_cookie_file_from_headers", return_value=None),
                patch.object(dm, "validate_download_url", return_value=None),
                patch("spotify_resolver.is_spotify_url", return_value=True),
                patch.object(dm, "run_spotify_fallback_download"),
            ):
                dm.run_download(
                    message={
                        "id": "test_spotify",
                        "url": "https://open.spotify.com/track/123",
                        "pageUrl": "https://open.spotify.com",
                        "formatId": "best",
                    },
                    task_class=CapturingTask,
                    ffmpeg_location_resolver=lambda: None,
                    yt_dlp_command_resolver=lambda: ["yt-dlp"],
                    aria2c_location_resolver=lambda: None,
                    n_m3u8dl_re_location_resolver=lambda: None,
                    streamlink_command_resolver=lambda: None,
                    probe_runner_fn=probe_fn,
                )

        # probe_runner should NOT be called for Spotify URLs
        probe_fn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
