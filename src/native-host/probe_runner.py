"""probe_runner — Parallel reachability probes for download backends.

Launches lightweight reachability checks for all applicable backends
simultaneously, returns the first one to succeed, and collects errors
from the rest.

See ``parallel-reachability-spec.md`` for the full specification.
"""

import json
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

# ── Public types ───────────────────────────────────────────────────────────


@dataclass
class ProbeConfig:
    """Configuration for a single backend probe."""

    backend: str
    label: str
    probe_fn: Callable
    command: list[str]


@dataclass
class ProbeError:
    """Details of a single failed probe."""

    backend: str
    label: str
    error_type: str
    message: str
    status_code: Optional[int] = None
    raw_output: Optional[str] = None
    duration_ms: int = 0


@dataclass
class ProbeResult:
    """Outcome of a parallel probe round."""

    winner: Optional[str]
    command: Optional[list[str]]
    label: Optional[str]
    errors: list[ProbeError] = field(default_factory=list)
    duration_ms: int = 0


# ── Orchestrator ───────────────────────────────────────────────────────────


def run_parallel_probes(
    url: str,
    probes: list[ProbeConfig],
    cancel_event: threading.Event,
    send_message: Callable,
    logger,
) -> ProbeResult:
    """Launch all probes in parallel, return first success or all errors.

    Parameters
    ----------
    url : str
        The video/media URL to check.
    probes : list[ProbeConfig]
        List of probe configurations to launch.
    cancel_event : threading.Event
        Shared event for cancellation.
    send_message : Callable
        Function to send progress messages to the extension.
    logger : DownloadLogger
        Shared logger for probe events.

    Returns
    -------
    ProbeResult
        - On success: ProbeResult(winner="yt-dlp", command=[...], label="...")
        - On failure: ProbeResult(winner=None, errors=[...])
    """
    start_time = time.time()

    if cancel_event.is_set():
        return ProbeResult(winner=None, command=None, label=None, errors=[], duration_ms=0)

    if not probes:
        elapsed = int((time.time() - start_time) * 1000)
        return ProbeResult(winner=None, command=None, label=None, errors=[], duration_ms=elapsed)

    # Log probe start
    logger.probe_start(url=url, backends=[p.backend for p in probes])

    # Send initial progress message
    send_message({
        "type": "progress",
        "stage": "probing",
        "message": f"Checking {len(probes)} backend{'s' if len(probes) != 1 else ''}…",
        "backendCount": len(probes),
    })

    results_lock = threading.Lock()
    probe_results: dict[int, dict] = {}
    winner_found = threading.Event()
    errors: list[ProbeError] = []
    threads = []

    def run_probe(index: int, config: ProbeConfig):
        probe_start = time.time()
        try:
            probe_result = config.probe_fn(url, cancel_event)
        except Exception as exc:
            probe_result = {
                "ok": False,
                "backend": config.backend,
                "label": config.label,
                "error_type": "probe_error",
                "message": str(exc),
                "status_code": None,
                "raw_output": str(exc),
                "duration_ms": 0,
            }

        probe_duration = int((time.time() - probe_start) * 1000)

        with results_lock:
            probe_results[index] = probe_result
            probe_result["duration_ms"] = probe_duration

            logger.probe_result(
                backend=config.backend,
                ok=probe_result.get("ok", False),
                duration_ms=probe_duration,
                error_type=probe_result.get("error_type"),
            )

            if probe_result.get("ok") and not winner_found.is_set():
                winner_found.set()
                cancel_event.set()
                logger.probe_win(backend=config.backend, label=config.label)

    # Launch all probe threads
    for i, config in enumerate(probes):
        if cancel_event.is_set():
            break
        t = threading.Thread(target=run_probe, args=(i, config), daemon=True)
        t.start()
        threads.append(t)

    # Wait for a winner or all threads to finish
    winner_config = None
    for t in threads:
        t.join(timeout=60)

    elapsed = int((time.time() - start_time) * 1000)

    # Check for winner
    with results_lock:
        for i, config in enumerate(probes):
            pr = probe_results.get(i, {})
            if pr.get("ok"):
                winner_config = config
                break

    if winner_config:
        send_message({
            "type": "progress",
            "stage": "probing",
            "message": f"{winner_config.label} verified — starting download",
            "winner": winner_config.backend,
        })
        return ProbeResult(
            winner=winner_config.backend,
            command=winner_config.command,
            label=winner_config.label,
            errors=[],
            duration_ms=elapsed,
        )

    # Collect all errors
    with results_lock:
        for i, config in enumerate(probes):
            pr = probe_results.get(i, {})
            if pr.get("ok"):
                continue
            errors.append(
                ProbeError(
                    backend=config.backend,
                    label=config.label,
                    error_type=pr.get("error_type", "unknown"),
                    message=pr.get("message", ""),
                    status_code=pr.get("status_code"),
                    raw_output=pr.get("raw_output"),
                    duration_ms=pr.get("duration_ms", 0),
                )
            )

    logger.probe_all_fail(url=url, backends=[p.backend for p in probes], errors=errors)

    return ProbeResult(
        winner=None,
        command=None,
        label=None,
        errors=errors,
        duration_ms=elapsed,
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


def probe_yt_dlp(
    url: str,
    cancel_event: threading.Event,
    yt_dlp_command: list[str],
    ffmpeg_location: Optional[str] = None,
) -> dict:
    """Run yt-dlp --skip-download --dump-single-json. Success if exit 0 + non-empty formats."""
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
        str(url),
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
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
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "exit_code",
            "message": f"yt-dlp exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": (completed.stderr or "").strip() or (completed.stdout or "").strip(),
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


def probe_curl_cffi(
    url: str,
    cancel_event: threading.Event,
    headers: Optional[dict] = None,
) -> dict:
    """HTTP HEAD request with TLS impersonation. Success if 2xx/3xx response."""
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    # Try curl_cffi first, fall back to urllib
    try:
        from curl_cffi import requests as curl_requests

        resp = curl_requests.head(
            url,
            headers=dict(headers or {}),
            impersonate="chrome",
            timeout=12,
            verify=True,
        )
        if resp.ok:
            return {
                "ok": True,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": None,
                "message": None,
                "status_code": resp.status_code,
                "raw_output": None,
                "duration_ms": 0,
            }
        else:
            return {
                "ok": False,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": "http_error",
                "message": f"HTTP {resp.status_code}",
                "status_code": resp.status_code,
                "raw_output": resp.text[:2000] if resp.text else "",
                "duration_ms": 0,
            }
    except ImportError:
        pass
    except Exception as exc:
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "request_error",
            "message": str(exc),
            "status_code": None,
            "raw_output": str(exc),
            "duration_ms": 0,
        }

    # Fallback to urllib
    try:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(str(url), method="HEAD", headers=dict(headers or {}))
        with urllib.request.urlopen(req, timeout=12) as resp:
            return {
                "ok": True,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": None,
                "message": None,
                "status_code": resp.status,
                "raw_output": None,
                "duration_ms": 0,
            }
    except urllib.error.HTTPError as exc:
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "http_error",
            "message": f"HTTP {exc.code} {exc.reason}",
            "status_code": exc.code,
            "raw_output": str(exc),
            "duration_ms": 0,
        }
    except Exception as exc:
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "request_error",
            "message": str(exc),
            "status_code": None,
            "raw_output": str(exc),
            "duration_ms": 0,
        }


def probe_n_m3u8dl_re(
    url: str,
    cancel_event: threading.Event,
    n_m3u8dl_re_location: str,
) -> dict:
    """Fetch the manifest URL and check if it's parseable (success if exit 0)."""
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

    command = [
        str(n_m3u8dl_re_location),
        "--test",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
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
) -> dict:
    """Run streamlink --json URL to check stream availability."""
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
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
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


# ── Helpers ────────────────────────────────────────────────────────────────


def curl_cffi_available():
    """Check whether curl_cffi is importable."""
    try:
        import curl_cffi  # noqa: F401

        return True
    except ImportError:
        return False
