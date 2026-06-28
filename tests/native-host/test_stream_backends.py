import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

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


if __name__ == "__main__":
    unittest.main()
