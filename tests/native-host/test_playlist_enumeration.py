"""Tests for native-host playlist enumeration via yt-dlp --flat-playlist."""

import json
import subprocess
import unittest
from unittest.mock import MagicMock, patch, call

# Ensure the native-host module is importable
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src" / "native-host"))


class TestPlaylistEnumeration(unittest.TestCase):
    """Tests for run_playlist_enumeration in format_list.py."""

    def setUp(self):
        self.request_id = "test_enum_001"
        self.message = {
            "id": self.request_id,
            "url": "https://www.youtube.com/playlist?list=PLTEST123",
            "pageUrl": "https://www.youtube.com/playlist?list=PLTEST123",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Test",
        }

    @patch("format_list.subprocess.run")
    @patch("format_list.resolve_yt_dlp_command")
    @patch("format_list.resolve_ffmpeg_location")
    @patch("format_list.write_cookie_file_from_headers")
    def test_parse_single_playlist_item(
        self,
        mock_write_cookies,
        mock_resolve_ffmpeg,
        mock_resolve_yt_dlp,
        mock_subprocess_run,
    ):
        """Test that a single playlist item is parsed correctly."""
        from format_list import run_playlist_enumeration

        mock_resolve_yt_dlp.return_value = ["yt-dlp"]
        mock_resolve_ffmpeg.return_value = None
        mock_write_cookies.return_value = None

        # Mock subprocess output: one JSON line per item
        mock_completed = MagicMock(spec=subprocess.CompletedProcess)
        mock_completed.returncode = 0
        mock_completed.stdout = json.dumps(
            {
                "id": "dQw4w9WgXcQ",
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "title": "Rick Astley - Never Gonna Give You Up",
                "duration": 212,
                "playlist_title": "My Test Playlist",
                "playlist_id": "PLTEST123",
            }
        )
        mock_completed.stderr = ""
        mock_subprocess_run.return_value = mock_completed

        send_calls = []

        def mock_send(message):
            send_calls.append(message)

        run_playlist_enumeration(
            self.message,
            send=mock_send,
            yt_dlp_command_resolver=mock_resolve_yt_dlp,
            ffmpeg_location_resolver=mock_resolve_ffmpeg,
        )

        self.assertEqual(len(send_calls), 1, "Should send exactly one response")
        response = send_calls[0]

        self.assertEqual(response["type"], "playlistItems")
        self.assertEqual(response["id"], self.request_id)
        self.assertEqual(response["ok"], True)
        self.assertEqual(response["totalItems"], 1)
        self.assertEqual(response["playlistTitle"], "My Test Playlist")
        self.assertEqual(len(response["items"]), 1)
        self.assertEqual(response["items"][0]["id"], "dQw4w9WgXcQ")
        self.assertEqual(
            response["items"][0]["url"],
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
        self.assertEqual(
            response["items"][0]["title"],
            "Rick Astley - Never Gonna Give You Up",
        )
        self.assertEqual(response["items"][0]["duration"], 212)

    @patch("format_list.subprocess.run")
    @patch("format_list.resolve_yt_dlp_command")
    @patch("format_list.resolve_ffmpeg_location")
    @patch("format_list.write_cookie_file_from_headers")
    def test_parse_multiple_playlist_items(
        self,
        mock_write_cookies,
        mock_resolve_ffmpeg,
        mock_resolve_yt_dlp,
        mock_subprocess_run,
    ):
        """Test that multiple playlist items are parsed correctly."""
        from format_list import run_playlist_enumeration

        mock_resolve_yt_dlp.return_value = ["yt-dlp"]
        mock_resolve_ffmpeg.return_value = None
        mock_write_cookies.return_value = None

        # Multiple items, each on its own line
        item1 = json.dumps(
            {
                "id": "video1",
                "url": "https://www.youtube.com/watch?v=video1",
                "title": "First Video",
                "duration": 120,
                "playlist_title": "Test Playlist",
            }
        )
        item2 = json.dumps(
            {
                "id": "video2",
                "url": "https://www.youtube.com/watch?v=video2",
                "title": "Second Video",
                "duration": 240,
            }
        )
        item3 = json.dumps(
            {
                "id": "video3",
                "title": "Third Video",
                "duration": 0,
            }
        )

        mock_completed = MagicMock(spec=subprocess.CompletedProcess)
        mock_completed.returncode = 0
        mock_completed.stdout = f"{item1}\n{item2}\n{item3}\n"
        mock_completed.stderr = ""
        mock_subprocess_run.return_value = mock_completed

        send_calls = []

        def mock_send(message):
            send_calls.append(message)

        run_playlist_enumeration(
            self.message,
            send=mock_send,
            yt_dlp_command_resolver=mock_resolve_yt_dlp,
            ffmpeg_location_resolver=mock_resolve_ffmpeg,
        )

        self.assertEqual(len(send_calls), 1)
        response = send_calls[0]

        self.assertEqual(response["type"], "playlistItems")
        self.assertEqual(response["totalItems"], 3)
        self.assertEqual(response["playlistTitle"], "Test Playlist")
        self.assertEqual(len(response["items"]), 3)

        # Verify items are in order
        self.assertEqual(response["items"][0]["id"], "video1")
        self.assertEqual(response["items"][1]["id"], "video2")
        self.assertEqual(response["items"][2]["id"], "video3")

        # Item without explicit URL should fall back to webpage_url or empty
        # Note: item3 has id but no url; the code constructs from webpage_url which also doesn't exist
        # So item3's url may be empty
        self.assertEqual(response["items"][0]["title"], "First Video")
        self.assertEqual(response["items"][1]["title"], "Second Video")

    @patch("format_list.subprocess.run")
    @patch("format_list.resolve_yt_dlp_command")
    @patch("format_list.resolve_ffmpeg_location")
    @patch("format_list.write_cookie_file_from_headers")
    def test_empty_playlist(
        self,
        mock_write_cookies,
        mock_resolve_ffmpeg,
        mock_resolve_yt_dlp,
        mock_subprocess_run,
    ):
        """Test that an empty playlist returns no items."""
        from format_list import run_playlist_enumeration

        mock_resolve_yt_dlp.return_value = ["yt-dlp"]
        mock_resolve_ffmpeg.return_value = None
        mock_write_cookies.return_value = None

        mock_completed = MagicMock(spec=subprocess.CompletedProcess)
        mock_completed.returncode = 0
        mock_completed.stdout = ""
        mock_completed.stderr = ""
        mock_subprocess_run.return_value = mock_completed

        send_calls = []

        def mock_send(message):
            send_calls.append(message)

        run_playlist_enumeration(
            self.message,
            send=mock_send,
            yt_dlp_command_resolver=mock_resolve_yt_dlp,
            ffmpeg_location_resolver=mock_resolve_ffmpeg,
        )

        self.assertEqual(len(send_calls), 1)
        response = send_calls[0]

        self.assertEqual(response["type"], "playlistItems")
        self.assertEqual(response["ok"], True)
        self.assertEqual(response["totalItems"], 0)
        self.assertEqual(len(response["items"]), 0)
        self.assertEqual(response["playlistTitle"], "")

    @patch("format_list.subprocess.run")
    @patch("format_list.resolve_yt_dlp_command")
    @patch("format_list.resolve_ffmpeg_location")
    @patch("format_list.write_cookie_file_from_headers")
    def test_yt_dlp_error(
        self,
        mock_write_cookies,
        mock_resolve_ffmpeg,
        mock_resolve_yt_dlp,
        mock_subprocess_run,
    ):
        """Test that a yt-dlp error propagates as a HostError."""
        from format_list import run_playlist_enumeration, HostError

        mock_resolve_yt_dlp.return_value = ["yt-dlp"]
        mock_resolve_ffmpeg.return_value = None
        mock_write_cookies.return_value = None

        mock_completed = MagicMock(spec=subprocess.CompletedProcess)
        mock_completed.returncode = 1
        mock_completed.stdout = ""
        mock_completed.stderr = "ERROR: Private video"
        mock_subprocess_run.return_value = mock_completed

        def mock_send(_message):
            pass

        with self.assertRaises(HostError) as ctx:
            run_playlist_enumeration(
                self.message,
                send=mock_send,
                yt_dlp_command_resolver=mock_resolve_yt_dlp,
                ffmpeg_location_resolver=mock_resolve_ffmpeg,
            )

        self.assertIn("Private video", str(ctx.exception))

    def test_build_flat_playlist_command_structure(self):
        """Test that build_flat_playlist_command produces the expected flags."""
        from yt_dlp_command import build_flat_playlist_command

        command = build_flat_playlist_command(
            url="https://www.youtube.com/playlist?list=PLTEST123",
            yt_dlp_command=["yt-dlp"],
        )

        self.assertIn("--flat-playlist", command)
        self.assertIn("--dump-json", command)
        self.assertIn("--skip-download", command)
        self.assertIn("--no-check-formats", command)
        self.assertNotIn("--no-playlist", command)
        self.assertNotIn("--dump-single-json", command)
        self.assertIn("--ignore-config", command)
        self.assertIn("https://www.youtube.com/playlist?list=PLTEST123", command)

    def test_build_flat_playlist_keeps_nocheckcertificate(self):
        """Test that nocheckcertificate flag is added when specified."""
        from yt_dlp_command import build_flat_playlist_command

        command = build_flat_playlist_command(
            url="https://example.com/playlist",
            yt_dlp_command=["yt-dlp"],
            nocheckcertificate=True,
        )

        self.assertIn("--no-check-certificate", command)


if __name__ == "__main__":
    unittest.main()
