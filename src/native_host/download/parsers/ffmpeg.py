"""ffmpeg output parser (real-progress spec §3.3, decision D12).

`build_ffmpeg_direct_command` now passes `-progress pipe:2`. ffmpeg then writes repeating
`key=value` blocks to stderr, which `Popen` already merges into stdout
(`download_task.py:125`, `stderr=subprocess.STDOUT`) -- no restructure.

Those blocks arrive interleaved with ordinary ffmpeg stderr, so a stateless line match is
not enough: a block is only complete at `progress=continue|end`. `_BLOCK` in `state` is the
accumulating flag the spec calls for.

Duration is **not** in `-progress` output. The caller seeds `state["duration"]` (float
seconds) from the manifest/format metadata it already resolved. When it is absent there is
no percent and no guess -- `total_size` is a real byte count, so the byte readout still
works, and an invented total would be a lie the bar cannot take back.
"""

import re

_BLOCK = "progress_block"

# Whitelisted, not generic `key=value`: a normal stderr line can contain an `=`, and
# mistaking one for progress data is worse than dropping a key.
_PAIR_RE = re.compile(r"^(?P<key>[a-z_0-9]+)\s*=\s*(?P<value>.*)$")
_KEYS = frozenset({"total_size", "out_time_us", "out_time_ms", "out_time", "speed", "progress"})
_CLOCK_RE = re.compile(r"^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$")

_UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _format_size(num_bytes):
    """1024 divisors, two decimals, B/KB/MB/GB -- the shape `bytesFrom` in ui/format.ts reads."""
    value = float(num_bytes)
    for unit, scale in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if value >= scale:
            return f"{value / scale:.2f}{unit}"
    return f"{value:.2f}B"


def _clock(seconds):
    total = int(max(0.0, seconds))
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


def _elapsed(block):
    """Seconds of output written so far.

    `out_time_us` and `out_time_ms` are both printed in *microseconds* despite the `_ms`
    name -- an ffmpeg quirk, and the only reason the two 6-digit values in the spec's
    sample block are equal. `out_time=HH:MM:SS.ffffff` is the unambiguous fallback.
    """
    for key in ("out_time_us", "out_time_ms"):
        value = _number(block.get(key))
        if value is not None:
            return value / 1_000_000
    clock = _CLOCK_RE.match(str(block.get("out_time", "")).strip())
    if clock:
        return int(clock.group(1)) * 3600 + int(clock.group(2)) * 60 + float(clock.group(3))
    return None


def parse(line, state):
    """One ffmpeg output line -> one progress message. Never raises."""
    text = str(line or "").rstrip()
    match = _PAIR_RE.match(text)
    if not match or match.group("key") not in _KEYS:
        return {"stage": "log", "line": text}

    key = match.group("key")
    value = match.group("value").strip()
    block = state.setdefault(_BLOCK, {})
    if key != "progress":
        block[key] = value
        # Accumulation lines are structure, not text: an empty `line` is dropped by the
        # error-tail builder in download_task.py, so the user-facing failure text is ffmpeg's
        # own error and not five `out_time_us=...` lines per frame.
        return {"stage": "log", "line": ""}

    state.pop(_BLOCK, None)
    if not block:
        return {"stage": "log", "line": text}
    return _report(state, block, text)


def _report(state, block, text):
    duration = _number(state.get("duration"))
    elapsed = _elapsed(block)

    result = {"stage": "download", "line": text}
    # Duration is metadata, not output: when it is absent there is no percent, and no total
    # is invented to manufacture one.
    result["percentApproximate"] = False
    if duration and duration > 0 and elapsed is not None:
        result["percent"] = round(min(100.0, max(0.0, elapsed / duration * 100.0)), 2)

    # `total_size` is bytes written *so far*, not a grand total. It is the downloaded count,
    # so it lands in `downloadedSize` and `totalSize` is left alone -- setting both would
    # render "1.2 MB of 1.2 MB" on a bar sitting at 40%.
    total = _number(block.get("total_size"))
    if total:
        result["downloadedSize"] = _format_size(total)

    # ffmpeg's own `speed=1.20x` is a ratio, and `formatSpeed` in ui/format.ts only renders
    # a byte rate -- so forwarding it produced a field that silently displayed as nothing.
    # Measured bytes/elapsed is the same quantity in the shape the UI can actually read.
    if total and elapsed and elapsed > 0:
        # Measured average so far. ffmpeg's own `speed=1.20x` is a ratio against real time,
        # and `formatSpeed` in ui/format.ts only parses a byte rate -- forwarding it produced a
        # field that silently displayed as nothing.
        result["speed"] = f"{total / elapsed:.0f}B/s"
        if duration and duration > 0 and elapsed < duration:
            # Left as the remaining duration rather than a rate-derived figure: the only rate
            # available is the average *so far*, and remaining_bytes / average_rate reduces
            # algebraically back to this. A tautology dressed as an estimate is worse than
            # the plain number.
            result["eta"] = _clock(duration - elapsed)
    return result
