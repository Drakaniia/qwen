"""N_m3u8DL-RE output parser (real-progress spec §3.1, decision D4).

Column shape read off the pinned binary's source, not off `main`'s docs. The pinned
build is `0.6.0+df70f0b` (commit `df70f0b3da0c630bd413bf617e758051f6b64757`,
`scripts/install.sh` pulls the latest GitHub release), and
`DownloadManager/SimpleDownloadManager.cs:StartDownloadAsync` builds:

    TaskDescriptionColumn      -> "Vid 1920x1080 | 5000 Kbps | 30 | SDR"
    ProgressBarColumn{Width=30}-> "━" x30, no value text
    MyPercentageColumn         -> $"{task.Value}/{task.MaxValue} {percentage:F2}%"
    DownloadStatusColumn       -> "{done}/{total}" sizes, "-" at zero, single value when finished
    DownloadSpeedColumn        -> FormatFileSize(speed) + "ps" (+"(N)" when stalled), "-" when idle
    RemainingTimeColumn        -> "hh:mm:ss" (Spectre), "--:--:--" / "**:**:**" when unknown
    SpinnerColumn              -> dropped entirely under --no-ansi-color (SkipLast(1))

`GlobalUtil.FormatFileSize` divides by 1024 and renders `####0.00` with unit B/KB/MB/GB,
and `Logger` prefixes `HH:mm:ss.fff INFO : ` / `... DEBUG: ` / `... WARN : ` / `... ERROR: `
(note INFO/WARN carry a space before the colon, DEBUG/ERROR do not).

So every regex here is anchored on the **shapes**, never on fixed column offsets: the
count/pct token is unambiguous, and each remaining token is classified by what it looks
like rather than by where it sits. That is §8's mitigation for width drift in a future
pin -- a widened column survives; a *renamed* one would not, which is unavoidable.

`task.Value`/`task.MaxValue` is a segment counter on the multi-segment path and a byte
counter on the single-file path (`DownloadSpeedColumn.Render` rewrites both from
`speedContainer.ResponseLength`). Nothing here assumes which.
"""

import re

_ANSI_RE = re.compile(r"\x1B\[[0-9;?]*[A-Za-z]")
# Timestamp is optional: the merge/mux stages go through Logger.*MarkUp and are prefixed,
# but bare subprocess output must still be classifiable.
_LOG_RE = re.compile(r"^(?:\d{2}:\d{2}:\d{2}\.\d{3}\s+)?(?:INFO|DEBUG|WARN|ERROR)\s*:\s?(.*)$")
# The count/pct column is the anchor. The bar is optional so a row rendered before its
# first segment still matches.
_ROW_RE = re.compile(
    r"^(?P<desc>.*?)\s*[━]*\s*"
    r"(?P<done>\d+(?:\.\d+)?)/(?P<total>\d+(?:\.\d+)?)\s+(?P<pct>\d+(?:\.\d+)?)%"
)

_UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3}
_SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)(B|KB|MB|GB)$")
_SIZE_PAIR_RE = re.compile(r"^(\d+(?:\.\d+)?)(B|KB|MB|GB)/(\d+(?:\.\d+)?)(B|KB|MB|GB)$")
_SPEED_RE = re.compile(r"^(\d+(?:\.\d+)?)(B|KB|MB|GB)ps(?:\(\d+\))?$")
_CLOCK_RE = re.compile(r"^(\d{1,4}):(\d{1,2}):(\d{1,2})$")

# Stage table (spec §3.1). Matched case-insensitively as a substring of the message body,
# so a widened column or a localised build still lands on the right stage.
_EXTRACT_STAGES = ("start downloading",)
_POSTPROCESS_STAGES = (
    "binary merging",
    "ffmpeg merging",
    "segments more than 1800",
    "muxing to",
    "cleaning files",
    "rename to",
)

_ROWS = "rows"


def _clean(line):
    """ANSI-stripped, newline/`\\r`-split last non-empty piece.

    `LiveRenderable.PositionCursor` writes `\\r` + CursorUp before every frame, so a `\\r`
    can survive into a line even after the reader has split on both.
    """
    text = _ANSI_RE.sub("", str(line or ""))
    pieces = [piece.strip() for piece in re.split(r"[\r\n]+", text) if piece.strip()]
    return pieces[-1] if pieces else ""


def _format_size(num_bytes):
    """Mirror `GlobalUtil.FormatFileSize`: 1024 divisors, two decimals, B/KB/MB/GB."""
    value = float(num_bytes)
    for unit, scale in (("GB", 1024**3), ("MB", 1024**2), ("KB", 1024)):
        if value >= scale:
            return f"{value / scale:.2f}{unit}"
    return f"{value:.2f}B"


def _clock(seconds):
    total = int(max(0.0, seconds))
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


def _tail(token, row):
    """Fold one post-count/pct token into `row` by shape.

    Anything unrecognised -- the Spectre spinner, or a column a future build adds -- is
    dropped on purpose rather than guessed at.
    """
    if not token or token == "-":
        return
    match = _SIZE_PAIR_RE.match(token)
    if match:
        row["doneBytes"] = float(match.group(1)) * _UNITS[match.group(2)]
        row["totalBytes"] = float(match.group(3)) * _UNITS[match.group(4)]
        return
    match = _SIZE_RE.match(token)
    if match:
        # Single value: the row finished, so the one number is both sides of the sum.
        size = float(match.group(1)) * _UNITS[match.group(2)]
        row["doneBytes"] = size
        row["totalBytes"] = size
        return
    match = _SPEED_RE.match(token)
    if match:
        row["speed"] = float(match.group(1)) * _UNITS[match.group(2)]
        return
    match = _CLOCK_RE.match(token)
    if match:
        row["etaSeconds"] = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))


def _combine(state, row):
    """D4: one percent for the whole job = Σ done / Σ total across rows.

    A plain mean over-weights a short subtitle track; summing the counters weights each
    track by how much of the job it actually is, so video dominates the way the user's
    perception does. Speed sums (they are concurrent), ETA takes the max (the job ends
    when the slowest track does).
    """
    rows = state.setdefault(_ROWS, {})
    rows[row["description"]] = row

    done = 0.0
    total = 0.0
    done_bytes = 0.0
    total_bytes = 0.0
    have_bytes = False
    speed = 0.0
    have_speed = False
    eta = 0
    for entry in rows.values():
        done += entry["done"]
        total += entry["total"]
        if "doneBytes" in entry:
            done_bytes += entry["doneBytes"]
            total_bytes += entry["totalBytes"]
            have_bytes = True
        if "speed" in entry:
            speed += entry["speed"]
            have_speed = True
        eta = max(eta, entry.get("etaSeconds", 0))

    result = {"stage": "download"}
    if total > 0:
        # The tool's own total is an extrapolation (its size column is size/(Value/MaxValue)),
        # so this number is honest only when it says so.
        result["percent"] = round(done / total * 100, 2)
        result["percentApproximate"] = True
    if have_bytes and total_bytes > 0:
        result["downloadedSize"] = _format_size(done_bytes)
        result["totalSize"] = _format_size(total_bytes)
    if have_speed and speed > 0:
        result["speed"] = f"{_format_size(speed)}ps"
    if eta > 0:
        result["eta"] = _clock(eta)
    return result


def _frame(match, text, state):
    row = {
        "description": re.sub(r"\s+", " ", match.group("desc")).strip(),
        "done": float(match.group("done")),
        "total": float(match.group("total")),
    }
    rest = text[match.end() :].split()
    for token in rest:
        _tail(token, row)

    result = _combine(state, row)
    result["line"] = text
    return result


def _stage_for(message):
    lowered = message.lower()
    if any(token in lowered for token in _EXTRACT_STAGES):
        return "extract"
    if any(token in lowered for token in _POSTPROCESS_STAGES):
        return "postprocess"
    return "log"


def parse(line, state):
    """One N_m3u8DL-RE output line -> one progress message.

    Never raises. Unrecognised input is `{"stage": "log", "line": line}`, which is also
    what every one of these cases yields on purpose:

    - `--log-level OFF` sets `progress.AutoRefresh = false` and produces ZERO frames.
      There is nothing to parse, so every line is a log line and the bar falls back to
      indeterminate rather than showing a wrong number. No caller sets this flag today.
    - The live-record manager (`SimpleLiveRecordManager2`) uses a different column set --
      description, duration `1h02m03s/4h05m06s`, `N/M Recording`, Spectre's own
      `[bars] NN%`, speed -- with no `Value/MaxValue` column and no `━` bar, so
      `_ROW_RE` cannot match it. Classifying those rows as `log` is the point: live
      record is out of scope (spec §9) and a mis-parse would invent a percent from a
      segment count that grows as the playlist refreshes.
    - `Done` / failure lines are terminal, and `run()` -- not this module -- turns them
      into a terminal message. All this does is decline to assign them a phase, because
      `log` is the honest answer for a line that is not one of the four stops.
    """
    text = _clean(line)
    if not text:
        return {"stage": "log", "line": ""}

    match = _ROW_RE.match(text)
    if match:
        return _frame(match, text, state)

    log = _LOG_RE.match(text)
    message = log.group(1) if log else text
    return {"stage": _stage_for(message), "line": text}
