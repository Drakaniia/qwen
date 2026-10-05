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
DOWNLOAD_CANCEL     — The download was cancelled by the user.DOWNLOAD_PAUSE      — The download was paused.
PROBE_START         — A parallel probe round was launched.
PROBE_RESULT        — An individual backend probe finished.
PROBE_WIN           — A winning backend was selected.
PROBE_ALL_FAIL      — All probes failed."""

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from log_utils import _normalize_exit_code, _redact_obj, _redact_str, clean_tail, maybe_rotate, resolve_log_path

__all__ = ["DownloadLogger", "get_logger", "_redact_str"]


def _default_log_path() -> Path:
    """Resolve the default log file path.

    Development logs go to `<repo-root>/src/logs/downloads.jsonl`
    (see `log_utils.resolve_log_path` — the root is found by marker, not
    by counting parents). Falls back to `%TEMP%\\qwin_logs\\` when the
    tree is not writable.
    """
    return resolve_log_path("downloads.jsonl")


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
        # Track which download IDs have already received a terminal event
        # (DOWNLOAD_COMPLETE, DOWNLOAD_ERROR, DOWNLOAD_CANCEL).  Only the
        # first terminal event per download_id is written; subsequent calls
        # are silently dropped so a download cannot be both complete and failed.
        self._terminated: set[str] = set()

    @property
    def log_path(self) -> Path:
        return self._path

    # ── High-level helpers ─────────────────────────────────────────────────

    def init(
        self,
        download_id: str,
        url: str,
        page_url: str = "",
        fmt: str = "",
        selected_format: str = "best",
        backend: str = "auto",
        extract_audio: bool = False,
        audio_format: str = "",
        title: str = "",
        download_folder: str = "",
    ) -> None:
        """Log that a new download was initiated."""
        self._output_lines[download_id] = []
        self._write(
            {
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
            }
        )

    def attempt_start(self, download_id: str, attempt_num: int, label: str, command: list[str]) -> None:
        """Log that a new subprocess attempt is starting."""
        # Re-created per attempt: attempt_end() pops the buffer, so without
        # this every attempt after the first would log no output at all
        # (attempt_line drops lines when the key is missing).
        self._output_lines[download_id] = []
        self._write(
            {
                "event": "ATTEMPT_START",
                "downloadId": download_id,
                "attemptNumber": attempt_num,
                "label": label,
                "command": command,
            }
        )

    def attempt_line(self, download_id: str, line: str) -> None:
        """Log a single output line from the running process.

        This is called for *every* line so the log contains the full
        process output, not just the last N lines.
        """
        lines = self._output_lines.get(download_id)
        if lines is not None:
            lines.append(line)

    def attempt_end(
        self,
        download_id: str,
        attempt_num: int,
        exit_code: int,
        recent_lines: list[str] | None = None,
    ) -> None:
        """Log that a subprocess attempt finished with an exit code.

        Also flushes the buffered output lines as a single entry so they
        appear together in the log. On failure the tail of `recent_lines`
        (DownloadTask.recent_lines, the un-collapsed last 25 lines) is logged
        instead of just the StageLogCollapser first/last pair — a failure
        needs the tail, and DIAG lines are kept either way. Progress
        repaints carry no errors, so they are filtered out of the tail.
        """
        lines = self._output_lines.pop(download_id, [])
        self._output_lines[download_id] = []
        entry: dict = {
            "event": "ATTEMPT_END",
            "downloadId": download_id,
            "attemptNumber": attempt_num,
            "exitCode": exit_code,
        }
        entry.update(_normalize_exit_code(exit_code))
        if exit_code != 0 and recent_lines:
            tail = [str(line) for line in recent_lines if str(line)]
            diag = [line for line in lines if line.startswith("[DIAG]")]
            output = "\n".join([*diag, *clean_tail(tail)])
            if output:
                entry["output"] = output
        elif lines:
            # Join all lines into a single string with newline separators
            entry["output"] = "\n".join(lines)
        self._write(entry)

    def fallback(self, download_id: str, attempt_num: int, from_label: str, to_label: str) -> None:
        """Log a fallback from one strategy to another."""
        self._write(
            {
                "event": "FALLBACK",
                "downloadId": download_id,
                "attemptNumber": attempt_num,
                "fromLabel": from_label,
                "toLabel": to_label,
            }
        )

    def complete(
        self,
        download_id: str,
        filepath: str = "",
        artifact_root: str = "",
        duration_seconds: float = 0.0,
        message: str = "",
    ) -> None:
        """Log a successful download.

        No-op if a terminal event was already logged for this download_id
        (DOWNLOAD_COMPLETE, DOWNLOAD_ERROR, or DOWNLOAD_CANCEL).
        """
        with self._lock:
            if download_id in self._terminated:
                return
            self._terminated.add(download_id)
        self._write(
            {
                "event": "DOWNLOAD_COMPLETE",
                "downloadId": download_id,
                "filepath": filepath,
                "artifactRoot": artifact_root,
                "durationSeconds": round(duration_seconds, 1),
                "message": message,
            }
        )

    def error(
        self,
        download_id: str,
        error_text: str,
        duration_seconds: float = 0.0,
        attempt_number: int | None = None,
    ) -> None:
        """Log a failed download with the full error text.

        `attempt_number` links the outcome to its ATTEMPT_END entry, which
        already holds the per-attempt output — readers join on
        downloadId + attemptNumber instead of re-reading duplicated text.

        No-op if a terminal event was already logged for this download_id.
        """
        with self._lock:
            if download_id in self._terminated:
                return
            self._terminated.add(download_id)
        entry: dict = {
            "event": "DOWNLOAD_ERROR",
            "downloadId": download_id,
            "error": error_text,
            "durationSeconds": round(duration_seconds, 1),
        }
        if attempt_number is not None:
            entry["attemptNumber"] = attempt_number
        self._write(entry)

    def cancel(self, download_id: str, message: str = "") -> None:
        """Log a cancelled download.

        No-op if a terminal event was already logged for this download_id.
        """
        with self._lock:
            if download_id in self._terminated:
                return
            self._terminated.add(download_id)
        self._write(
            {
                "event": "DOWNLOAD_CANCEL",
                "downloadId": download_id,
                "message": message,
            }
        )

    def pause(self, download_id: str, message: str = "") -> None:
        """Log a paused download."""
        self._write(
            {
                "event": "DOWNLOAD_PAUSE",
                "downloadId": download_id,
                "message": message,
            }
        )

    # ── Probe event helpers ────────────────────────────────────────────────

    def probe_start(self, url: str, backends: list[str], download_id: str = "") -> None:
        """Log that a parallel probe round was launched."""
        self._write(
            {
                "event": "PROBE_START",
                "downloadId": download_id,
                "url": url,
                "backends": backends,
            }
        )

    def probe_result(
        self,
        backend: str,
        ok: bool,
        duration_ms: int,
        error_type: str | None = None,
        download_id: str = "",
    ) -> None:
        """Log an individual backend probe result."""
        entry: dict = {
            "event": "PROBE_RESULT",
            "downloadId": download_id,
            "backend": backend,
            "ok": ok,
            "durationMs": duration_ms,
        }
        if error_type is not None:
            entry["errorType"] = error_type
        self._write(entry)

    def probe_win(self, backend: str, label: str, download_id: str = "") -> None:
        """Log the winning backend selected."""
        self._write(
            {
                "event": "PROBE_WIN",
                "downloadId": download_id,
                "backend": backend,
                "label": label,
            }
        )

    def probe_all_fail(self, url: str, backends: list[str], errors: list, download_id: str = "") -> None:
        """Log that all probes failed, with aggregated error details.

        Parameters
        ----------
        url : str
            The URL that was probed.
        backends : list[str]
            List of backends that were tried.
        errors : list[ProbeError]
            ProbeError objects with details per backend.
        """
        error_dicts = []
        for e in errors:
            d = {
                "backend": e.backend,
                "label": e.label,
                "errorType": e.error_type,
                "message": e.message,
            }
            if e.status_code is not None:
                d["statusCode"] = e.status_code
            if e.raw_output is not None:
                d["rawOutput"] = e.raw_output
            if e.duration_ms:
                d["durationMs"] = e.duration_ms
            error_dicts.append(d)

        self._write(
            {
                "event": "PROBE_ALL_FAIL",
                "downloadId": download_id,
                "url": url,
                "backends": backends,
                "errors": error_dicts,
            }
        )

    # ── Low-level writer ───────────────────────────────────────────────────

    def _write(self, entry: dict) -> None:
        """Append a single JSON entry to the log file.

        Thread-safe via an instance lock. Secrets are redacted before the
        write so Cookie/Authorization values and signed-URL tokens never
        reach the gitignored log. The file is rotated to its newest lines
        when over budget, so it cannot grow without bound.
        """
        entry = _redact_obj(entry)
        entry["timestamp"] = datetime.now(timezone.utc).isoformat()
        with self._lock:
            try:
                maybe_rotate(self._path)
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
