#!/usr/bin/env python3
"""Qwin Download Speed Benchmark

Measures real-world download throughput for each available backend
(yt-dlp+aria2c, yt-dlp+native, N_m3u8DL-RE, streamlink, direct HTTP)
using stable public test streams from Apple, Unified Streaming, and Google.

Usage:
    python benchmarks/speedtest.py                          # Run all backends
    python benchmarks/speedtest.py --backends yt-dlp        # Run specific backend
    python benchmarks/speedtest.py --quick                  # Smallest test only
    python benchmarks/speedtest.py --all-sizes              # Test 3 file sizes
    python benchmarks/speedtest.py --no-cleanup             # Keep downloaded files
    python benchmarks/speedtest.py --json                   # Output JSON only
    python benchmarks/speedtest.py --timeout 60             # Per-test timeout (s)

Each benchmark downloads a real media file/segment and reports:
- Download time (s)
- Average speed (MB/s and Mbps)
- File size (MB)
- Connection count (where applicable)
- Error status

Exit codes:
    0 — All selected backends completed successfully
    1 — Some backends failed or were unavailable
    2 — No backends could run
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from threading import Event
from typing import Optional

# ─── Public Test URLs ──────────────────────────────────────────────────────
# These are stable, publicly-hosted test streams maintained by their
# respective organizations. They are safe to use for benchmarking.
#
# Apple HLS: https://developer.apple.com/streaming/examples/
# Unified Streaming DASH: https://docs.unified-streaming.com/
# Google test clips: https://commondatastorage.googleapis.com/gtv-videos-bucket/

TEST_URLS = {
    "hls-small": {
        "url": "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8",
        "label": "Apple HLS (BipBop ~18s)",
        "format_type": "hls",
        "estimated_size_mb": 5,
    },
    "dash-small": {
        "url": "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.mpd",
        "label": "Unified DASH (ToS ~12 min)",
        "format_type": "dash",
        "estimated_size_mb": 1500,
    },
    "mp4-small": {
        "url": "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        "label": "Google Direct MP4 (~15s)",
        "format_type": "mp4",
        "estimated_size_mb": 3,
    },
    "mp4-medium": {
        "url": "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
        "label": "Google Direct MP4 (~10 min)",
        "format_type": "mp4",
        "estimated_size_mb": 250,
    },
}


# ─── Test Results ──────────────────────────────────────────────────────────


@dataclass
class BackendResult:
    """Result of a single backend benchmark run."""

    backend: str
    test_label: str
    url: str
    success: bool
    duration_seconds: float = 0.0
    speed_mbps: float = 0.0
    speed_mbs: float = 0.0
    file_size_mb: float = 0.0
    error_message: str = ""
    connection_count: Optional[int] = None
    peak_speed_mbps: Optional[float] = None

    def __post_init__(self):
        if self.speed_mbs > 0 and self.speed_mbps == 0.0:
            self.speed_mbps = self.speed_mbs * 8.0

    def summary_line(self) -> str:
        """Return a single-line summary for terminal output."""
        if not self.success:
            return f"  X {self.backend:>22s}  {self.test_label:35s}  FAILED  ({self.error_message})"
        size_str = f"{self.file_size_mb:.1f} MB" if self.file_size_mb > 0 else "? MB"
        speed_str = f"{self.speed_mbps:.1f} Mbps" if self.speed_mbps > 0 else "? Mbps"
        time_str = f"{self.duration_seconds:.1f}s"
        peak_str = (
            f"  peak: {self.peak_speed_mbps:.1f} Mbps" if self.peak_speed_mbps else ""
        )
        return (
            f"  V {self.backend:>22s}  {self.test_label:35s}"
            f"  {speed_str:>12s}  {time_str:>8s}  {size_str:>10s}{peak_str}"
        )


@dataclass
class BenchmarkSummary:
    """Overall benchmark results."""

    results: list = field(default_factory=list)
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    system_info: dict = field(default_factory=dict)

    def add(self, result: BackendResult):
        self.results.append(result)

    def duration(self) -> float:
        return (self.end_time or time.time()) - self.start_time

    def to_json(self) -> str:
        """Serialize results to JSON."""
        data = {
            "benchmark_duration_seconds": self.duration(),
            "system": self.system_info,
            "results": [asdict(r) for r in self.results],
        }
        return json.dumps(data, indent=2)

    def print_report(self):
        """Print formatted report to terminal."""
        successes = [r for r in self.results if r.success]
        failures = [r for r in self.results if not r.success]

        print()
        print("╔══════════════════════════════════════════════════════════════════════╗")
        print("║              Qwin Download Speed Benchmark                         ║")
        print("╚══════════════════════════════════════════════════════════════════════╝")
        print()

        if self.system_info:
            print(f"  System:    {self.system_info.get('platform', '?')}")
            print(f"  CPU:       {self.system_info.get('cpu', '?')}")
            print(f"  Time:      {time.strftime('%Y-%m-%d %H:%M:%S')}")
            print()

        # Backend detection summary
        print(f"  Backends:")
        for name, found in self.system_info.get("backends", {}).items():
            status = "[x]" if found else "[ ]"
            print(f"    {status} {name}")
        print()

        # Results table
        print(f"  Results ({len(successes)} succeeded, {len(failures)} failed):")
        print(f"  {'─' * 95}")
        print(
            f"  {'Backend':>22s}  {'Test':35s}  {'Speed':>12s}  {'Time':>8s}  {'Size':>10s}"
        )
        print(f"  {'─' * 95}")
        for r in self.results:
            print(r.summary_line())
        print(f"  {'─' * 95}")
        print()

        # Summary stats
        if successes:
            speeds = [r.speed_mbps for r in successes if r.speed_mbps > 0]
            if speeds:
                print(
                    f"  Fastest:  {max(speeds):.1f} Mbps  "
                    f"({max(speeds) / 8:.1f} MB/s)"
                )
                print(
                    f"  Average:  {sum(speeds) / len(speeds):.1f} Mbps  "
                    f"({sum(speeds) / len(speeds) / 8:.1f} MB/s)"
                )
                print()

        if failures:
            print(f"  Failed backends:")
            for r in failures:
                print(f"    {r.backend:>22s}: {r.error_message}")
            print()

        total_duration = self.duration()
        print(f"  Total benchmark time: {total_duration:.1f}s")
        print()


# ─── Backend Detection ─────────────────────────────────────────────────────


def detect_backends() -> dict:
    """Detect which download backends are available on this system.

    Returns a dict mapping backend name → bool (available or not).
    """
    backends = {}

    # yt-dlp
    backends["yt-dlp"] = bool(shutil.which("yt-dlp"))

    # aria2c
    backends["aria2c"] = bool(shutil.which("aria2c"))

    # N_m3u8DL-RE
    backends["N_m3u8DL-RE"] = bool(
        shutil.which("N_m3u8DL-RE") or shutil.which("N_m3u8DL-RE.exe")
    )

    # streamlink
    backends["streamlink"] = bool(shutil.which("streamlink"))

    # ffmpeg (needed for some backends)
    backends["ffmpeg"] = bool(shutil.which("ffmpeg"))

    return backends


def collect_system_info() -> dict:
    """Collect system information for benchmark context."""
    info = {
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "cpu": os.cpu_count(),
        "timestamp": time.time(),
        "backends": detect_backends(),
    }
    return info


# ─── Benchmark Runners ─────────────────────────────────────────────────────


def run_yt_dlp_aria2c_test(
    url: str,
    test_label: str,
    work_dir: Path,
    timeout: int = 120,
    max_connections: int = 24,
    concurrent_fragments: int = 48,
) -> BackendResult:
    """Benchmark yt-dlp + aria2c (highly parallel segmented download).

    Uses the exact same flags Qwin uses for real downloads.
    """
    backend = "yt-dlp+aria2c"
    result = BackendResult(
        backend=backend,
        test_label=test_label,
        url=url,
        success=False,
    )

    try:
        yt_dlp = shutil.which("yt-dlp")
        if not yt_dlp:
            result.error_message = "yt-dlp not found"
            return result

        aria2c = shutil.which("aria2c")
        if not aria2c:
            result.error_message = "aria2c not found"
            return result

        # Build command matching Qwin's production flags
        aria2_args = (
            f"--max-connection-per-server={max_connections} "
            f"--split={max_connections} "
            f"--min-split-size=1M --continue=true "
            f"--file-allocation=none --max-tries=3 "
            f"--retry-wait=1 --summary-interval=1 "
            f"--async-dns=true --dns-timeout=3"
        )

        cmd = [
            yt_dlp,
            "--ignore-config",
            "--newline",
            "--no-color",
            "--progress",
            "--no-playlist",
            "--extractor-retries",
            "3",
            "--concurrent-fragments",
            str(concurrent_fragments),
            "--no-keep-fragments",
            "-f",
            "best[ext=mp4]/best",
            "--downloader",
            aria2c,
            "--downloader",
            "dash,m3u8:native",
            "--downloader-args",
            f"aria2c:{aria2_args}",
            "-o",
            "qwin-bench-%(id)s.%(ext)s",
            "--paths",
            f"home:{work_dir}",
            url,
        ]

        start = time.monotonic()
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        elapsed = time.monotonic() - start

        # Extract speed from yt-dlp output
        output = proc.stdout or ""
        speeds = _extract_speeds_from_yt_dlp_output(output)
        file_size = _extract_file_size_from_output(output)
        peak = max(speeds) if speeds else 0.0
        avg_speed = sum(speeds) / len(speeds) if speeds else 0.0
        # Convert KiB/s to Mbps (megabits per second, where 1 Mbps = 1,000,000 bps)
        # KiB/s * 1024 = bytes/s, * 8 = bits/s, / 1_000_000 = Mbps
        avg_mbps = avg_speed * 8192.0 / 1_000_000.0
        peak_mbps = peak * 8192.0 / 1_000_000.0

        if proc.returncode == 0:
            result.success = True
            result.duration_seconds = elapsed
            result.speed_mbps = avg_mbps
            result.peak_speed_mbps = peak_mbps
            result.file_size_mb = file_size
            result.connection_count = max_connections
        else:
            result.error_message = (
                f"yt-dlp exited code {proc.returncode}: "
                + _truncate_error(output)
            )
    except subprocess.TimeoutExpired:
        result.error_message = f"Timed out after {timeout}s"
    except FileNotFoundError as e:
        result.error_message = str(e)
    except Exception as e:
        result.error_message = str(e)

    return result


def run_yt_dlp_native_test(
    url: str,
    test_label: str,
    work_dir: Path,
    timeout: int = 120,
) -> BackendResult:
    """Benchmark yt-dlp without aria2c (native Python downloader baseline).

    This provides a baseline comparison to measure aria2c's improvement.
    """
    backend = "yt-dlp (native)"
    result = BackendResult(
        backend=backend,
        test_label=test_label,
        url=url,
        success=False,
    )

    try:
        yt_dlp = shutil.which("yt-dlp")
        if not yt_dlp:
            result.error_message = "yt-dlp not found"
            return result

        cmd = [
            yt_dlp,
            "--ignore-config",
            "--newline",
            "--no-color",
            "--progress",
            "--no-playlist",
            "--extractor-retries",
            "3",
            "--concurrent-fragments",
            "1",  # Native downloader, single fragment for baseline
            "--no-keep-fragments",
            "-f",
            "best[ext=mp4]/best",
            "-o",
            "qwin-bench-native-%(id)s.%(ext)s",
            "--paths",
            f"home:{work_dir}",
            url,
        ]

        start = time.monotonic()
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        elapsed = time.monotonic() - start

        output = proc.stdout or ""
        speeds = _extract_speeds_from_yt_dlp_output(output)
        file_size = _extract_file_size_from_output(output)
        avg_speed = sum(speeds) / len(speeds) if speeds else 0.0
        # Convert KiB/s to Mbps (megabits per second)
        avg_mbps = avg_speed * 8192.0 / 1_000_000.0
        peak_speeds = max(speeds) * 8192.0 / 1_000_000.0 if speeds else 0.0

        if proc.returncode == 0:
            result.success = True
            result.duration_seconds = elapsed
            result.speed_mbps = avg_mbps
            result.peak_speed_mbps = peak_speeds
            result.file_size_mb = file_size
        else:
            result.error_message = (
                f"yt-dlp exited code {proc.returncode}: "
                + _truncate_error(output)
            )
    except subprocess.TimeoutExpired:
        result.error_message = f"Timed out after {timeout}s"
    except FileNotFoundError as e:
        result.error_message = str(e)
    except Exception as e:
        result.error_message = str(e)

    return result


def run_n_m3u8dl_re_test(
    url: str,
    test_label: str,
    work_dir: Path,
    timeout: int = 120,
    thread_count: int = 32,
) -> BackendResult:
    """Benchmark N_m3u8DL-RE (specialized HLS/DASH downloader).

    Uses 32 threads matching Qwin's optimized configuration.
    """
    backend = "N_m3u8DL-RE"
    result = BackendResult(
        backend=backend,
        test_label=test_label,
        url=url,
        success=False,
    )

    try:
        tool = shutil.which("N_m3u8DL-RE") or shutil.which("N_m3u8DL-RE.exe")
        if not tool:
            result.error_message = "N_m3u8DL-RE not found"
            return result

        save_name = "qwin-bench-nm3u8"
        cmd = [
            tool,
            "--auto-select",
            "--thread-count",
            str(thread_count),
            "--download-retry-count",
            "3",
            "--save-dir",
            str(work_dir),
            "--save-name",
            save_name,
            "-M",
            "format=mp4",
            url,
        ]

        start = time.monotonic()
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        elapsed = time.monotonic() - start

        output = proc.stdout or ""
        result.connection_count = thread_count

        # Find the output file to measure size
        found_file = _find_benchmark_file(work_dir, save_name)
        file_size = 0.0
        if found_file:
            file_size = found_file.stat().st_size / (1024 * 1024)

        if proc.returncode == 0:
            result.success = True
            result.duration_seconds = elapsed
            result.file_size_mb = file_size
            if elapsed > 0 and file_size > 0:
                result.speed_mbps = (file_size * 8.0) / elapsed
        else:
            result.error_message = (
                f"N_m3u8DL-RE exited code {proc.returncode}: "
                + _truncate_error(output)
            )
    except subprocess.TimeoutExpired:
        result.error_message = f"Timed out after {timeout}s"
    except FileNotFoundError as e:
        result.error_message = str(e)
    except Exception as e:
        result.error_message = str(e)

    return result


def run_streamlink_test(
    url: str,
    test_label: str,
    work_dir: Path,
    timeout: int = 120,
    segment_threads: int = 4,
) -> BackendResult:
    """Benchmark streamlink (HLS live/stream downloader).

    Uses 4 segment threads and 128M ring buffer matching Qwin's config.
    Streamlink outputs to stdout which we pipe to a file.
    """
    backend = "streamlink"
    result = BackendResult(
        backend=backend,
        test_label=test_label,
        url=url,
        success=False,
    )

    try:
        tool = shutil.which("streamlink")
        if not tool:
            result.error_message = "streamlink not found"
            return result

        output_path = work_dir / "qwin-bench-streamlink.ts"

        cmd = [
            tool,
            "--retry-streams",
            "1",
            "--retry-max",
            "2",
            "--hls-segment-attempts",
            "3",
            "--hls-segment-timeout",
            "10",
            "--stream-segment-threads",
            str(segment_threads),
            "--ringbuffer-size",
            "128M",
            "--force",
            "-o",
            str(output_path),
            url,
            "best",
        ]

        start = time.monotonic()
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        elapsed = time.monotonic() - start

        result.connection_count = segment_threads

        file_size = 0.0
        if output_path.exists():
            file_size = output_path.stat().st_size / (1024 * 1024)

        if proc.returncode == 0 or output_path.exists():
            result.success = True
            result.duration_seconds = elapsed
            result.file_size_mb = file_size
            if elapsed > 0 and file_size > 0:
                result.speed_mbps = (file_size * 8.0) / elapsed
        else:
            result.error_message = (
                f"streamlink exited code {proc.returncode}: "
                + _truncate_error(proc.stdout or "")
            )
    except subprocess.TimeoutExpired:
        result.error_message = f"Timed out after {timeout}s"
    except FileNotFoundError as e:
        result.error_message = str(e)
    except Exception as e:
        result.error_message = str(e)

    return result


def run_direct_http_test(
    url: str,
    test_label: str,
    work_dir: Path,
    timeout: int = 120,
    chunk_size: int = 1048576,
) -> BackendResult:
    """Benchmark direct HTTP download (Python urllib baseline).

    Uses 1MB chunk size matching Qwin's optimized configuration.
    This is the simplest backend — no parallelism at all.
    """
    backend = "direct-http"
    result = BackendResult(
        backend=backend,
        test_label=test_label,
        url=url,
        success=False,
    )

    try:
        output_path = work_dir / "qwin-bench-direct.mp4"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            },
        )

        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=timeout) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            with open(str(output_path), "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
        elapsed = time.monotonic() - start

        file_size = total / (1024 * 1024)
        avg_mbps = (file_size * 8.0) / elapsed if elapsed > 0 and file_size > 0 else 0.0

        result.success = True
        result.duration_seconds = elapsed
        result.speed_mbps = avg_mbps
        result.file_size_mb = file_size
        result.connection_count = 1

    except urllib.error.HTTPError as e:
        result.error_message = f"HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        result.error_message = f"URL error: {e.reason}"
    except subprocess.TimeoutExpired:
        result.error_message = f"Timed out after {timeout}s"
    except Exception as e:
        result.error_message = str(e)

    return result# ─── Output Parsing Helpers ────────────────────────────────────────────────

import re

# Regex to extract speed samples from yt-dlp output lines.
# Matches: "at 10.5MiB/s", "at 1024KiB/s", "at 2.3MB/s"
_SPEED_RE = re.compile(r"at\s+([\d.]+)\s*(KiB|MiB|GiB|kB|MB|GB)/s")

# Regex to extract total file size from yt-dlp output.
# Matches: "of ~ 1024.0KiB", "of 10.5MiB", "of 1.2GiB"
_SIZE_RE = re.compile(r"of\s+~?\s*([\d.]+)\s*(KiB|MiB|GiB|kB|MB|GB)")


def _extract_speeds_from_yt_dlp_output(output: str) -> list:
    """Extract download speed samples (in KiB/s) from yt-dlp output lines."""
    speeds = []
    for line in output.splitlines():
        m = _SPEED_RE.search(line)
        if m:
            value = float(m.group(1))
            unit = m.group(2)
            if unit in ("MiB", "MB"):
                value *= 1024.0  # Convert to KiB/s
            elif unit in ("GiB", "GB"):
                value *= 1024.0 * 1024.0
            speeds.append(value)
    return speeds


def _extract_file_size_from_output(output: str) -> float:
    """Extract total file size (in MB) from yt-dlp output."""
    for line in output.splitlines():
        m = _SIZE_RE.search(line)
        if m:
            value = float(m.group(1))
            unit = m.group(2)
            if unit in ("KiB", "kB", "KB"):
                return value / 1024.0
            elif unit in ("MiB", "MB"):
                return value
            elif unit in ("GiB", "GB"):
                return value * 1024.0
    return 0.0


def _truncate_error(output: str, max_lines: int = 5) -> str:
    """Truncate error output to a reasonable size."""
    lines = output.strip().splitlines()
    # Only show last few meaningful lines
    meaningful = [l for l in lines if l.strip() and "[" in l]
    if not meaningful:
        meaningful = lines[-3:] if len(lines) >= 3 else lines
    return " | ".join(meaningful[-max_lines:])


def _find_benchmark_file(work_dir: Path, name_prefix: str) -> Optional[Path]:
    """Find a benchmark output file by prefix."""
    for f in work_dir.iterdir():
        if f.name.startswith(name_prefix) and f.is_file():
            return f
    return None


# ─── Cleanup ───────────────────────────────────────────────────────────────


def cleanup_work_dir(work_dir: Path):
    """Remove all benchmark files from the work directory."""
    if work_dir.exists():
        shutil.rmtree(work_dir)


# ─── Benchmark Orchestrator ────────────────────────────────────────────────


def run_benchmark(
    backends: list = None,
    test_urls: list = None,
    timeout: int = 120,
    cleanup: bool = True,
    quick: bool = False,
    json_output: bool = False,
) -> BenchmarkSummary:
    """Run the full benchmark suite.

    Args:
        backends: List of backend names to test. None = all available.
        test_urls: List of test URL keys to use. None = all.
        timeout: Maximum seconds per individual test.
        cleanup: Whether to delete downloaded files after benchmark.
        quick: If True, only use the smallest test (mp4-small ~3MB).

    Returns:
        BenchmarkSummary with all results.
    """
    summary = BenchmarkSummary()
    summary.system_info = collect_system_info()

    available = detect_backends()

    if quick:
        # Include HLS too so N_m3u8DL-RE and streamlink get exercised
        test_keys = ["mp4-small", "hls-small"]
    elif test_urls:
        test_keys = test_urls
    else:
        test_keys = ["mp4-small", "hls-small", "dash-small"]

    # Determine which backend runners to use
    backend_runners = [
        ("yt-dlp+aria2c", run_yt_dlp_aria2c_test),
        ("yt-dlp (native)", run_yt_dlp_native_test),
        ("direct-http", run_direct_http_test),
        ("N_m3u8DL-RE", run_n_m3u8dl_re_test),
        ("streamlink", run_streamlink_test),
    ]

    if backends:
        backend_runners = [b for b in backend_runners if b[0] in backends]

    # Filter to available backends only
    runner_deps = {
        "yt-dlp+aria2c": ["yt-dlp", "aria2c"],
        "yt-dlp (native)": ["yt-dlp"],
        "direct-http": [],  # always available (uses built-in urllib)
        "N_m3u8DL-RE": ["N_m3u8DL-RE"],
        "streamlink": ["streamlink"],
    }

    for name, runner_fn in backend_runners:
        deps = runner_deps.get(name, [])
        missing = [d for d in deps if not available.get(d)]
        if missing:
            result = BackendResult(
                backend=name,
                test_label="",
                url="",
                success=False,
                error_message=f"Missing dependencies: {', '.join(missing)}",
            )
            summary.add(result)
            continue

        for key in test_keys:
            if key not in TEST_URLS:
                continue
            test_info = TEST_URLS[key]

            # Skip N_m3u8DL-RE for non-stream URLs
            if name == "N_m3u8DL-RE" and test_info["format_type"] not in ("hls", "dash"):
                continue
            # Skip streamlink for non-HLS URLs (streamlink works best with HLS)
            if name == "streamlink" and test_info["format_type"] not in ("hls",):
                continue
            # Skip direct-http for stream URLs (HLS/DASH manifests can't be downloaded as-is)
            if name == "direct-http" and test_info["format_type"] in ("hls", "dash"):
                continue

            work_dir = Path(tempfile.mkdtemp(prefix="qwin-bench-"))

            msg = f"  Running {name:>22s}  {test_info['label']:35s}  ..."
            if json_output:
                print(msg, file=sys.stderr, flush=True)
            else:
                print(msg, end=" ", flush=True)

            if name == "yt-dlp+aria2c":
                result = runner_fn(
                    test_info["url"],
                    test_info["label"],
                    work_dir,
                    timeout=timeout,
                )
            elif name == "yt-dlp (native)":
                result = runner_fn(
                    test_info["url"],
                    test_info["label"],
                    work_dir,
                    timeout=timeout,
                )
            elif name == "direct-http":
                result = runner_fn(
                    test_info["url"],
                    test_info["label"],
                    work_dir,
                    timeout=timeout,
                )
            elif name == "N_m3u8DL-RE":
                result = runner_fn(
                    test_info["url"],
                    test_info["label"],
                    work_dir,
                    timeout=timeout,
                )
            elif name == "streamlink":
                result = runner_fn(
                    test_info["url"],
                    test_info["label"],
                    work_dir,
                    timeout=timeout,
                )
            else:
                result = BackendResult(
                    backend=name,
                    test_label=test_info["label"],
                    url=test_info["url"],
                    success=False,
                    error_message=f"Unknown backend: {name}",
                )

            if cleanup:
                cleanup_work_dir(work_dir)
            else:
                print(f"\n    Files kept at: {work_dir}")

            summary.add(result)
            status = "[x]" if result.success else "[ ]"
            speed_str = (
                f"{result.speed_mbps:.1f} Mbps" if result.speed_mbps > 0 else "FAILED"
            )
            if json_output:
                print(f" {status} {speed_str}", file=sys.stderr)
            else:
                print(f" {status} {speed_str}")

    summary.end_time = time.time()
    return summary


# ─── CLI Entry Point ───────────────────────────────────────────────────────


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Qwin Download Speed Benchmark — measures real throughput "
        "for each backend using public test streams.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s                          # Run all backends\n"
            "  %(prog)s --quick                   # Quick test with smallest file\n"
            "  %(prog)s --backends yt-dlp+aria2c  # Test only one backend\n"
            "  %(prog)s --backends yt-dlp --all-sizes  # All sizes, one backend\n"
            "  %(prog)s --json                    # Output as JSON\n"
        ),
    )
    parser.add_argument(
        "--backends",
        nargs="+",
        metavar="NAME",
        choices=["yt-dlp+aria2c", "yt-dlp", "N_m3u8DL-RE", "streamlink", "direct-http"],
        help="Specific backends to test (default: all available)",
    )
    parser.add_argument(
        "--urls",
        nargs="+",
        metavar="KEY",
        choices=list(TEST_URLS.keys()),
        help=f"Test URL keys: {', '.join(TEST_URLS.keys())} (default: small tests)",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Run only the smallest test (~3MB MP4) for a fast benchmark",
    )
    parser.add_argument(
        "--all-sizes",
        action="store_true",
        help="Run all available test sizes (including large ~300MB streams)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=120,
        help="Timeout in seconds per individual test (default: 120)",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Keep downloaded benchmark files",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON only (no terminal formatting)",
    )
    parser.add_argument(
        "--list-urls",
        action="store_true",
        help="List available test URLs and exit",
    )
    parser.add_argument(
        "--list-backends",
        action="store_true",
        help="Detect and list available backends, then exit",
    )

    args = parser.parse_args()

    if args.list_urls:
        print("Available test URLs:")
        for key, info in TEST_URLS.items():
            print(f"  {key:20s}  {info['label']:35s}  {info['url']}")
        sys.exit(0)

    if args.list_backends:
        backends = detect_backends()
        print("Detected backends:")
        for name, found in backends.items():
            status = "[x] installed" if found else "[ ] not found"
            print(f"  {name:20s}  {status}")
        sys.exit(0)

    # Normalize --backends: 'yt-dlp' -> both 'yt-dlp+aria2c' and 'yt-dlp (native)'
    # to provide a direct comparison of parallel vs. native downloaders.
    normalized_backends = None
    if args.backends:
        normalized_backends = []
        for b in args.backends:
            if b == "yt-dlp":
                normalized_backends.append("yt-dlp+aria2c")
                normalized_backends.append("yt-dlp (native)")
            else:
                normalized_backends.append(b)

    # Determine test URLs
    if args.all_sizes:
        test_urls = list(TEST_URLS.keys())
    elif args.urls:
        test_urls = args.urls
    else:
        test_urls = None  # Use defaults in run_benchmark

    use_json = args.json
    summary = run_benchmark(
        backends=normalized_backends,
        test_urls=test_urls,
        timeout=args.timeout,
        cleanup=not args.no_cleanup,
        quick=args.quick or args.urls is None,
        json_output=use_json,
    )

    if use_json:
        # In JSON mode, progress goes to stderr; only JSON goes to stdout
        print(summary.to_json())
    else:
        summary.print_report()

    # Exit code: 0 = all succeeded, 1 = partial failure, 2 = all failed
    successes = [r for r in summary.results if r.success]
    failures = [r for r in summary.results if not r.success]
    if not successes and failures:
        sys.exit(2)
    elif failures:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
