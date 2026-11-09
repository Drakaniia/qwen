"""Individual backend probe functions for parallel reachability checks.

Extracted from probe_runner.py for modularity. Each probe function
checks whether a specific download backend can handle a given URL.
"""

import json
import subprocess
import tempfile
import threading
import time
from typing import Optional

from browser_context import append_browser_context_options
from process_control import creation_flags, terminate_process_tree
from stream_backends import header_args_for_n_m3u8dl_re, header_args_for_streamlink

# Probes inherit the host's cwd in dev (src/native_host/) — a misbehaving
# probe binary must not drop files into the source tree, so all three run
# with cwd pointed at the temp dir instead. Zero behavior change otherwise.
_PROBE_CWD = tempfile.gettempdir()

# Exit code reported for a probe killed by its cancel event.
PROBE_CANCELLED_EXIT_CODE = -1


def run_probe_command(command, cancel_event, timeout):
    """`subprocess.run` that a cancel can interrupt.

    The probes used `subprocess.run(timeout=30)`, which nothing can stop early: a
    download canceled while probing left up to three probe processes running for
    their full timeout. This polls `cancel_event` and kills the process tree the
    moment it is set (the runner also sets it once a winner is decided).

    Returns a CompletedProcess; a cancelled run has returncode
    `PROBE_CANCELLED_EXIT_CODE`. Raises `subprocess.TimeoutExpired` like `run`.
    """
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=_PROBE_CWD,
        creationflags=creation_flags(),
    )
    output = {}

    def communicate():
        output["stdout"], output["stderr"] = process.communicate()

    reader = threading.Thread(target=communicate, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    while True:
        reader.join(0.1)
        if not reader.is_alive():
            break
        if cancel_event.is_set() or time.monotonic() >= deadline:
            terminate_process_tree(process)
            reader.join(5)
            if not cancel_event.is_set():
                raise subprocess.TimeoutExpired(command, timeout)
            return subprocess.CompletedProcess(
                command, PROBE_CANCELLED_EXIT_CODE, output.get("stdout") or "", "Probe cancelled."
            )
    return subprocess.CompletedProcess(
        command, process.returncode, output.get("stdout") or "", output.get("stderr") or ""
    )


# ── Individual probe functions ─────────────────────────────────────────────

# Each returns a dict:
#   {
#       "ok": bool,
#       "backend": str,
#       "label": str,
#       "error_type": str | None,   # None on success
#       "message": str | None,
#       "status_code": int | None,
#       "raw_output": str | None,
#       "duration_ms": int,
#   }


def _is_cloudflare_403(stderr: str, stdout: str) -> bool:
    """Check if process output indicates a Cloudflare 403 block."""
    combined = (stderr + " " + stdout).lower()
    has_403 = "403" in combined or "http error 403" in combined or "forbidden" in combined
    if not has_403:
        return False
    # Check for Cloudflare-specific patterns in stderr/stdout
    cloudflare_hints = ["cloudflare", "cf-", "challenge-platform"]
    return any(hint in combined for hint in cloudflare_hints)


def _is_token_expired(stderr: str, stdout: str) -> bool:
    """Check if process output indicates a token/signature expiry error.

    Detects:
    - Signed URLs with "expired" keyword (410 Gone, 403 Forbidden)
    - URL contains "expires" parameter and returned 403
    - Signature/key mismatch or expired errors
    - AWS CloudFront signed URL expiry
    - Generic "has expired" error messages (no HTTP code required)

    Args:
        stderr: Stderr output from the process.
        stdout: Stdout output from the process.

    Returns:
        True if the output indicates a token/signature expiry error.
    """
    combined = (stderr + " " + stdout).lower()

    # Check for explicit "expired" keyword with HTTP error codes
    if "expired" in combined and any(code in combined for code in ["410", "403"]):
        return True

    # Check for signature/key errors
    if "signature" in combined and ("expired" in combined or "mismatch" in combined):
        return True

    # Check for CloudFront signed URL errors
    if "cloudfront" in combined and "expired" in combined:
        return True

    # Check for "expires" in the URL (signed URL pattern) with access denied
    if "/expires=" in combined.lower() or "?expires=" in combined.lower():
        if any(code in combined for code in ["403", "401"]):
            return True

    # Generic "has expired" in error messages — catches cases like
    # "This video URL has expired" without a specific HTTP status code.
    # Runs after Cloudflare/status-code checks so won't false-positive
    # on blocked-but-expired messages (those are caught above).
    if "has expired" in combined:
        return True

    return False


def probe_yt_dlp(
    url: str,
    cancel_event: threading.Event,
    yt_dlp_command: list[str],
    ffmpeg_location: Optional[str] = None,
    request_headers: Optional[list] = None,
    cookies_file: Optional[str] = None,
    referer: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> dict:
    """Run yt-dlp --skip-download --dump-single-json. Success if exit 0 + non-empty formats.

    Takes the same browser context the download uses (headers/cookies/
    referer/user-agent) so the probe does not under-report an authenticated
    manifest as unreachable.
    """
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    command = [
        *yt_dlp_command,
        "--skip-download",
        "--dump-single-json",
        "--no-config",
        "--no-cache-dir",
        "--no-warnings",
        "--ignore-errors",
        "--socket-timeout",
        "15",
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])

    append_browser_context_options(
        command,
        referer=referer,
        user_agent=user_agent,
        request_headers=request_headers,
        cookies_file=cookies_file,
        headers_config_path=None,
    )
    command.append(str(url))

    try:
        completed = run_probe_command(command, cancel_event, timeout=30)
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "timeout",
            "message": "yt-dlp probe timed out after 30 seconds",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        stderr_text = (completed.stderr or "").strip()
        stdout_text = (completed.stdout or "").strip()
        combined = stderr_text or stdout_text

        # Check for Cloudflare-specific 403 in error output
        if _is_cloudflare_403(stderr_text, stdout_text):
            return {
                "ok": False,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": "cloudflare_block",
                "message": "yt-dlp blocked by Cloudflare anti-bot protection (HTTP 403)",
                "status_code": 403,
                "raw_output": combined,
                "duration_ms": 0,
            }

        # Check for token/signature expiry before generic exit_code
        if _is_token_expired(stderr_text, stdout_text):
            return {
                "ok": False,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": "token_expired",
                "message": "yt-dlp detected token or signature expiry",
                "status_code": completed.returncode,
                "raw_output": combined,
                "duration_ms": 0,
            }

        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "exit_code",
            "message": f"yt-dlp exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": combined,
            "duration_ms": 0,
        }

    # Parse JSON output
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "parse_error",
            "message": "Failed to parse yt-dlp JSON output",
            "status_code": None,
            "raw_output": completed.stdout[:2000] if completed.stdout else "",
            "duration_ms": 0,
        }

    formats = data.get("formats") or []
    if len(formats) == 0:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "no_formats",
            "message": "yt-dlp returned no formats for this URL",
            "status_code": None,
            "raw_output": completed.stdout[:2000] if completed.stdout else "",
            "duration_ms": 0,
        }

    return {
        "ok": True,
        "backend": "yt-dlp",
        "label": "yt-dlp (skip-download)",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }


def probe_n_m3u8dl_re(
    url: str,
    cancel_event: threading.Event,
    n_m3u8dl_re_location: str,
    request_headers: Optional[list] = None,
) -> dict:
    """Probe with the same headers the download sends (else auth'd manifests 410)."""
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    # `--skip-download`, NOT `--test`: the installed
    # `N_m3u8DL-RE (Beta version) 20260628` has no `--test` option (it is absent
    # from `--help`), and its System.CommandLine parser rejects the whole argv
    # with `Unrecognized command or argument '<url>'` + exit 1 in ~100ms. So the
    # #1 priority backend was guaranteed to lose every probe, 100% of the time,
    # and never got chosen even when it would have worked. `--skip-download`
    # parses the manifest and stops, which is what the probe is asking.
    command = [
        str(n_m3u8dl_re_location),
        "--skip-download",
        *header_args_for_n_m3u8dl_re(request_headers),
        str(url),
    ]

    try:
        completed = run_probe_command(command, cancel_event, timeout=30)
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "timeout",
            "message": "N_m3u8DL-RE probe timed out",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "exit_code",
            "message": f"N_m3u8DL-RE exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": (completed.stderr or "").strip() or (completed.stdout or "").strip(),
            "duration_ms": 0,
        }

    return {
        "ok": True,
        "backend": "n_m3u8dl_re",
        "label": "N_m3u8DL-RE",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }


def probe_streamlink(
    url: str,
    cancel_event: threading.Event,
    streamlink_command: list[str],
    request_headers: Optional[list] = None,
    cookies_file: Optional[str] = None,
) -> dict:
    """Run streamlink --json URL to check stream availability.

    Forwards the download's headers/cookies — without them an auth-gated
    manifest probes empty while the real download would succeed.
    """
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    command = [
        *streamlink_command,
        "--json",
        "--no-config",
    ]
    if cookies_file:
        command.extend(["--http-cookies-file", str(cookies_file)])
    command.extend(header_args_for_streamlink(request_headers))
    command.append(str(url))

    try:
        completed = run_probe_command(command, cancel_event, timeout=30)
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "timeout",
            "message": "Streamlink probe timed out",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "exit_code",
            "message": f"Streamlink exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": (completed.stderr or "").strip() or (completed.stdout or "").strip(),
            "duration_ms": 0,
        }

    # Check for non-empty stream list
    try:
        data = json.loads(completed.stdout) if completed.stdout.strip() else {}
        streams = data.get("streams") if isinstance(data, dict) else {}
        if not streams:
            return {
                "ok": False,
                "backend": "streamlink",
                "label": "Streamlink",
                "error_type": "no_streams",
                "message": "Streamlink returned no available streams",
                "status_code": None,
                "raw_output": completed.stdout[:2000] if completed.stdout else "",
                "duration_ms": 0,
            }
    except json.JSONDecodeError:
        pass

    return {
        "ok": True,
        "backend": "streamlink",
        "label": "Streamlink",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }
