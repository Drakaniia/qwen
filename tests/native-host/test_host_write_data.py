"""Integration tests for the native host writeData handler.

Tests that run_write_data in host.py correctly:
1. Decodes base64 data and writes to disk
2. Reports bytes written correctly
3. Handles missing fields gracefully
4. Creates parent directories as needed
5. Handles invalid base64 data
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR / "src" / "native_host"))

import host


class WriteDataHandlerIntegrationTests(unittest.TestCase):
    """Integration tests for the writeData native host message handler."""

    def setUp(self):
        self.assertTrue(
            hasattr(host, "run_write_data"),
            "host module must export run_write_data function",
        )

    def test_run_write_data_writes_basic_base64(self):
        """GIVEN valid base64 data and output path, run_write_data writes the file."""
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "segment_001.ts"
            result = host.run_write_data({
                "id": "test-001",
                "data": "aGVsbG8=",  # "hello" in base64
                "outputPath": str(output_path),
            })

            self.assertTrue(result["ok"])
            self.assertEqual(result["bytesWritten"], 5)
            self.assertEqual(Path(result["outputPath"]).read_bytes(), b"hello")

    def test_run_write_data_writes_large_binary_data(self):
        """GIVEN large base64 data, run_write_data writes correctly."""
        with tempfile.TemporaryDirectory() as tmp:
            original = bytes(range(256))  # 256-byte binary data
            import base64
            b64_data = base64.b64encode(original).decode("ascii")
            output_path = Path(tmp) / "large_segment.bin"

            result = host.run_write_data({
                "id": "test-large",
                "data": b64_data,
                "outputPath": str(output_path),
            })

            self.assertTrue(result["ok"])
            self.assertEqual(result["bytesWritten"], 256)
            self.assertEqual(Path(result["outputPath"]).read_bytes(), original)

    def test_run_write_data_creates_parent_directories(self):
        """GIVEN output path with nested directories, run_write_data creates them."""
        with tempfile.TemporaryDirectory() as tmp:
            nested_path = Path(tmp) / "nested" / "dirs" / "segment.ts"
            result = host.run_write_data({
                "id": "test-nested",
                "data": "dGVzdA==",  # "test"
                "outputPath": str(nested_path),
            })

            self.assertTrue(result["ok"])
            self.assertTrue(nested_path.exists())
            self.assertEqual(nested_path.read_bytes(), b"test")

    def test_run_write_data_reports_error_for_missing_data(self):
        """GIVEN no base64 data, run_write_data returns error."""
        result = host.run_write_data({
            "id": "test-no-data",
            "data": "",
            "outputPath": "C:\\output.ts",
        })
        self.assertFalse(result["ok"])
        self.assertIn("No base64 data", result.get("error", ""))

    def test_run_write_data_reports_error_for_missing_output_path(self):
        """GIVEN no output path, run_write_data returns error."""
        result = host.run_write_data({
            "id": "test-no-path",
            "data": "dGVzdA==",
            "outputPath": "",
        })
        self.assertFalse(result["ok"])
        self.assertIn("No output path", result.get("error", ""))

    def test_run_write_data_handles_invalid_base64(self):
        """GIVEN invalid base64, run_write_data returns error instead of crashing."""
        result = host.run_write_data({
            "id": "test-invalid",
            "data": "not valid base64!!!",
            "outputPath": "C:\\output.ts",
        })
        self.assertFalse(result["ok"])
        self.assertIn("Failed to write data", result.get("error", ""))

    def test_run_write_data_response_has_expected_structure(self):
        """GIVEN valid input, run_write_data response has expected keys."""
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "out.bin"
            result = host.run_write_data({
                "id": "test-structure",
                "data": "dGVzdA==",
                "outputPath": str(output_path),
            })

            for key in ("type", "id", "ok", "bytesWritten", "outputPath"):
                self.assertIn(key, result)
            self.assertEqual(result["type"], "writeDataResult")
            self.assertEqual(result["id"], "test-structure")

    def test_run_write_data_overwrites_existing_file(self):
        """GIVEN existing file, run_write_data overwrites it."""
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "existing.bin"
            output_path.write_text("old content")

            result = host.run_write_data({
                "id": "test-overwrite",
                "data": "bmV3IGNvbnRlbnQ=",  # "new content"
                "outputPath": str(output_path),
            })

            self.assertTrue(result["ok"])
            self.assertEqual(Path(result["outputPath"]).read_text(), "new content")

    def test_run_write_data_handles_missing_output_path_key(self):
        """GIVEN outputPath is omitted, run_write_data returns error."""
        result = host.run_write_data({
            "id": "test-none-path",
            "data": "dGVzdA==",
        })
        self.assertFalse(result["ok"])
        self.assertIn("No output path", result.get("error", ""))


if __name__ == "__main__":
    unittest.main()
