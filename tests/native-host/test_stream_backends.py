import unittest
from pathlib import Path

import path_setup  # noqa: F401

import stream_backends


class StreamBackendsTests(unittest.TestCase):
    # ── GAP 1: ffmpeg Direct Stream Download ────────────────────────────────

    def test_build_ffmpeg_direct_command_basic_structure(self):
        """build_ffmpeg_direct_command produces: ffmpeg -i <url> -c copy -y <output>"""
        command = stream_backends.build_ffmpeg_direct_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
        )

        self.assertEqual(command[0], "ffmpeg")
        self.assertIn("-i", command)
        i_idx = command.index("-i")
        self.assertEqual(command[i_idx + 1], "https://cdn.example.com/stream.m3u8")
        self.assertIn("-c", command)
        c_idx = command.index("-c")
        self.assertEqual(command[c_idx + 1], "copy")
        self.assertIn("-y", command)
        self.assertIn(r"C:\Users\Viewer\Downloads\Video\Video.mp4", command)

    def test_build_ffmpeg_direct_command_with_custom_ffmpeg_location(self):
        """build_ffmpeg_direct_command accepts custom ffmpeg binary path"""
        command = stream_backends.build_ffmpeg_direct_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertEqual(command[0], r"C:\Tools\ffmpeg.exe")

    def test_build_ffmpeg_direct_command_with_headers(self):
        """build_ffmpeg_direct_command includes custom HTTP headers"""
        command = stream_backends.build_ffmpeg_direct_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            request_headers=[
                {"name": "Referer", "value": "https://example.com/watch"},
                {"name": "User-Agent", "value": "Mozilla/5.0 Test"},
            ],
        )

        # ffmpeg uses -headers for custom HTTP headers
        self.assertIn("-headers", command)
        headers_idx = command.index("-headers")
        headers_val = command[headers_idx + 1]
        self.assertIn("Referer: https://example.com/watch", headers_val)
        self.assertIn("User-Agent: Mozilla/5.0 Test", headers_val)

    def test_build_ffmpeg_direct_command_output_path_uses_parent_dir(self):
        """output directory is created as parent of output_path"""
        output = Path(r"C:\Users\Viewer\Downloads\Movie\Movie.mp4")
        command = stream_backends.build_ffmpeg_direct_command(
            url="https://cdn.example.com/stream.mpd",
            output_path=output,
        )

        self.assertIn(str(output), command)
        self.assertNotIn(str(output.parent), [c for c in command if c != str(output)])

    # ── GAP 4: Bento4 / mp4decrypt ──────────────────────────────────────────

    def test_build_mp4decrypt_command_basic_structure(self):
        """build_mp4decrypt_command produces: mp4decrypt --key <key> <input> <output>"""
        command = stream_backends.build_mp4decrypt_command(
            input_path=Path(r"C:\Downloads\encrypted.m4s"),
            output_path=Path(r"C:\Downloads\decrypted.m4s"),
            key="1:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        )

        self.assertEqual(command[0], "mp4decrypt")
        self.assertIn("--key", command)
        key_idx = command.index("--key")
        self.assertEqual(command[key_idx + 1], "1:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")
        self.assertIn(r"C:\Downloads\encrypted.m4s", command)
        self.assertIn(r"C:\Downloads\decrypted.m4s", command)

    def test_build_mp4decrypt_command_with_custom_path(self):
        """build_mp4decrypt_command accepts custom mp4decrypt binary path"""
        command = stream_backends.build_mp4decrypt_command(
            input_path=Path(r"C:\Downloads\encrypted.m4s"),
            output_path=Path(r"C:\Downloads\decrypted.m4s"),
            key="1:AAAABBBBCCCCDDDDEEEEFFFF00001111",
            mp4decrypt_location=r"C:\Tools\mp4decrypt.exe",
        )

        self.assertEqual(command[0], r"C:\Tools\mp4decrypt.exe")

    def test_build_mp4decrypt_command_multiple_keys(self):
        """build_mp4decrypt_command accepts multiple --key arguments"""
        command = stream_backends.build_mp4decrypt_command(
            input_path=Path(r"C:\Downloads\encrypted.m4s"),
            output_path=Path(r"C:\Downloads\decrypted.m4s"),
            key=["1:KEY_ONE", "2:KEY_TWO"],
        )

        key_indices = [i for i, v in enumerate(command) if v == "--key"]
        self.assertEqual(len(key_indices), 2)
        self.assertEqual(command[key_indices[0] + 1], "1:KEY_ONE")
        self.assertEqual(command[key_indices[1] + 1], "2:KEY_TWO")

    # ── GAP: Streamlink Command ────────────────────────────────────────────

    def test_build_streamlink_command_basic_structure(self):
        """build_streamlink_command produces: streamlink [options] <url> best"""
        command = stream_backends.build_streamlink_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
        )

        # Must NOT contain deprecated HLS-specific flags (removed in streamlink 7.x)
        deprecated_flags = {"--hls-segment-attempts", "--hls-segment-timeout"}
        cmd_set = set(command)
        deprecated_found = cmd_set & deprecated_flags
        self.assertEqual(
            deprecated_found,
            set(),
            f"Deprecated flags found in command: {deprecated_found}",
        )

        # Must use stream-type-agnostic replacements
        self.assertIn("--stream-segment-attempts", command)
        self.assertIn("--stream-segment-timeout", command)

        # Core structure
        self.assertEqual(command[0], "streamlink")
        self.assertIn("--retry-streams", command)
        self.assertIn("--retry-max", command)
        self.assertIn("--ringbuffer-size", command)
        self.assertIn("--force", command)
        self.assertIn("-o", command)
        self.assertIn(r"C:\Users\Viewer\Downloads\Video\Video.mp4", command)
        # Last two args: URL + quality
        self.assertEqual(command[-2], "https://cdn.example.com/stream.m3u8")
        self.assertEqual(command[-1], "best")

    def test_build_streamlink_command_custom_binary(self):
        """build_streamlink_command accepts custom streamlink binary path"""
        command = stream_backends.build_streamlink_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            streamlink_command=[r"C:\Tools\streamlink.exe"],
        )

        self.assertEqual(command[0], r"C:\Tools\streamlink.exe")

    def test_build_streamlink_command_with_ffmpeg(self):
        """build_streamlink_command includes ffmpeg arguments when location given"""
        command = stream_backends.build_streamlink_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            ffmpeg_location=r"C:\Tools\ffmpeg.exe",
        )

        self.assertIn("--ffmpeg-ffmpeg", command)
        ffmpeg_idx = command.index("--ffmpeg-ffmpeg")
        self.assertEqual(command[ffmpeg_idx + 1], r"C:\Tools\ffmpeg.exe")
        self.assertIn("--ffmpeg-fout", command)
        fout_idx = command.index("--ffmpeg-fout")
        self.assertEqual(command[fout_idx + 1], "mp4")

    def test_build_streamlink_command_with_cookies(self):
        """build_streamlink_command includes --http-cookies-file when cookies_file given"""
        command = stream_backends.build_streamlink_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            cookies_file=r"C:\Temp\qwin-cookies-abc123.txt",
        )

        self.assertIn("--http-cookies-file", command)
        ck_idx = command.index("--http-cookies-file")
        self.assertEqual(command[ck_idx + 1], r"C:\Temp\qwin-cookies-abc123.txt")

    def test_build_streamlink_command_with_headers(self):
        """build_streamlink_command includes --http-header for referer/user-agent/origin"""
        command = stream_backends.build_streamlink_command(
            url="https://cdn.example.com/stream.m3u8",
            output_path=Path(r"C:\Users\Viewer\Downloads\Video\Video.mp4"),
            request_headers=[
                {"name": "Referer", "value": "https://example.com/watch"},
                {"name": "User-Agent", "value": "Mozilla/5.0 Test"},
                {"name": "Origin", "value": "https://example.com"},
                {"name": "Cookie", "value": "session=abc123"},  # Should be skipped
            ],
        )

        # Cookie header should be excluded
        cookie_args = [
            command[i + 1]
            for i, v in enumerate(command)
            if v == "--http-header" and "cookie" in command[i + 1].lower()
        ]
        self.assertEqual(len(cookie_args), 0, "Cookie header should not be passed to streamlink")

        # Referer, User-Agent, Origin should be included
        header_args = [
            command[i + 1]
            for i, v in enumerate(command)
            if v == "--http-header"
        ]
        self.assertTrue(
            any("Referer=https://example.com/watch" in h for h in header_args),
        )
        self.assertTrue(
            any("User-Agent=Mozilla/5.0 Test" in h for h in header_args),
        )
        self.assertTrue(
            any("Origin=https://example.com" in h for h in header_args),
        )


if __name__ == "__main__":
    unittest.main()
