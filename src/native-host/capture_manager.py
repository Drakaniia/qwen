"""Manages the qwin-capture Go companion binary subprocess.

The CaptureManager is responsible for:
- Locating the qwin-capture binary in tools/capture/
- Spawning it as a subprocess
- Sending JSON commands with native messaging framing
- Receiving JSON responses via a single persistent background reader
- Graceful lifecycle management (start, stop, restart)
- Async CDP relay forwarding from the Go binary to the extension

Architecture:
  A single background reader thread reads ALL messages from Go's stdout.
  Every message is put into a single incoming queue. The send_command()
  method reads from this queue to find responses matching its command ID.
  Async CDP relay forwards (type == "cdpRelayForward") are automatically
  routed to a separate queue for external consumption.
"""

import json
import os
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path

from native_protocol import HostError


def _resolve_capture_binary():
    """Locate the qwin-capture binary relative to the project root.

    Search order:
    1. tools/capture/qwin-capture.exe (installed by install-capture.ps1)
    2. go/qwin-capture.exe (development build)
    """
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "tools").is_dir() and (parent / "go").is_dir():
            break
    else:
        parent = current.parent

    candidates = [
        parent / "tools" / "capture" / "qwin-capture.exe",
        parent / "go" / "qwin-capture.exe",
    ]

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return None


def _resolve_cdm_status_file():
    """Locate the CDM status.json file written by install-cdm.ps1.

    Returns the parsed status dict, or None if not found or invalid.
    """
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "tools").is_dir() and (parent / "go").is_dir():
            break
    else:
        parent = current.parent

    status_path = parent / "tools" / "cdm" / "status.json"
    if not status_path.is_file():
        return None

    try:
        raw = status_path.read_text("utf-8", errors="replace")
        data = json.loads(raw)
        if data.get("cdmAvailable") and data.get("cdmPath"):
            return {
                "cdmPath": str(data["cdmPath"]),
                "cdmVersion": str(data.get("cdmVersion", "")),
                "l1Only": bool(data.get("l1Only", False)),
            }
    except (json.JSONDecodeError, OSError):
        pass

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

        # Single background reader state
        self._reader_thread = None
        self._reader_stop = threading.Event()

        # Single incoming queue: ALL messages from Go's stdout go here.
        # send_command reads from this queue to find matching responses.
        self._incoming_queue = queue.Queue()

        # Queue for async CDP relay forwards from Go
        self._cdp_forward_queue = queue.Queue()

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

        # Drain stale sentinels from previous sessions
        for q in (self._incoming_queue, self._cdp_forward_queue):
            while not q.empty():
                try:
                    q.get_nowait()
                except queue.Empty:
                    break

        # Start the single background reader thread
        self._start_background_reader()

        # Small delay to ensure the reader thread is actively reading stdout
        # before any commands are sent (avoids race conditions on Windows).
        import time as _time

        _time.sleep(0.05)

        # Auto-initialize the CDM from the install-cdm.ps1 status file
        try:
            self._auto_init_cdm()
        except Exception:
            pass

    def _auto_init_cdm(self):
        """Automatically initialize the Widevine CDM from the installer status file.

        After starting the Go binary, check if install-cdm.ps1 has written
        tools/cdm/status.json with a successful CDM installation. If so,
        forward the CDM path to the Go binary via cdmInit so that subsequent
        cdmStatus / status queries return accurate availability information.
        """
        cdm_info = _resolve_cdm_status_file()
        if cdm_info is None:
            return

        cdm_path = cdm_info["cdmPath"]
        if not cdm_path:
            return

        try:
            response = self.send_command(
                "cdmInit",
                data={"cdmPath": cdm_path},
                timeout=15.0,
            )
            if response.get("ok"):
                print(
                    f"[capture_manager] CDM auto-init successful: "
                    f"version={response.get('cdmVersion', '')} "
                    f"l1Only={response.get('l1Only', False)}",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[capture_manager] CDM auto-init failed: {response.get('error', 'unknown')}",
                    file=sys.stderr,
                )
        except HostError as exc:
            # CDM init may fail if the Go binary doesn't support it yet,
            # or if the CDM path is invalid. Non-fatal.
            print(
                f"[capture_manager] CDM auto-init error: {exc}",
                file=sys.stderr,
            )

    def _start_background_reader(self):
        """Start a single daemon thread that reads ALL messages from Go's stdout.

        Every message from Go's stdout is put into self._incoming_queue.
        The send_command() method reads from this queue to find command
        responses. Async CDP relay forwards are routed to the separate
        _cdp_forward_queue for external consumption.
        """
        if self._reader_thread is not None and self._reader_thread.is_alive():
            return

        self._reader_stop.clear()

        def _reader_loop():
            try:
                stdout = self._process.stdout
                if stdout is None:
                    return

                while not self._reader_stop.is_set():
                    try:
                        message = _read_native_message(stdout)
                    except Exception:
                        break

                    if message is None:
                        break

                    # Put ALL messages into the incoming queue.
                    # send_command will consume matching responses;
                    # everything else (cdpRelayForward, etc.) gets routed
                    # from there.
                    self._incoming_queue.put(message)

            except Exception:
                pass
            finally:
                # Signal EOF to any thread waiting in send_command
                self._incoming_queue.put(None)

        self._reader_thread = threading.Thread(target=_reader_loop, daemon=True)
        self._reader_thread.start()

    def stop(self, timeout=5.0):
        """Gracefully stop the capture binary subprocess.

        Closes stdin to signal the process to exit, waits for it to
        finish, then closes stdout/stderr and joins the background
        reader thread to prevent ResourceWarnings from unclosed pipes.
        """
        self._reader_stop.set()

        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                self._process = None
                return

        # Close stdin first to signal EOF to the subprocess.
        # This causes the Go binary to exit cleanly, which in turn
        # closes stdout/stderr on its side and unblocks the reader.
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:
            pass

        # Wait for the process to exit naturally
        try:
            process.wait(timeout=timeout)
        except Exception:
            pass

        # If the process is still alive, force-terminate it
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=3)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

        # Close stdout and stderr from our side
        for pipe_name in ("stdout", "stderr"):
            try:
                pipe = getattr(process, pipe_name, None)
                if pipe:
                    pipe.close()
            except Exception:
                pass

        # Join the background reader thread so it releases its reference
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=2)

        with self._lock:
            self._process = None

    def send_command(self, command_type, data=None, timeout=10.0):
        """Send a JSON command to the capture binary and await the response.

        Writes the command to Go's stdin, then reads from the background
        reader's incoming queue until a matching response (by command ID)
        is received. Async CDP relay forwards are automatically routed
        to the separate _cdp_forward_queue.

        Args:
            command_type: The command type string (e.g., "status", "echo").
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
            if stdin is None:
                raise HostError("qwin-capture process has no stdin pipe.")

        command_id = f"py_{os.urandom(4).hex()}"

        message = {"type": command_type, "id": command_id}
        if data is not None:
            message["data"] = data

        _write_native_message(stdin, message)

        # Read from the incoming queue until we find our response
        import time as _time

        deadline = _time.time() + timeout
        while _time.time() < deadline:
            remaining = deadline - _time.time()
            if remaining <= 0:
                break

            try:
                incoming = self._incoming_queue.get(block=True, timeout=min(remaining, 1.0))
            except queue.Empty:
                continue

            if incoming is None:
                raise HostError(f"qwin-capture process exited while waiting for '{command_type}' response.")

            msg_id = incoming.get("id", "")
            msg_type = incoming.get("type", "")

            # Match by command ID — this is our response
            if msg_id == command_id:
                return incoming

            # Async CDP relay forwards go to the separate queue
            if msg_type == "cdpRelayForward":
                self._cdp_forward_queue.put(incoming)
                continue

            # Unknown message — log and discard
            print(
                f"[capture_manager] Unexpected message from Go while waiting "
                f"for '{command_type}': type={msg_type} id={msg_id}",
                file=sys.stderr,
            )

        raise HostError(f"qwin-capture did not respond to '{command_type}' within {timeout}s.")

    def send_cdp_relay(self, method, params=None, tab_id=0, timeout=60.0):
        """Send a CDP command through the full relay chain.

        Flow:
          1. Send 'cdp_relay' to Go via stdin
          2. Go writes 'cdpRelayForward' to stdout (caught by background reader)
          3. Python forwards to extension → chrome.debugger
          4. Extension sends result back to Python
          5. Python calls send_cdp_relay_result() to write result to Go's stdin
          6. Go reads the result and returns it as the response

        Args:
            method: CDP method name (e.g., "Network.enable").
            params: Optional dict of CDP method parameters.
            tab_id: Browser tab ID to target.
            timeout: Maximum seconds to wait for the relay roundtrip.

        Returns:
            The CDP result dict with keys: ok, result (dict), error (str).
        """
        data = {"method": method, "tabId": tab_id}
        if params is not None:
            data["params"] = params

        response = self.send_command("cdp_relay", data=data, timeout=timeout)

        result = {"ok": response.get("ok", False), "error": response.get("error", "")}
        raw_result = response.get("result")
        if raw_result:
            result["result"] = raw_result

        return result

    def send_cdp_relay_result(self, forward_id, result=None, error=""):
        """Write a CDP relay result back to Go's stdin.

        This is called after the extension has executed the CDP command
        and returned a result. We forward the result to Go so it can
        complete the relay roundtrip.

        Args:
            forward_id: The ID from the cdpRelayForward message.
            result: Optional result dict to send back.
            error: Optional error string.
        """
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise HostError("qwin-capture is not running.")

            stdin = process.stdin
            if stdin is None:
                raise HostError("qwin-capture process has no stdin pipe.")

        message = {"id": forward_id}
        if result is not None:
            message["result"] = result
        if error:
            message["error"] = error

        _write_native_message(stdin, message)

    def get_pending_cdp_forward(self, block=False, timeout=1.0):
        """Get the next pending CDP relay forward from Go (non-blocking by default).

        Args:
            block: If True, block until a forward is available.
            timeout: Seconds to wait if block=True.

        Returns:
            The CDP forward message dict, or None if no message is available.
        """
        try:
            return self._cdp_forward_queue.get(block=block, timeout=timeout if block else 0.1)
        except queue.Empty:
            return None

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

            result = {
                "cdmAvailable": response.get("cdmAvailable", False),
                "cdmVersion": response.get("cdmVersion", ""),
                "l1Only": response.get("l1Only", False),
                "captureReady": response.get("captureReady", False),
                "version": response.get("version", ""),
            }

            # If Go reports CDM unavailable but the installer status file
            # says CDM is available, attempt auto-init and re-query.
            if not response.get("cdmAvailable") and _resolve_cdm_status_file() is not None:
                try:
                    self._auto_init_cdm()
                    # Re-query after init
                    retry = self.send_command("status", timeout=5.0)
                    if retry.get("type") == "cdmStatus":
                        result["cdmAvailable"] = retry.get("cdmAvailable", False)
                        result["cdmVersion"] = retry.get("cdmVersion", "")
                        result["l1Only"] = retry.get("l1Only", False)
                        result["captureReady"] = retry.get("captureReady", False)
                        result["version"] = retry.get("version", "")
                except HostError:
                    pass

            return result
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
    """Send a CDP command through the capture binary relay (sync).

    DEPRECATED: Use send_cdp_relay() instead for the full relay chain.
    This method sends the command directly to Go without the async relay.
    """
    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {"method": method, "tabId": tab_id}
    if params is not None:
        data["params"] = params

    return manager.send_command("cdpCommand", data=data)


def send_cdp_relay(method, params=None, tab_id=0, timeout=60.0):
    """Send a CDP command through the full relay chain (Go -> Python -> Extension -> chrome.debugger).

    Returns the CDP result after the complete roundtrip.
    """
    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()
    return manager.send_cdp_relay(method, params=params, tab_id=tab_id, timeout=timeout)


def send_cdp_relay_result(forward_id, result=None, error=""):
    """Send a CDP relay result back to Go (from extension to Go via Python)."""
    return get_capture_manager().send_cdp_relay_result(forward_id, result=result, error=error)


def get_pending_cdp_forward(block=False, timeout=1.0):
    """Get the next pending CDP relay forward from Go."""
    return get_capture_manager().get_pending_cdp_forward(block=block, timeout=timeout)


# ─── Re-export CDM API from cdm_capture ─────────────────────────────────────
#
# These functions are defined in cdm_capture.py but re-exported here so that
# host.py and other consumers can continue to import them from capture_manager.

