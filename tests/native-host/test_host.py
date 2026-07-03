import io
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from path_setup import *

import host

import native_protocol


class HostHelperTests(unittest.TestCase):
    def test_native_host_uses_split_modules_for_core_logic(self):
        import artifacts
        import browser_context
        import download_task
        import folder_picker
        import media_resolver
        import native_paths
        import native_protocol
        import process_control
        import progress_parser
        import stream_backends
        import yt_dlp_command

        # Use assertEqual instead of assertIs because importlib.reload() in
        # other test files (test_browser_context_extended.py) creates new
        # function objects when running all tests in the same process.
        self.assertEqual(host.HostError, native_protocol.HostError)
        self.assertEqual(host.request_id, native_protocol.request_id)
        self.assertEqual(host.request_type, native_protocol.request_type)
        self.assertEqual(host.pong_response, native_protocol.pong_response)
        self.assertEqual(host.folder_response, native_protocol.folder_response)
        self.assertEqual(host.error_response, native_protocol.error_response)
        self.assertEqual(host.unexpected_error_response, native_protocol.unexpected_error_response)
        self.assertEqual(host.sanitize_filename, native_paths.sanitize_filename)
        # Use __code__ comparison for function/lambda assignments because
        # importlib.reload() in other test files (test_browser_context_extended.py)
        # creates new function objects when running all tests in the same process.
        # Python functions don't define __eq__, so == falls back to identity (is).
        self.assertEqual(host.clean_request_headers.__code__, browser_context.clean_request_headers.__code__)
        self.assertEqual(host.build_yt_dlp_command.__code__, yt_dlp_command.build_yt_dlp_command.__code__)
        self.assertEqual(host.parse_yt_dlp_line.__code__, progress_parser.parse_yt_dlp_line.__code__)
        self.assertEqual(host.DownloadTask, download_task.DownloadTask)
        self.assertEqual(host.delete_download_artifacts.__code__, artifacts.delete_download_artifacts.__code__)
        self.assertEqual(host.creation_flags, process_control.creation_flags)
        self.assertEqual(host.choose_download_folder.__code__, folder_picker.choose_download_folder.__code__)
        # Class methods and non-function objects: use identity-based comparison
        self.assertIs(host.extract_media_candidates_from_text, media_resolver.extract_media_candidates_from_text)
        self.assertIs(host.build_n_m3u8dl_re_command, stream_backends.build_n_m3u8dl_re_command)
        self.assertIs(host.build_streamlink_command, stream_backends.build_streamlink_command)
        self.assertIs(download_task.parse_yt_dlp_line, progress_parser.parse_yt_dlp_line)
        self.assertIs(artifacts.creation_flags, process_control.creation_flags)

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

    def test_native_message_round_trip_uses_length_prefixed_json(self):
        payload = {"type": "progress", "percent": 42.5}
        encoded = native_protocol.encode_native_message(payload)
        length = struct.unpack("=I", encoded[:4])[0]

        self.assertEqual(length, len(encoded[4:]))
        self.assertEqual(native_protocol.read_native_message(io.BytesIO(encoded)), payload)
        self.assertIs(host.encode_native_message, native_protocol.encode_native_message)
        self.assertIs(host.read_native_message, native_protocol.read_native_message)

    def test_native_protocol_shapes_host_response_envelopes(self):
        request = {"type": "ping", "requestId": "legacy_1"}
        dependencies = {"ytDlp": True, "ffmpeg": False}

        self.assertEqual(native_protocol.request_id(request), "legacy_1")
        self.assertEqual(native_protocol.request_type(request), "ping")
        self.assertEqual(
            native_protocol.pong_response(request, "1.2.3", dependencies),
            {
                "type": "pong",
                "id": "legacy_1",
                "version": "1.2.3",
                "dependencies": dependencies,
            },
        )
        self.assertEqual(
            native_protocol.folder_response({"id": "folder_1"}, Path(r"C:\Users\Viewer\Videos")),
            {
                "type": "folder",
                "id": "folder_1",
                "path": r"C:\Users\Viewer\Videos",
            },
        )
        self.assertEqual(
            native_protocol.folder_response({"id": "folder_1"}, None),
            {"type": "folder", "id": "folder_1", "canceled": True},
        )
        self.assertEqual(
            native_protocol.error_response("job_1", "failed"), {"type": "error", "id": "job_1", "error": "failed"}
        )
        self.assertEqual(
            native_protocol.unexpected_error_response("job_1", "boom"),
            {"type": "error", "id": "job_1", "error": "Unexpected helper error: boom"},
        )

    def test_handle_choose_folder_sends_selected_path(self):
        sent = []

        with (
            patch.object(host, "choose_download_folder", return_value=Path(r"C:\Users\Viewer\Videos")),
            patch.object(host, "send_native_message", side_effect=sent.append),
        ):
            host.handle_message(
                {"type": "chooseFolder", "id": "folder_1", "initialFolder": r"C:\Users\Viewer\Downloads"}
            )

        self.assertEqual(
            sent,
            [
                {
                    "type": "folder",
                    "id": "folder_1",
                    "path": r"C:\Users\Viewer\Videos",
                }
            ],
        )

    def test_handle_choose_folder_reports_cancel(self):
        sent = []

        with (
            patch.object(host, "choose_download_folder", return_value=None),
            patch.object(host, "send_native_message", side_effect=sent.append),
        ):
            host.handle_message({"type": "chooseFolder", "id": "folder_1"})

        self.assertEqual(sent, [{"type": "folder", "id": "folder_1", "canceled": True}])

    def test_main_does_not_cancel_active_downloads_when_browser_pipe_closes(self):
        with (
            patch.object(host, "configure_binary_stdio"),
            patch.object(host, "read_native_message", side_effect=EOFError),
            patch.object(host, "cancel_active_downloads") as cancel_active_downloads,
        ):
            result = host.main()

        self.assertEqual(result, 0)
        cancel_active_downloads.assert_not_called()

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
            temp_resolved = Path(temp).resolve()
            download_dir = temp_resolved / "Downloads"
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
            # Normalize path to handle 8.3 short names on Windows CI (RUNNER~1 vs runneradmin)
            self.assertEqual(sent[0]["deleted"], [str(title_dir.resolve())])

    def test_delete_download_artifacts_uses_specific_file_when_artifact_root_is_download_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_resolved = Path(temp).resolve()
            download_dir = temp_resolved / "Downloads"
            download_dir.mkdir()
            missing_file = download_dir / "missing-video.mp4"

            sent = []
            host.delete_download_artifacts(
                {
                    "id": "delete_1",
                    "path": str(missing_file),
                    "artifactRoot": str(download_dir),
                    "downloadFolder": str(download_dir),
                },
                send=sent.append,
            )

            self.assertEqual(sent[0]["type"], "deletedArtifacts")
            self.assertEqual(sent[0]["deleted"], [])
            # Normalize path to handle 8.3 short names on Windows CI (RUNNER~1 vs runneradmin)
            self.assertEqual(sent[0]["missing"], [str(missing_file.resolve())])

    def test_delete_download_artifacts_rejects_targets_outside_download_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_resolved = Path(temp).resolve()
            download_dir = temp_resolved / "Downloads"
            outside_dir = temp_resolved / "Outside"
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
