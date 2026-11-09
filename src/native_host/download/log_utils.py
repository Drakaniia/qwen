#!/usr/bin/env python3
"""log_utils — Pure helpers for the JSONL download log.

Side-effect-free core (redaction, noise filtering, rotation math) kept
separate from DownloadLogger's imperative shell (file I/O under a lock),
so every function here is testable without mocks or temp files.
"""

import os
import re
from pathlib import Path

# Secrets must never reach the gitignored JSONL log. _write() redacts every
# string it is handed: header values (Cookie/Authorization), signed-URL query
# params (h/e/sig/…) and temp cookie/config file stems. Keep the patterns
# narrow — a broad "redact long tokens" rule would eat filenames and hashes.
_HEADER_VALUE_RE = re.compile(r"(?i)(cookie|authorization)(\s*:\s*)([^\n\"'\]]+)")
# Signed-URL query params across the common CDNs: YouTube (`sig`, `lsig`), CloudFront
# (`Signature`, `Policy`, `Key-Pair-Id`), S3 SigV4 (`X-Amz-*`), Akamai (`hdnts`), and
# the generic `token` / `access_token` / `auth` / `key`. Expiry timestamps stay readable.
_SIGNED_PARAM_RE = re.compile(
    r"(?i)([?&](?:h|e|sig|lsig|signature|token|access_token|auth|key|policy|key-pair-id|hdnts|"
    r"x-amz-[a-z0-9-]+)=)([^&\"'\s#]+)"
)
_TEMP_COOKIES_RE = re.compile(r"qwin-cookies-[^\"'\s\\/,]*\.txt")
_TEMP_HDRS_RE = re.compile(r"qwin-ytdlp-hdrs-[^\"'\s\\/,]*\.conf")

# Progress spam that once made 32 log lines cost 21 KB: yt-dlp reprints
# `[download] …%` / `[download] …KiB at …` per progress tick, and ffmpeg
# reprints `frame= … fps= …` the same way. Neither ever carries an error —
# errors arrive as `ERROR: …` lines — so both are safe to drop from tails.
# A bare `frame= 12` (no fps/time/size markers) is kept: that shape is a
# status line from a failing tool, not a progress repaint.
_DOWNLOAD_PROGRESS_RE = re.compile(r"^\[download\]\s")
_FFMPEG_PROGRESS_RE = re.compile(r"^frame=\s*\d+.*\b(fps|time|size|bitrate)=", re.IGNORECASE)

# Append-only growth cap: rotate at ~1 MB, keeping the newest 2000 lines.
# A single download's failure tail is a few KB after noise filtering, so
# 2000 lines always hold the recent jobs an LLM needs for debugging.
_MAX_LOG_BYTES = 1_000_000
_KEEP_LINES = 2000


def _redact_str(value: str) -> str:
    redacted = _HEADER_VALUE_RE.sub(lambda m: f"{m.group(1)}:{m.group(2)}[REDACTED]", value)
    redacted = _SIGNED_PARAM_RE.sub(r"\1[REDACTED]", redacted)
    redacted = _TEMP_COOKIES_RE.sub("qwin-cookies-[REDACTED].txt", redacted)
    redacted = _TEMP_HDRS_RE.sub("qwin-ytdlp-hdrs-[REDACTED].conf", redacted)
    return redacted


def _redact_obj(obj):
    if isinstance(obj, str):
        return _redact_str(obj)
    if isinstance(obj, list):
        return [_redact_obj(item) for item in obj]
    if isinstance(obj, dict):
        return {key: _redact_obj(val) for key, val in obj.items()}
    return obj


def _normalize_exit_code(exit_code: int) -> dict:
    """Decode a raw process exit code into signed/hex + crash flag.

    Windows reports 32-bit unsigned codes, so a native crash (e.g. an
    NTSTATUS like 0xC0000005, or ffmpeg's 2812791560) arrives as a large
    positive int indistinguishable from a normal 1. Codes with the high bit
    set — or negative Unix signal codes — are annotated, never replaced.
    """
    extra: dict = {}
    try:
        code = int(exit_code)
    except (TypeError, ValueError):
        return extra
    signed = code - 2**32 if code >= 2**31 else code
    if signed < 0:
        extra["exitCodeSigned"] = signed
        extra["exitCodeHex"] = f"0x{code & 0xFFFFFFFF:08X}"
        extra["crashed"] = True
    return extra


def is_noise_line(line: str) -> bool:
    """True for progress repaints that carry no diagnostic value."""
    text = str(line or "")
    return bool(_DOWNLOAD_PROGRESS_RE.match(text) or _FFMPEG_PROGRESS_RE.match(text))


def clean_tail(lines) -> list:
    """Drop progress noise from a failure tail; never return empty for non-empty input."""
    kept = [line for line in lines if not is_noise_line(line)]
    if kept or not lines:
        return kept
    return [lines[-1]]


def resolve_log_path(filename: str = "downloads.jsonl") -> Path:
    """Resolve the log file path without counting parent directories.

    The repo root is the ancestor holding `package.json` (robust to this
    file moving within `src/`); the log lives at `<root>/src/logs/`. Falls
    back to `%TEMP%\\qwin_logs\\` when the tree is not writable (e.g. an
    installed read-only copy).
    """
    here = Path(__file__).resolve()
    root = next((p for p in (here, *here.parents) if (p / "package.json").is_file()), None)
    if root is not None:
        try:
            log_dir = root / "src" / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            test_file = log_dir / ".qwin_write_test"
            test_file.write_text("")
            test_file.unlink()
            return log_dir / filename
        except OSError:
            pass
    fallback_dir = Path(os.environ.get("TEMP", os.environ.get("TMPDIR", "/tmp"))) / "qwin_logs"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    return fallback_dir / filename


def prune_lines(lines: list) -> list:
    """Newest lines that fit the byte budget (newest 2000 at most).

    A single failure tail can be KBs after filtering, so capping the line
    count alone can leave the file over budget — and then every later write
    would pay a full rewrite. Halve until it fits instead.
    """
    kept = lines[-_KEEP_LINES:]
    while len(kept) > 1 and len("\n".join(kept).encode("utf-8")) > _MAX_LOG_BYTES:
        kept = kept[len(kept) // 2 :]
    return kept


def maybe_rotate(path: Path) -> None:
    """Truncate an overgrown log to its newest lines. No-op when under budget."""
    try:
        if path.stat().st_size <= _MAX_LOG_BYTES:
            return
        lines = path.read_text(encoding="utf-8").splitlines()
        path.write_text("\n".join(prune_lines(lines)) + "\n", encoding="utf-8")
    except OSError:
        pass  # Logging must never crash a download
