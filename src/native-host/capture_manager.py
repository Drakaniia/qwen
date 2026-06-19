"""Manages the qwin-capture Go companion binary subprocess.

The CaptureManager is responsible for:
- Locating the qwin-capture binary in tools/capture/
- Spawning it as a subprocess
- Sending JSON commands with native messaging framing
- Receiving JSON responses
- Graceful lifecycle management (start, stop, restart)

This module mirrors the pattern used by download_task.py for managing
subprocess-based download tools (aria2c, N_m3u8DL-RE, etc.).
"""

import json
import os
import struct
import subprocess
import threading
from pathlib import Path

from native_protocol import HostError


def _resolve_capture_binary():
    """Locate the qwin-capture binary relative to the project root.

    Search order:
    1. tools/capture/qwin-capture.exe (installed by install-capture.ps1)
    2. go/qwin-capture.exe (development build)
    """
    # Walk up from this file's location to find the project root
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "tools").is_dir() and (parent / "go").is_dir():
            break
    else:
        # Fallback to a reasonable guess
        parent = current.parent

    candidates = [
        parent / "tools" / "capture" / "qwin-capture.exe",
        parent / "go" / "qwin-capture.exe",
    ]

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return None


def _read_native_message(stream):
    """Read one JSON message from a native messaging framed stream."""
    raw_length = stream.read(4)
    if raw_length == b"":
        return None
    if len(raw_length) != 4:
        raise HostError("Capture binary sent an incomplete length prefix.")

    message_length = struct.unpack("=I", raw_length)[0]
    if message_length > 64 * 1024 * 1024:
        raise HostError("Capture binary sent a message that is too large.")

    raw_payload = stream.read(message_length)
    if len(raw_payload) != message_length:
        raise HostError("Capture binary sent an incomplete payload.")

    return json.loads(raw_payload.decode("utf-8"))


def _write_native_message(stream, message):
    """Write a JSON message with native messaging framing to a stream."""
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)))
    stream.write(payload)
    stream.flush()


class CaptureManager:
    """Manages the lifecycle of the qwin-capture Go binary subprocess."""

    def __init__(self):
        self._process = None
        self._lock = threading.Lock()
        self._binary_path = None

    @property
    def is_available(self):
        """Check if the capture binary exists on disk."""
        return _resolve_capture_binary() is not None

    @property
    def is_running(self):
        """Check if the capture binary is currently running."""
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def start(self):
        """Start the capture binary subprocess.

        Raises HostError if the binary is not found or cannot start.
        """
        if self.is_running:
            return

        binary_path = _resolve_capture_binary()
        if not binary_path:
            raise HostError("qwin-capture binary not found. Run scripts\\install-capture.ps1 or build from go/.")

        try:
            process = subprocess.Popen(
                [binary_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False,
                bufsize=0,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except OSError as exc:
            raise HostError(f"Could not start qwin-capture: {exc}") from exc

        with self._lock:
            self._process = process
            self._binary_path = binary_path

    def stop(self, timeout=5.0):
        """Gracefully stop the capture binary by sending a stop command.

        Falls back to process termination if the binary does not respond.
        """
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                self._process = None
                return

        try:
            response = self.send_command("stop", {})
            if response and response.get("type") == "done":
                process.wait(timeout=timeout)
        except Exception:
            pass

        with self._lock:
            if self._process and self._process.poll() is None:
                try:
                    if self._process.stdin:
                        self._process.stdin.close()
                except Exception:
                    pass
                try:
                    self._process.terminate()
                    self._process.wait(timeout=3)
                except Exception:
                    try:
                        self._process.kill()
                    except Exception:
                        pass
                try:
                    if self._process.stdout:
                        self._process.stdout.close()
                except Exception:
                    pass
                try:
                    if self._process.stderr:
                        self._process.stderr.close()
                except Exception:
                    pass
            self._process = None

    def send_command(self, command_type, data=None, timeout=10.0):
        """Send a JSON command to the capture binary and await the response.

        Args:
            command_type: The command type string (e.g., "status", "cdpCommand").
            data: Optional dict payload to include in the "data" field.
            timeout: Maximum seconds to wait for a response.

        Returns:
            The parsed JSON response dict.

        Raises:
            HostError: If the binary is not running or does not respond.
        """
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise HostError("qwin-capture is not running. Call start() first.")

            stdin = process.stdin
            stdout = process.stdout
            if stdin is None or stdout is None:
                raise HostError("qwin-capture process has no stdio pipes.")

        command_id = f"py_{os.urandom(4).hex()}"

        message = {"type": command_type, "id": command_id}
        if data is not None:
            message["data"] = data

        event = threading.Event()
        response_holder = [None]
        error_holder = [None]

        def _reader():
            try:
                while True:
                    response = _read_native_message(stdout)
                    if response is None:
                        break
                    if response.get("id") == command_id:
                        response_holder[0] = response
                        event.set()
                        break
                    # Ignore messages with other IDs (they belong to other commands)
            except Exception as exc:
                error_holder[0] = exc
                event.set()

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        _write_native_message(stdin, message)

        if not event.wait(timeout=timeout):
            raise HostError(f"qwin-capture did not respond to '{command_type}' within {timeout}s.")

        if error_holder[0]:
            raise HostError(f"Error reading from capture binary: {error_holder[0]}")

        return response_holder[0]

    def get_capture_status(self):
        """Get the current status of the capture binary.

        Returns a dict with status information, or a default offline status
        if the binary is not available or not running.
        """
        if not self.is_available:
            return {
                "cdmAvailable": False,
                "cdmVersion": "",
                "l1Only": False,
                "captureReady": False,
                "error": "qwin-capture binary not installed",
            }

        if not self.is_running:
            try:
                self.start()
            except HostError as exc:
                return {
                    "cdmAvailable": False,
                    "cdmVersion": "",
                    "l1Only": False,
                    "captureReady": False,
                    "error": str(exc),
                }

        try:
            response = self.send_command("status", timeout=5.0)
            if response.get("type") != "cdmStatus":
                return {
                    "cdmAvailable": False,
                    "cdmVersion": "",
                    "l1Only": False,
                    "captureReady": False,
                    "error": "Unexpected response type",
                }
            return {
                "cdmAvailable": response.get("cdmAvailable", False),
                "cdmVersion": response.get("cdmVersion", ""),
                "l1Only": response.get("l1Only", False),
                "captureReady": response.get("captureReady", False),
                "version": response.get("version", ""),
            }
        except HostError as exc:
            return {
                "cdmAvailable": False,
                "cdmVersion": "",
                "l1Only": False,
                "captureReady": False,
                "error": str(exc),
            }


# Module-level singleton
_CAPTURE_MANAGER = None


def get_capture_manager():
    """Return the module-level CaptureManager singleton."""
    global _CAPTURE_MANAGER
    if _CAPTURE_MANAGER is None:
        _CAPTURE_MANAGER = CaptureManager()
    return _CAPTURE_MANAGER


def capture_available():
    """Check if the capture binary is installed (fast check, no subprocess spawn)."""
    return get_capture_manager().is_available


def capture_status():
    """Get capture status (may start the binary to query it)."""
    return get_capture_manager().get_capture_status()


def send_cdp_command(method, params=None, tab_id=0):
    """Send a CDP command through the capture binary relay.

    The Go binary receives the command and relays it through the extension
    to chrome.debugger.sendCommand. The response comes back through the
    same relay chain.
    """
    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {"method": method, "tabId": tab_id}
    if params is not None:
        data["params"] = params

    return manager.send_command("cdpCommand", data=data)
