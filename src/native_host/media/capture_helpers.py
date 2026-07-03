"""Helper utilities for the CaptureManager Go binary subprocess management.

Extracted from capture_manager.py for modularity.
"""

import json
import struct
from pathlib import Path

from native_protocol import HostError


def resolve_capture_binary():
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


def resolve_cdm_status_file():
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


def read_native_message(stream):
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


def write_native_message(stream, message):
    """Write a JSON message with native messaging framing to a stream."""
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(payload)))
    stream.write(payload)
    stream.flush()
