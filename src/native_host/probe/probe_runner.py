"""probe_runner — Parallel reachability probes for download backends.

Launches lightweight reachability checks for all applicable backends
simultaneously, returns the highest-priority one that succeeded, and
collects errors from the rest.

See ``parallel-reachability-spec.md`` for the full specification.

Types and individual probe functions have been extracted into
:mod:`probe_types` and :mod:`probe_backends` for modularity, and are
re-exported here for backward compatibility.
"""

import threading
import time
from typing import Callable

from probe_backends import (
    probe_n_m3u8dl_re,
    probe_streamlink,
    probe_yt_dlp,
)
from probe_types import ProbeConfig, ProbeError, ProbeResult

# ── Re-exports for backward compatibility ──────────────────────────────────

__all__ = [
    "ProbeConfig",
    "ProbeError",
    "ProbeResult",
    "probe_yt_dlp",
    "probe_n_m3u8dl_re",
    "probe_streamlink",
    "run_parallel_probes",
]


# ── Orchestrator ───────────────────────────────────────────────────────────


def run_parallel_probes(
    url: str,
    probes: list[ProbeConfig],
    cancel_event: threading.Event,
    send_message: Callable,
    logger,
    download_id: str = "",
) -> ProbeResult:
    """Launch all probes in parallel, return the highest-priority success or all errors.

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
    download_id : str
        The download this probe round belongs to, so probe events join to
        it in `downloads.jsonl`.

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
    logger.probe_start(url=url, backends=[p.backend for p in probes], download_id=download_id)

    # Send initial progress message
    send_message(
        {
            "type": "progress",
            "stage": "probing",
            "message": f"Checking {len(probes)} backend{'s' if len(probes) != 1 else ''}…",
            "backendCount": len(probes),
        }
    )

    results_lock = threading.Lock()
    probe_results: dict[int, dict] = {}
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
                download_id=download_id,
            )

    # Launch all probe threads
    for i, config in enumerate(probes):
        t = threading.Thread(target=run_probe, args=(i, config), daemon=True)
        t.start()
        threads.append(t)

    # Wait for every probe to answer, with an overall timeout so a probe
    # that is truly stuck cannot hang the download.
    # Poll loop watches cancel_event and thread completion to avoid
    # blocking indefinitely.
    deadline = time.time() + 60
    while time.time() < deadline:
        if cancel_event.is_set():
            break
        # Also break early if all threads have completed (all failed)
        if all(not t.is_alive() for t in threads):
            break
        cancel_event.wait(timeout=0.5)  # Poll periodically

    # Signal cancellation for any remaining threads
    cancel_event.set()

    # Brief join so threads that can clean up do so
    for t in threads:
        t.join(timeout=5)

    elapsed = int((time.time() - start_time) * 1000)

    # Index order IS priority: download_manager._build_probe_configs emits the
    # probes already in priority order (N_m3u8DL-RE, Streamlink, yt-dlp for a
    # stream manifest), so the lowest index that reported ok wins. No local
    # priority list — that would be a second source of truth.
    with results_lock:
        winner_config = None
        for i, config in enumerate(probes):
            if probe_results.get(i, {}).get("ok"):
                winner_config = config
                break

    if winner_config:
        logger.probe_win(backend=winner_config.backend, label=winner_config.label, download_id=download_id)
        send_message(
            {
                "type": "progress",
                "stage": "probing",
                "message": f"{winner_config.label} verified — starting download",
                "winner": winner_config.backend,
            }
        )
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

    logger.probe_all_fail(url=url, backends=[p.backend for p in probes], errors=errors, download_id=download_id)

    return ProbeResult(
        winner=None,
        command=None,
        label=None,
        errors=errors,
        duration_ms=elapsed,
    )
