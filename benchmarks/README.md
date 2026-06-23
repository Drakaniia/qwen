# Benchmarks

This directory contains performance benchmarking tools for measuring download throughput across Qwin's available backends.

## Download Speed Benchmark

[`speedtest.py`](speedtest.py) measures real-world download throughput for each supported backend using stable public test streams from Apple, Unified Streaming, and Google.

### Supported Backends

| Backend | Description | Dependencies |
|---|---|---|
| `yt-dlp+aria2c` | yt-dlp with aria2c segmented downloader — Qwin's primary fast mode | `yt-dlp`, `aria2c` |
| `yt-dlp (native)` | yt-dlp with its built-in Python downloader — baseline comparison | `yt-dlp` |
| `direct-http` | Direct HTTP download via Python `urllib` — simplest baseline | None (built-in) |
| `N_m3u8DL-RE` | Specialized HLS/DASH stream downloader (32 threads) | `N_m3u8DL-RE` |
| `streamlink` | HLS live/stream downloader (4 segment threads) | `streamlink` |

### Test URLs

The benchmark uses these publicly-hosted test streams:

| Key | Source | Format | Est. Size |
|---|---|---|---|
| `hls-small` | Apple HLS (BipBop ~18s) | HLS | ~5 MB |
| `dash-small` | Unified DASH (Tears of Steel ~12 min) | DASH | ~1.5 GB |
| `mp4-small` | Google direct MP4 (~15s) | MP4 | ~3 MB |
| `mp4-medium` | Google direct MP4 (~10 min) | MP4 | ~250 MB |

### Usage

```bat
python benchmarks/speedtest.py
```

Run all available backends against the default test set.

#### Quick test

```bat
python benchmarks/speedtest.py --quick
```

Uses only the smallest test files (~3 MB MP4 and ~5 MB HLS) for a fast throughput estimate.

#### Specific backend

```bat
python benchmarks/speedtest.py --backends yt-dlp+aria2c
python benchmarks/speedtest.py --backends yt-dlp             # runs both +aria2c and native
python benchmarks/speedtest.py --backends direct-http streamlink
```
Using the alias `yt-dlp` runs both the aria2c-backed and native downloader variants side by side for direct comparison.

#### Full test suite

```bat
python benchmarks/speedtest.py --all-sizes
```

Runs all available test URLs, including the large ~1.5 GB DASH stream.

#### JSON output

```bat
python benchmarks/speedtest.py --json
```

Outputs structured JSON to stdout (progress goes to stderr). Useful for programmatic consumption or CI pipelines.

#### Keep downloaded files

```bat
python benchmarks/speedtest.py --no-cleanup
```

Downloaded files are left in a temporary directory whose path is printed after each test.

#### Custom timeout

```bat
python benchmarks/speedtest.py --timeout 300
```

Sets a per-test timeout in seconds (default: 120). Increase for large files or slow connections.

#### List available URLs or backends

```bat
python benchmarks/speedtest.py --list-urls
python benchmarks/speedtest.py --list-backends
```

### Report Format

When run without `--json`, the benchmark prints:

```
╔══════════════════════════════════════════════════════════════════════╗
║              Qwin Download Speed Benchmark                         ║
╚══════════════════════════════════════════════════════════════════════╝

  System:    win32
  CPU:       8
  Time:      2026-06-23 12:00:00

  Backends:
    [x] yt-dlp
    [x] aria2c
    [ ] N_m3u8DL-RE
    [ ] streamlink
    [x] ffmpeg

  Results (3 succeeded, 2 failed):
  ───────────────────────────────────────────────────────────────────────────────
              Backend                               Test          Speed      Time        Size
  ───────────────────────────────────────────────────────────────────────────────
  V          yt-dlp+aria2c    Google Direct MP4 (~15s)    48.2 Mbps     0.5s     3.0 MB
  V         yt-dlp (native)   Google Direct MP4 (~15s)    12.1 Mbps     2.0s     3.0 MB
  V             direct-http   Google Direct MP4 (~15s)     8.5 Mbps     2.8s     3.0 MB
  ───────────────────────────────────────────────────────────────────────────────

  Fastest:  48.2 Mbps  (6.0 MB/s)
  Average:  22.9 Mbps  (2.9 MB/s)

  Total benchmark time: 5.3s
```

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | All selected backends completed successfully |
| `1` | Some backends failed or were unavailable |
| `2` | No backends could run |

This makes the benchmark suitable for use in CI pipelines — a non-zero exit indicates a regression in backend availability or performance.
