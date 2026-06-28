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

from capture_helpers import read_native_message, write_native_message
from capture_manager import CaptureManager


class TestCDPRelayChain(unittest.TestCase):
    """Tests for the CDP relay chain (Go → Python → Extension → chrome.debugger).

    These tests verify the relay chain from the Python perspective:
    - Sending a cdp_relay command to Go
    - Go writes a cdpRelayForward message to stdout
    - Python reads it via the background reader
    - Python sends a result back via send_cdp_relay_result
    - Go returns the result as the response
    """

    @classmethod
    def setUpClass(cls):
        cls._has_binary = GO_BINARY.exists()

    def test_send_cdp_relay_via_manager(self):
        """Send_cdp_relay should go through the full relay roundtrip."""
        if not self._has_binary:
            self.skipTest("Go binary not built")

        mgr = CaptureManager()
        try:
            mgr.start()
            self.assertTrue(mgr.is_running)

            # Step 1: Check for pending forwards (should be empty initially)
            initial_forward = mgr.get_pending_cdp_forward()
            self.assertIsNone(initial_forward, "No forward should be pending initially")

            # Step 2: Send cdp_relay command (Go will write to stdout)
            # This blocks until Go gets the relay result back
            # We send the result in a separate thread to avoid deadlock
            import threading as t

            result_holder = [None]

            def _send_relay_and_capture_result():
                try:
                    result = mgr.send_cdp_relay(
                        method="Network.enable",
                        tab_id=42,
                        params={},
                        timeout=15.0,
                    )
                    result_holder[0] = result
                except Exception as exc:
                    result_holder[0] = exc

            relay_thread = t.Thread(target=_send_relay_and_capture_result, daemon=True)
            relay_thread.start()

            # Step 3: Wait for the cdpRelayForward message from the background reader
            import time as _time

            forward = None
            deadline = _time.time() + 10.0
            while _time.time() < deadline and forward is None:
                forward = mgr.get_pending_cdp_forward(block=True, timeout=1.0)

            self.assertIsNotNone(forward, "Should receive a cdpRelayForward from Go")
            self.assertEqual(forward.get("type"), "cdpRelayForward")
            forward_id = forward.get("id", "")
            self.assertTrue(forward_id.startswith("relay_"), f"forward ID should start with 'relay_': {forward_id}")

            forward_data = forward.get("data", {})
            self.assertEqual(forward_data.get("tabId"), 42)
            self.assertEqual(forward_data.get("method"), "Network.enable")

            # Step 4: Send the CDP result back to Go (simulating extension response)
            mgr.send_cdp_relay_result(
                forward_id=forward_id,
                result={"success": True},
            )

            # Step 5: Wait for the relay command to complete
            relay_thread.join(timeout=10.0)
            self.assertFalse(relay_thread.is_alive(), "Relay thread should have completed")

            result = result_holder[0]
            self.assertIsNotNone(result, "Should have received a CDP relay result")
            if isinstance(result, Exception):
                self.fail(f"CDP relay raised an exception: {result}")

            self.assertTrue(result["ok"], f"CDP relay should report ok=true: {result}")
            self.assertIn("result", result)
            self.assertEqual(result.get("result", {}).get("success"), True)

        finally:
            mgr.stop(timeout=5.0)

    def test_send_cdp_relay_error_response(self):
        """CDP relay should handle error responses from the extension."""
        if not self._has_binary:
            self.skipTest("Go binary not built")

        mgr = CaptureManager()
        try:
            mgr.start()

            import threading as t
            import time as _time

            result_holder = [None]

            def _send_relay():
                try:
                    result = mgr.send_cdp_relay(
                        method="Invalid.method",
                        tab_id=99,
                        timeout=15.0,
                    )
                    result_holder[0] = result
                except Exception as exc:
                    result_holder[0] = exc

            relay_thread = t.Thread(target=_send_relay, daemon=True)
            relay_thread.start()

            # Wait for the forward
            forward = None
            deadline = _time.time() + 10.0
            while _time.time() < deadline and forward is None:
                forward = mgr.get_pending_cdp_forward(block=True, timeout=1.0)

            self.assertIsNotNone(forward)
            forward_id = forward.get("id", "")

            # Send an error result back
            mgr.send_cdp_relay_result(
                forward_id=forward_id,
                error="Invalid CDP method: Invalid.method",
            )

            relay_thread.join(timeout=10.0)
            result = result_holder[0]
            self.assertIsNotNone(result)
            if isinstance(result, Exception):
                self.fail(f"CDP relay error test raised: {result}")

            self.assertFalse(result["ok"], f"CDP relay should report ok=false for error: {result}")
            self.assertIn("error", result)
            self.assertTrue(
                "Invalid CDP method" in result.get("error", ""),
                f"Error should contain 'Invalid CDP method': {result.get('error')}",
            )

        finally:
            mgr.stop(timeout=5.0)


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
