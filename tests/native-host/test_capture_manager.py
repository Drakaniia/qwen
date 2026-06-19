"""Tests for the CaptureManager that manages the Go companion binary.

These tests require the Go binary to be built first.
Run `go build -o ../go/qwin-capture.exe ../go/` before running this test.
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path


# Add the native-host source to the Python path
HERE = Path(__file__).resolve().parent
SRC = HERE.parent.parent / "src" / "native-host"
GO_DIR = HERE.parent.parent / "go"

sys.path.insert(0, str(SRC))

# Build the Go binary if it doesn't exist
GO_BINARY = GO_DIR / "qwin-capture.exe"
if not GO_BINARY.exists():
    try:
        subprocess.run(
            ["go", "build", "-o", str(GO_BINARY), "."],
            cwd=str(GO_DIR),
            check=True,
            capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"Warning: Could not build Go binary: {exc}", file=sys.stderr)
        print("Tests that spawn the Go binary will be skipped.", file=sys.stderr)

from capture_manager import CaptureManager


class TestCaptureManager(unittest.TestCase):
    """Tests for CaptureManager that verify Go binary IPC."""

    @classmethod
    def setUpClass(cls):
        cls._has_binary = GO_BINARY.exists()

    def test_binary_detected(self):
        """The capture manager should detect the Go binary."""
        mgr = CaptureManager()
        self.assertEqual(mgr.is_available, self._has_binary)

    def test_not_running_initially(self):
        """The capture manager should not be running initially."""
        mgr = CaptureManager()
        self.assertFalse(mgr.is_running)

    def test_start_and_stop(self):
        """Starting the Go binary should make it running, then stop should clean up."""
        if not self._has_binary:
            self.skipTest("Go binary not built")

        mgr = CaptureManager()
        try:
            mgr.start()
            self.assertTrue(mgr.is_running)

            # Send a status command to verify IPC works
            response = mgr.send_command("status", timeout=5.0)
            self.assertIsNotNone(response)
            self.assertEqual(response.get("type"), "cdmStatus")
            self.assertIn("cdmAvailable", response)
            self.assertIn("captureReady", response)
            self.assertTrue(response["captureReady"])
        finally:
            mgr.stop(timeout=5.0)

        self.assertFalse(mgr.is_running)

    def test_send_echo_command(self):
        """The echo command should round-trip a message."""
        if not self._has_binary:
            self.skipTest("Go binary not built")

        mgr = CaptureManager()
        try:
            mgr.start()

            response = mgr.send_command("echo", data={"message": "hello from python"})
            self.assertIsNotNone(response)
            self.assertEqual(response.get("type"), "echo")
            self.assertEqual(response.get("message"), "hello from python")
        finally:
            mgr.stop()

    def test_status_returns_capture_ready(self):
        """The status command should indicate capture is ready (CDM pending)."""
        if not self._has_binary:
            self.skipTest("Go binary not built")

        mgr = CaptureManager()
        try:
            mgr.start()
            status = mgr.get_capture_status()

            self.assertFalse(status["cdmAvailable"], "CDM not available in scaffold")
            self.assertTrue(status["captureReady"], "Capture should be ready")
            self.assertIn("version", status)
        finally:
            mgr.stop()

    def test_send_command_before_start_raises(self):
        """Sending a command before start should raise an error."""
        mgr = CaptureManager()
        with self.assertRaises(Exception) as ctx:
            mgr.send_command("status")
        self.assertIn("not running", str(ctx.exception).lower())

    def test_stop_when_not_running(self):
        """Stopping when not running should not raise."""
        mgr = CaptureManager()
        try:
            mgr.stop()  # Should not raise
        except Exception:
            self.fail("stop() should not raise when not running")

    def test_get_capture_status_when_binary_missing(self):
        """get_capture_status should return offline status when binary is missing."""
        mgr = CaptureManager()
        if not self._has_binary:
            status = mgr.get_capture_status()
            self.assertFalse(status["captureReady"])
            self.assertIn("error", status)
        else:
            # Binary exists — verify we get a real status response
            try:
                mgr.start()
                status = mgr.get_capture_status()
                self.assertIn("captureReady", status)
                self.assertIn("cdmAvailable", status)
            finally:
                mgr.stop()

    def test_capture_available_function(self):
        """The module-level capture_available() should match binary detection."""
        from capture_manager import capture_available
        self.assertEqual(capture_available(), self._has_binary)


if __name__ == "__main__":
    unittest.main()
