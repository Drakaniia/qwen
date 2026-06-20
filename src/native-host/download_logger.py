#!/usr/bin/env python3
"""
download_logger — Structured JSONL download log for AI-assisted debugging.

Writes timestamped JSON entries to logs/downloads.jsonl (relative to the
project root) for every download attempt. Each line is a self-contained
JSON object that an LLM or script can parse, filter, and analyse.

Event types
-----------
DOWNLOAD_INIT       — A new download was requested.
ATTEMPT_START       — A specific command/subprocess is being launched.
ATTEMPT_LINE        — A line of stdout/stderr from the running process.
ATTEMPT_END         — The process exited with a given code.
FALLBACK            — Switching to a fallback strategy.
DOWNLOAD_COMPLETE   — The download finished successfully.
DOWNLOAD_ERROR      — The download failed with an error message.
DOWNLOAD_CANCEL     — The download was cancelled by the user.
DOWNLOAD_PAUSE      — The download was paused.
"""

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _default_log_path() -> Path:
    """Resolve the default log file path.

    In development, logs are written to <project-root>/logs/downloads.jsonl.
    The project root is determined by walking up from this file's location
    (src/native-host/download_logger.py → src/native-host/ → src/ → project root).

    If the resolved path is not writable (e.g. installed read-only), falls
    back to %TEMP%\\qwin_logs\\downloads.jsonl.
    """
    try:
        project_root = Path(__file__).resolve().parent.parent.parent
        log_dir = project_root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        test_file = log_dir / ".qwin_write_test"
        test_file.write_text("")
        test_file.unlink()
        return log_dir / "downloads.jsonl"
    except (OSError, PermissionError):
        fallback_dir = Path(os.environ.get("TEMP", os.environ.get("TMPDIR", "/tmp"))) / "qwin_logs"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        return fallback_dir / "downloads.jsonl"


class DownloadLogger:
    """Thread-safe logger that appends JSONL entries to a log file.

    Usage:
        logger = DownloadLogger()
        logger.init(download_id="job_123", url="https://...", ...)

    Each entry has at minimum:
      - timestamp: ISO-8601 string in UTC
      - downloadId: the unique job ID
      - event: the event type string
      - ...event-specific fields
    """

    def __init__(self, log_path: Optional[Path] = None):
        self._lock = threading.Lock()
        self._path = log_path or _default_log_path()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Track per-download captures: downloadId → list of output lines
        self._output_lines: dict[str, list[str]] = {}

    @property
    def log_path(self) -> Path:
        return self._path

    # ── High-level helpers ─────────────────────────────────────────────────

    def init(self, download_id: str, url: str, page_url: str = "", fmt: str = "",
             selected_format: str = "best", backend: str = "auto",
             extract_audio: bool = False, audio_format: str = "",
             title: str = "", download_folder: str = "") -> None:
        """Log that a new download was initiated."""
        self._output_lines[download_id] = []
        self._write({
            "event": "DOWNLOAD_INIT",
            "downloadId": download_id,
            "url": url,
            "pageUrl": page_url,
            "format": fmt,
            "selectedFormat": selected_format,
            "backend": backend,
            "extractAudio": extract_audio,
            "audioFormat": audio_format,
            "title": title,
            "downloadFolder": download_folder,
        })

    def attempt_start(self, download_id: str, attempt_num: int,
                      label: str, command: list[str]) -> None:
        """Log that a new subprocess attempt is starting."""
        self._write({
            "event": "ATTEMPT_START",
            "downloadId": download_id,
            "attemptNumber": attempt_num,
            "label": label,
            "command": command,
        })

    def attempt_line(self, download_id: str, line: str) -> None:
        """Log a single output line from the running process.

        This is called for *every* line so the log contains the full
        process output, not just the last N lines.
        """
        lines = self._output_lines.get(download_id)
        if lines is not None:
            lines.append(line)

    def attempt_end(self, download_id: str, attempt_num: int,
                    exit_code: int) -> None:
        """Log that a subprocess attempt finished with an exit code.

        Also flushes the buffered output lines as a single entry so they
        appear together in the log.
        """
        lines = self._output_lines.pop(download_id, [])
        entry = {
            "event": "ATTEMPT_END",
            "downloadId": download_id,
            "attemptNumber": attempt_num,
            "exitCode": exit_code,
        }
        if lines:
            # Join all lines into a single string with newline separators
            entry["output"] = "\n".join(lines)
        self._write(entry)

    def fallback(self, download_id: str, attempt_num: int,
                 from_label: str, to_label: str) -> None:
        """Log a fallback from one strategy to another."""
        self._write({
            "event": "FALLBACK",
            "downloadId": download_id,
            "attemptNumber": attempt_num,
            "fromLabel": from_label,
            "toLabel": to_label,
        })

    def complete(self, download_id: str, filepath: str = "",
                 artifact_root: str = "", duration_seconds: float = 0.0,
                 message: str = "") -> None:
        """Log a successful download."""
        self._write({
            "event": "DOWNLOAD_COMPLETE",
            "downloadId": download_id,
            "filepath": filepath,
            "artifactRoot": artifact_root,
            "durationSeconds": round(duration_seconds, 1),
            "message": message,
        })

    def error(self, download_id: str, error_text: str,
              duration_seconds: float = 0.0) -> None:
        """Log a failed download with the full error text."""
        self._write({
            "event": "DOWNLOAD_ERROR",
            "downloadId": download_id,
            "error": error_text,
            "durationSeconds": round(duration_seconds, 1),
        })

    def cancel(self, download_id: str, message: str = "") -> None:
        """Log a cancelled download."""
        self._write({
            "event": "DOWNLOAD_CANCEL",
            "downloadId": download_id,
            "message": message,
        })

    def pause(self, download_id: str, message: str = "") -> None:
        """Log a paused download."""
        self._write({
            "event": "DOWNLOAD_PAUSE",
            "downloadId": download_id,
            "message": message,
        })

    # ── Low-level writer ───────────────────────────────────────────────────

    def _write(self, entry: dict) -> None:
        """Append a single JSON entry to the log file.

        Thread-safe via an instance lock.
        """
        entry["timestamp"] = datetime.now(timezone.utc).isoformat()
        with self._lock:
            try:
                with open(self._path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False, default=str))
                    f.write("\n")
            except OSError:
                pass  # Silently ignore write errors — logging should never crash a download


# Module-level singleton so all callers share one logger instance.
_default_logger = None
_default_logger_lock = threading.Lock()


def get_logger(log_path: Optional[Path] = None) -> DownloadLogger:
    """Return the shared DownloadLogger singleton.

    Pass ``log_path`` only on the very first call to override the default
    log file location.
    """
    global _default_logger
    with _default_logger_lock:
        if _default_logger is None:
            _default_logger = DownloadLogger(log_path=log_path)
        return _default_logger
