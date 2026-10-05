"""Backend dispatch for one line of subprocess output (spec §3, D11).

One parser module per backend, each exposing the same contract:

    parse(line, state) -> dict

`line` is already newline-stripped, `state` is a caller-owned dict that the
parser may mutate (fragment counters, latched totals). The result always has
`stage` and `line`; `percent` and friends are optional. A parser must never
raise -- the dispatcher degrades a blow-up to `{"stage": "log", ...}`.
"""

import aria2
import ffmpeg
import n_m3u8dl_re
import streamlink
import ytdlp

from progress_parser import latest_output_line

# backend key -> parser callable. A plain dict literal is the whole extension point.
#
# Order is the auto-detection order, so the specific/anchored parsers come
# before the permissive ones. `ytdlp` is last of the download parsers because it
# is the permissive one -- it classifies any `[...]`-prefixed line as at least a
# `log`, and would otherwise claim the others' lines.
PARSERS = {
    "n-m3u8dl-re": n_m3u8dl_re.parse,
    "streamlink": streamlink.parse,
    "ffmpeg": ffmpeg.parse,
    "ytdlp": ytdlp.parse,
    "aria2": aria2.parse,
}

LOG_RESULT = "log"


def new_parser_state(message=None):
    """A fresh per-attempt parser state, seeded with what only the caller knows.

    Fragment counters must not survive a fallback attempt, so this is rebuilt for each
    one. It lives here rather than in `download_task.py` because the seed is part of the
    parser contract: `parsers/ffmpeg.py` documents that it reads `state["duration"]`,
    and nothing else in the host knows how to supply it.
    """
    try:
        duration = float((message or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    return {"duration": duration if duration > 0 else None}


def parse_line(line, backend=None, state=None):
    """Classify `line` as `stage` plus whatever fields that backend reported.

    `backend` of None or "auto" tries every registered parser and returns the
    first non-log classification, falling back to log. A string selects exactly
    one parser. `state` defaults to a throwaway dict: a stateful parser then
    degrades to "no percent" instead of crashing.
    """
    line = latest_output_line(line)
    if backend in (None, "auto"):
        candidates = list(PARSERS.values())
    else:
        candidates = [PARSERS[backend]] if backend in PARSERS else []
    for parse in candidates:
        try:
            result = parse(line, state if state is not None else {})
        except Exception:
            continue
        if result and result.get("stage") != LOG_RESULT:
            return result
    return {"stage": LOG_RESULT, "line": line}
