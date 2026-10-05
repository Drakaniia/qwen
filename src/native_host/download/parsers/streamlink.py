"""Streamlink output parser (real-progress spec §3.2, decision D5).

**Nothing passes `--json`.** The spec proposed it, D5 was built on the premise that it
"gives structured progress", and that premise is false for the pinned streamlink.
Verified in the installed `streamlink_cli/console/console.py`: `msg` (line 101) and
`msg_status` (line 108) both `return` immediately when `self.json` is set, and
`streamlink_cli/progress.py:227` writes the progress bar through exactly those two.
Nothing calls `msg_json` for progress. So on a stock install `--json` emits no progress
object at all *and* suppresses the `[cli][info]` / `[download][info]` text that
`download_task.py:353` turns into the **user-facing** error string -- it would trade real
diagnostics for nothing. `build_streamlink_command` therefore omits the flag; this module
parses the shape anyway for a build that does emit it, and costs ~40 lines to keep.

What that means today: Streamlink reports nothing while piped, so the bar falls back to
indeterminate. `--progress` defaults to yes but is suppressed when there is no terminal,
which is also why this is not something the flag could have fixed. This is the §3.2
documented guard, and the same shape as N_m3u8DL-RE's `--log-level OFF` guard: an honest
"nothing" beats a wrong number.

D5's other half is why nothing here is swallowed: a line that is not a recognised progress
object is returned as `{"stage": "log", "line": <raw text>}` untouched -- including the
interior lines of a JSON document being accumulated -- so the error tail keeps whatever
the process actually said. That is also why `msg_json`'s `indent=2` needs the `_BUF`
accumulator below: one object arrives as a *multi-line* document, and the reader hands us
one line at a time.

`percentApproximate` is emitted as `True` unless the payload says otherwise. A percent
derived from a real `Content-Length` is exact; one derived from bitrate/duration is not,
and the payload does not distinguish the two, so the pessimistic reading is the honest
one (spec D2).
"""

import json

_BUF = "json_buffer"

_PERCENT_KEYS = ("percent", "percentage")
_DONE_KEYS = ("downloaded", "downloaded_bytes", "written", "written_bytes", "bytes")
_TOTAL_KEYS = ("total", "total_bytes", "total_size")

_UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}


def _log(text):
    return {"stage": "log", "line": text}


def _depth(lines):
    """Unclosed-brace count across the buffered lines. Nested objects still balance out."""
    return sum(line.count("{") - line.count("}") for line in lines)


def _loads(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


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


def _pick(payload, keys):
    for key in keys:
        if key in payload:
            return _number(payload[key])
    return None


def _progress(payload, text):
    if not isinstance(payload, dict):
        return None

    percent = _pick(payload, _PERCENT_KEYS)
    downloaded = _pick(payload, _DONE_KEYS)
    total = _pick(payload, _TOTAL_KEYS)
    if percent is None:
        if downloaded is None or not total:
            return None
        percent = downloaded / total * 100

    result = {"stage": "download", "line": text}
    result["percent"] = round(min(100.0, max(0.0, percent)), 2)
    result["percentApproximate"] = bool(payload.get("approximate", True))

    if downloaded is not None and downloaded > 0:
        result["downloadedSize"] = _format_size(downloaded)
    if total:
        result["totalSize"] = _format_size(total)
    speed = _number(payload.get("speed"))
    if speed:
        result["speed"] = _format_size(speed)
    eta = payload.get("eta")
    if eta not in (None, ""):
        result["eta"] = str(eta)
    return result


def parse(line, state):
    """One Streamlink output line -> one progress message. Never raises."""
    raw = str(line or "")
    text = raw.strip()
    if not text:
        return _log("")

    buffer = state.get(_BUF)
    if buffer is None and text.startswith("{"):
        buffer = []
        state[_BUF] = buffer
    if buffer is not None:
        buffer.append(text)
        if _depth(buffer) > 0:
            return _log(raw)
        state.pop(_BUF, None)
        payload = _loads("\n".join(buffer))
    else:
        payload = _loads(text)

    # D5: anything unrecognised keeps its raw text so the error tail stays useful.
    return _progress(payload, raw) or _log(raw)
