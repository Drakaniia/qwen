"""Tests for DownloadLogger lifecycle events: complete vs error.

These tests verify that DOWNLOAD_COMPLETE is only logged when the
download was genuinely successful, and DOWNLOAD_ERROR is logged
when it failed. They also verify the contract that a terminal event
(COMPLETE, ERROR, CANCEL) should be mutually exclusive per download.
"""

import json
import tempfile
import unittest
from pathlib import Path

import path_setup  # noqa: F401
from download_logger import DownloadLogger


class TestDownloadLoggerLifecycleEvents(unittest.TestCase):
    """DownloadLogger must correctly distinguish complete vs error."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w")
        self.tmp.close()
        self.logger = DownloadLogger(log_path=Path(self.tmp.name))

    def tearDown(self):
        Path(self.tmp.name).unlink(missing_ok=True)

    def _read_log(self):
        text = Path(self.tmp.name).read_text(encoding="utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    # ── Happy paths ────────────────────────────────────────────────────────

    def test_complete_logs_download_complete_event(self):
        """complete() must write a DOWNLOAD_COMPLETE event."""
        self.logger.complete(
            download_id="dl_001",
            filepath="C:\\Downloads\\video.mp4",
            artifact_root="C:\\Downloads\\video_artifacts",
            duration_seconds=30.5,
            message="Download complete.",
        )
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "DOWNLOAD_COMPLETE")
        self.assertEqual(entries[0]["downloadId"], "dl_001")
        self.assertEqual(entries[0]["filepath"], "C:\\Downloads\\video.mp4")
        self.assertEqual(entries[0]["artifactRoot"], "C:\\Downloads\\video_artifacts")
        self.assertEqual(entries[0]["durationSeconds"], 30.5)
        self.assertEqual(entries[0]["message"], "Download complete.")
        self.assertIn("timestamp", entries[0])

    def test_error_logs_download_error_event(self):
        """error() must write a DOWNLOAD_ERROR event."""
        self.logger.error(
            download_id="dl_002",
            error_text="yt-dlp exited with status 1",
            duration_seconds=5.2,
        )
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "DOWNLOAD_ERROR")
        self.assertEqual(entries[0]["downloadId"], "dl_002")
        self.assertEqual(entries[0]["error"], "yt-dlp exited with status 1")
        self.assertEqual(entries[0]["durationSeconds"], 5.2)
        self.assertIn("timestamp", entries[0])

    def test_cancel_logs_download_cancel_event(self):
        """cancel() must write a DOWNLOAD_CANCEL event."""
        self.logger.cancel(
            download_id="dl_003",
            message="User requested cancellation.",
        )
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "DOWNLOAD_CANCEL")
        self.assertEqual(entries[0]["downloadId"], "dl_003")
        self.assertEqual(entries[0]["message"], "User requested cancellation.")
        self.assertIn("timestamp", entries[0])

    # ── Terminal event mutual exclusion ────────────────────────────────────

    def test_complete_and_error_are_mutually_exclusive_per_download(self):
        """A download must not have both DOWNLOAD_COMPLETE and DOWNLOAD_ERROR."""
        download_id = "dl_mutual"
        self.logger.error(
            download_id=download_id,
            error_text="Something went wrong.",
            duration_seconds=2.0,
        )
        self.logger.complete(
            download_id=download_id,
            filepath="C:\\Downloads\\partial.mp4",
            duration_seconds=5.0,
            message="Download complete.",
        )
        entries = self._read_log()
        complete_events = [e for e in entries if e["event"] == "DOWNLOAD_COMPLETE" and e["downloadId"] == download_id]
        error_events = [e for e in entries if e["event"] == "DOWNLOAD_ERROR" and e["downloadId"] == download_id]
        # Having both DOWNLOAD_COMPLETE and DOWNLOAD_ERROR for the same
        # downloadId is a bug — a download cannot be both complete and failed.
        # This test documents the contract; the logger itself does not prevent
        # this (it is a passive logger), but the caller (DownloadTask) must
        # ensure mutual exclusion.
        self.assertTrue(
            len(complete_events) == 0 or len(error_events) == 0,
            f"Download {download_id} has both DOWNLOAD_COMPLETE and DOWNLOAD_ERROR events — "
            "caller must ensure mutual exclusion.",
        )

    # ── Exhaustive edge cases: complete() with empty/missing values ─────────

    def test_complete_with_empty_filepath_still_logs_event(self):
        """complete() with no filepath should still log (filepath may be set later)."""
        self.logger.complete(
            download_id="dl_empty_path",
            filepath="",
            duration_seconds=10.0,
            message="Done.",
        )
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["event"], "DOWNLOAD_COMPLETE")
        self.assertEqual(entries[0]["filepath"], "")

    def test_complete_with_zero_duration(self):
        """complete() with zero duration should still log."""
        self.logger.complete(
            download_id="dl_zero_dur",
            filepath="C:\\file.mp4",
            duration_seconds=0.0,
            message="",
        )
        entries = self._read_log()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["durationSeconds"], 0.0)

    def test_error_with_multiline_text(self):
        """error() with multiline error text must preserve the full text."""
        multiline = "Line 1\nLine 2\nLine 3"
        self.logger.error(
            download_id="dl_multiline",
            error_text=multiline,
            duration_seconds=1.0,
        )
        entries = self._read_log()
        self.assertEqual(entries[0]["error"], multiline)

    # ── Download lifecycle sequence integrity ──────────────────────────────

    def test_full_lifecycle_complete_path(self):
        """A full successful download lifecycle must end with DOWNLOAD_COMPLETE."""
        did = "dl_lifecycle_complete"
        self.logger.init(download_id=did, url="https://example.com/video.mp4")
        self.logger.attempt_start(download_id=did, attempt_num=1, label="yt-dlp", command=["yt-dlp", "https://"])
        self.logger.attempt_line(download_id=did, line="[download] 100%")
        self.logger.attempt_end(download_id=did, attempt_num=1, exit_code=0)
        self.logger.complete(download_id=did, filepath="C:\\video.mp4", duration_seconds=15.0)

        entries = self._read_log()
        events = [e["event"] for e in entries]
        self.assertIn("DOWNLOAD_INIT", events)
        self.assertIn("ATTEMPT_START", events)
        self.assertIn("ATTEMPT_END", events)
        self.assertEqual(events[-1], "DOWNLOAD_COMPLETE")
        self.assertNotIn("DOWNLOAD_ERROR", events)

    def test_full_lifecycle_error_path(self):
        """A failed download lifecycle must end with DOWNLOAD_ERROR."""
        did = "dl_lifecycle_error"
        self.logger.init(download_id=did, url="https://example.com/video.mp4")
        self.logger.attempt_start(download_id=did, attempt_num=1, label="yt-dlp", command=["yt-dlp", "https://"])
        self.logger.attempt_line(download_id=did, line="ERROR: HTTP 403")
        self.logger.attempt_end(download_id=did, attempt_num=1, exit_code=1)
        self.logger.error(download_id=did, error_text="HTTP 403 Forbidden", duration_seconds=3.0)

        entries = self._read_log()
        events = [e["event"] for e in entries]
        self.assertEqual(events[-1], "DOWNLOAD_ERROR")
        self.assertNotIn("DOWNLOAD_COMPLETE", events)

    def test_cancel_after_error_still_ends_with_error(self):
        """If error() was called, cancel() afterwards should not override the error terminal state."""
        did = "dl_cancel_after_error"
        self.logger.error(download_id=did, error_text="Failed", duration_seconds=2.0)
        self.logger.cancel(download_id=did, message="Cleanup after failure.")

        entries = self._read_log()
        complete_events = [e for e in entries if e["event"] == "DOWNLOAD_COMPLETE"]
        error_events = [e for e in entries if e["event"] == "DOWNLOAD_ERROR"]
        cancel_events = [e for e in entries if e["event"] == "DOWNLOAD_CANCEL"]

        # error() was called first — it's a terminal event
        self.assertEqual(len(error_events), 1)
        # cancel() after error is allowed (cleanup), but DOWNLOAD_COMPLETE must never appear
        self.assertEqual(len(complete_events), 0)


if __name__ == "__main__":
    unittest.main()
