import io
import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native-host"))

import host


class HostProgressParsingTests(unittest.TestCase):

    def test_parse_progress_line_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("[download]  57.3% of 10.00MiB at 1.2MiB/s ETA 00:03")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 57.3)
        self.assertIn("57.3%", parsed["line"])
        self.assertEqual(parsed["totalSize"], "10.00MiB")
        self.assertEqual(parsed["speed"], "1.2MiB/s")
        self.assertEqual(parsed["eta"], "00:03")

    def test_parse_aria2_progress_line_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])
        self.assertEqual(parsed["downloadedSize"], "8.1MiB")
        self.assertEqual(parsed["totalSize"], "40MiB")
        self.assertEqual(parsed["connections"], 16)
        self.assertEqual(parsed["speed"], "2.0MiB/s")
        self.assertEqual(parsed["eta"], "16s")

    def test_parse_aria2_progress_line_with_leading_text_extracts_percent(self):
        parsed = host.parse_yt_dlp_line("  [#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]")

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])

    def test_parse_aria2_fragment_status_without_percent_still_reports_download_activity(self):
        parsed = host.parse_yt_dlp_line("[DL:8.2MiB][#528371 1.8MiB/0B][#d07353 1.0MiB/0B][#55c62a 1.2MiB/0B](+1)")

        self.assertEqual(parsed["stage"], "download")
        self.assertNotIn("percent", parsed)
        self.assertEqual(parsed["speed"], "8.2MiB/s")
        self.assertEqual(parsed["fragment"], "3 active")
        self.assertIn("DL:8.2MiB", parsed["line"])

    def test_parse_total_fragments_line_reports_fragment_count(self):
        parsed = host.parse_yt_dlp_line("[hlsnative] Total fragments: 803")

        self.assertEqual(parsed["stage"], "extract")
        self.assertEqual(parsed["fragment"], "0/803")
        self.assertIn("Total fragments", parsed["line"])

    def test_parse_carriage_return_progress_uses_latest_status(self):
        parsed = host.parse_yt_dlp_line(
            "\r[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]\r[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]"
        )

        self.assertEqual(parsed["stage"], "download")
        self.assertEqual(parsed["percent"], 20.0)
        self.assertIn("20%", parsed["line"])

    def test_process_output_iterator_splits_carriage_return_progress(self):
        lines = list(
            host.iter_process_output_lines(
                io.StringIO(
                    "[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]\r"
                    "[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]\n"
                    "[download] 100% of 40MiB"
                )
            )
        )

        self.assertEqual(
            lines,
            [
                "[#123abc 4.0MiB/40MiB(10%) CN:16 DL:2.0MiB ETA:18s]",
                "[#123abc 8.1MiB/40MiB(20%) CN:16 DL:2.0MiB ETA:16s]",
                "[download] 100% of 40MiB",
            ],
        )

    def test_parse_after_move_filepath_marker(self):
        parsed = host.parse_yt_dlp_line("__QWIN_FILEPATH__:C:\\Users\\Viewer\\Downloads\\clip.mp4")

        self.assertEqual(parsed["stage"], "filepath")
        self.assertEqual(parsed["filepath"], r"C:\Users\Viewer\Downloads\clip.mp4")

    def test_parse_destination_line_extracts_filepath_and_artifact_root(self):
        parsed = host.parse_yt_dlp_line(
            r"[download] Destination: C:\Users\Viewer\Downloads\Sample Video\Sample Video [abc].f137.mp4"
        )

        self.assertEqual(parsed["stage"], "destination")
        self.assertEqual(
            parsed["filepath"],
            r"C:\Users\Viewer\Downloads\Sample Video\Sample Video [abc].f137.mp4",
        )
        self.assertEqual(parsed["artifactRoot"], r"C:\Users\Viewer\Downloads\Sample Video")


if __name__ == "__main__":
    unittest.main()
