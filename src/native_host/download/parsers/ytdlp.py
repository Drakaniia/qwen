"""yt-dlp output parser (spec §3.4, D10).

Also owns the two lines that are not really yt-dlp-shaped but arrive from any
attempt: the `__QWIN_FILEPATH__` marker written by `yt_dlp_command.py`, and
`[download] Destination:`.

Fragment counting. yt-dlp emits exactly two fragment-related lines, both verified
against the installed yt-dlp source (see the pinned shapes in the comments
below); there is no "Downloading fragment N" line, and one is not invented here.

* `[<fd>] Total fragments: 500` -- `downloader/fragment.py:165,331`. The count
  can carry a ` (not including N ad)` suffix, or be `unknown (live)`.
* `[download]  2.4% of ~12.00MiB at 1.00MiB/s ETA 03:20 (frag 12/500)` --
  `downloader/common.py:402` appends ` (frag {fragment_index}/{fragment_count})`
  to the default progress template whenever both fields are present.
  `fragment_index` is bumped once per *finished* fragment, so it is the
  completion counter.

`fragment_index / fragment_count` is byte-equivalent to the percent on the same
line: `frag_progress_hook` sizes `total_bytes_estimate` as
`bytes_done / (fragment_index + 1) * total_frags`. So the counter is used for the
percent and labelled `percentApproximate` -- segments are not equal-sized, so
segment-fraction is not byte-fraction (D2).
"""

import re
from pathlib import Path

from progress_parser import FILEPATH_MARKER, compact_progress_value

_TOTAL_FRAGMENTS_RE = re.compile(
    r"^\[(?:hlsnative|dashsegments|download)\]\s+Total fragments:\s+(\d+)",
    flags=re.IGNORECASE,
)

_POSTPROCESS_PREFIXES = ("[Merger]", "[VideoConvertor]", "[Fixup")


def parse_yt_dlp_progress_details(line):
    details = {}
    total_match = re.search(r"%\s+of\s+~?\s*([0-9]+(?:\.[0-9]+)?\s*(?:[KMGTPE]?i?B|[KMGTPE]?B|B))", line)
    if total_match:
        details["totalSize"] = compact_progress_value(total_match.group(1))

    speed_match = re.search(r"\bat\s+([0-9]+(?:\.[0-9]+)?\s*(?:[KMGTPE]?i?B|[KMGTPE]?B|B)/s)", line)
    if speed_match:
        details["speed"] = compact_progress_value(speed_match.group(1))

    eta_match = re.search(r"\bETA\s+([^\s\]]+)", line)
    if eta_match:
        details["eta"] = eta_match.group(1).strip()

    fragment_match = re.search(r"\b(?:frag|fragment)\s+(\d+)\s*/\s*(\d+)", line, flags=re.IGNORECASE)
    if fragment_match:
        details["fragment"] = f"{fragment_match.group(1)}/{fragment_match.group(2)}"

    return details


def _fragment_percent(state, fragment):
    """Turn a `done/total` fragment detail into a percent, latching `total`.

    Returns None when the counters are unusable. The latched total is dropped
    once it is reached, so a re-attempt that reuses the same `state` cannot keep
    counting against a stale denominator -- the next `Total fragments:` line
    latches a fresh one.
    """
    done_text, _, total_text = str(fragment).partition("/")
    try:
        done = int(done_text)
        total = int(total_text) if total_text else int(state.get("fragmentTotal") or 0)
    except ValueError:
        return None
    if total <= 0:
        return None

    done = min(done, total)
    state["fragmentTotal"] = total
    state["fragmentDone"] = done
    if done >= total:
        state.pop("fragmentTotal", None)
        state.pop("fragmentDone", None)
    return round(done / total * 100, 2)


def parse(line, state):
    if line.startswith(FILEPATH_MARKER):
        filepath = line[len(FILEPATH_MARKER) :]
        return {
            "stage": "filepath",
            "filepath": filepath,
            "artifactRoot": str(Path(filepath).parent) if filepath else "",
        }

    percent_match = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
    if percent_match:
        details = parse_yt_dlp_progress_details(line)
        percent = float(percent_match.group(1))
        fragment_percent = _fragment_percent(state, details.get("fragment")) if details.get("fragment") else None
        if fragment_percent is not None:
            percent = fragment_percent
            details["percentApproximate"] = True
        return {
            "stage": "download",
            "percent": percent,
            "line": line,
            **details,
        }

    if line.startswith(_POSTPROCESS_PREFIXES):
        return {"stage": "postprocess", "line": line}

    if line.startswith("[download] Destination:"):
        filepath = line.split(":", 1)[1].strip()
        return {
            "stage": "destination",
            "line": line,
            "filepath": filepath,
            "artifactRoot": str(Path(filepath).parent) if filepath else "",
        }

    total_fragments_match = _TOTAL_FRAGMENTS_RE.search(line)
    if total_fragments_match:
        total = int(total_fragments_match.group(1))
        state["fragmentTotal"] = total
        state["fragmentDone"] = 0
        return {
            "stage": "extract",
            "line": line,
            "fragment": f"0/{total}",
        }

    if line.startswith(("[hls", "[dash", "[generic]")):
        return {"stage": "extract", "line": line}

    return {"stage": "log", "line": line}
