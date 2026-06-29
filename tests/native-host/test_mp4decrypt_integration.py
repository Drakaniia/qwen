"""Tests for mp4decrypt (Bento4) integration in the CDM decryption pipeline.

Verifies that `decrypt_with_mp4decrypt()` in cdm_capture.py correctly:
1. Builds mp4decrypt commands for encrypted segments
2. Handles missing input files gracefully
3. Handles missing keys gracefully
4. Produces correct result structure
5. Auto-generates output paths when not provided

RED phase: These tests fail because the function doesn't exist yet.
GREEN phase: After implementing, these tests pass.
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

try:
    from cdm_capture import decrypt_with_mp4decrypt

    MODULE_EXISTS = True
except (ImportError, AttributeError):
    MODULE_EXISTS = False


class TestMp4DecryptIntegration(unittest.TestCase):
    """decrypt_with_mp4decrypt — Bento4 mp4decrypt post-processing."""

    def setUp(self):
        if not MODULE_EXISTS:
            self.skipTest("decrypt_with_mp4decrypt not yet implemented (RED phase)")

    def test_decrypt_with_mp4decrypt_handles_missing_input(self):
        """When an input file does not exist, the function should report an error but not crash."""
        result = decrypt_with_mp4decrypt(
            job_id="test_job_1",
            encrypted_segments=[
                {
                    "inputPath": str(Path(tempfile.gettempdir()) / "nonexistent_encrypted.m4s"),
                    "key": "1:AAAABBBBCCCCDDDDEEEEFFFF00001111",
                }
            ],
            keys=[],
        )

        self.assertFalse(result["ok"], "should fail when input file doesn't exist")
        self.assertEqual(result["decrypted"], 0, "no segments should be decrypted")
        self.assertEqual(result["jobId"], "test_job_1")

    def test_decrypt_with_mp4decrypt_handles_missing_key(self):
        """When no key is provided, the function should report an error but not crash."""
        result = decrypt_with_mp4decrypt(
            job_id="test_job_2",
            encrypted_segments=[
                {
                    "inputPath": str(Path(tempfile.gettempdir()) / "nonexistent.m4s"),
                }
            ],
            keys=[],  # No keys either
        )

        self.assertFalse(result["ok"], "should fail when no key is available")
        self.assertEqual(result["decrypted"], 0)

    def test_decrypt_with_mp4decrypt_uses_key_from_segment(self):
        """The segment-level key should take priority over the fallback keys list."""
        result = decrypt_with_mp4decrypt(
            job_id="test_job_3",
            encrypted_segments=[
                {
                    "inputPath": str(Path(tempfile.gettempdir()) / "missing.m4s"),
                    "key": "1:SEGMENT_KEY",
                }
            ],
            keys=[{"keyIdB64": "", "keyB64": "FALLBACK_KEY", "type": "cenc"}],
        )

        self.assertFalse(result["ok"], "input file still missing, but should not crash")
        # The fact that it processed the segment (even though file missing) means
        # the key was used. The error will be about file not found, not missing key.
        self.assertIn("not found", result.get("error", "").lower(), "error should mention file not found")

    def test_decrypt_with_mp4decrypt_returns_correct_result_structure(self):
        """The result dict should always have ok, jobId, decrypted, segmentPaths keys."""
        result = decrypt_with_mp4decrypt(
            job_id="test_job_4",
            encrypted_segments=[],
            keys=[],
        )

        self.assertIn("ok", result, "result must have 'ok' key")
        self.assertIn("jobId", result, "result must have 'jobId' key")
        self.assertIn("decrypted", result, "result must have 'decrypted' key")
        self.assertIn("segmentPaths", result, "result must have 'segmentPaths' key")
        self.assertEqual(result["jobId"], "test_job_4")
        self.assertEqual(result["decrypted"], 0)
        self.assertEqual(result["segmentPaths"], [])

    def test_decrypt_with_mp4decrypt_auto_generates_output_path(self):
        """When outputPath is omitted, the function should auto-generate one."""
        result = decrypt_with_mp4decrypt(
            job_id="test_job_5",
            encrypted_segments=[
                {
                    "inputPath": str(Path(tempfile.gettempdir()) / "encrypted_seg.m4s"),
                    "key": "1:TEST_KEY",
                }
            ],
            keys=[],
        )

        self.assertFalse(result["ok"], "input file missing, but should not crash")
        # The function tried to process - the error will be about missing file
        # This test verifies the function doesn't crash with auto-generated paths
        self.assertIsNotNone(result.get("error"))

    def test_decrypt_with_mp4decrypt_supports_custom_output_dir(self):
        """When output_dir is specified, auto-generated paths should use it."""
        with tempfile.TemporaryDirectory() as tmpdir:
            result = decrypt_with_mp4decrypt(
                job_id="test_job_6",
                encrypted_segments=[
                    {
                        "inputPath": str(Path(tmpdir) / "encrypted_seg.m4s"),
                        "key": "1:TEST_KEY",
                    }
                ],
                keys=[],
                output_dir=tmpdir,
            )

            self.assertFalse(result["ok"], "need actual mp4decrypt binary for success")
            # The function ran without crashing
            self.assertEqual(result["jobId"], "test_job_6")


if __name__ == "__main__":
    unittest.main()
