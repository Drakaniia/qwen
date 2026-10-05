"""aria2c output parser.

Moved verbatim out of `progress_parser.py` (spec D11) -- the `[#gid size/total(pct)
CN:n DL: ETA:]` row shape is aria2c's and nothing else's, so it gets its own
module. Behaviour is unchanged; the regression guard is
`tests/native/test_progress_parsers.py`.
"""

import re

from progress_parser import compact_progress_value


def parse_aria2_progress_details(line):
    details = {}
    size_match = re.search(
        r"^\[#\S+\s+([^/\s\]]+)/([^\s\](]+)\((\d+(?:\.\d+)?)%\)",
        line,
    )
    if size_match:
        details["downloadedSize"] = compact_progress_value(size_match.group(1))
        details["totalSize"] = compact_progress_value(size_match.group(2))

    connections_match = re.search(r"\bCN:(\d+)", line)
    if connections_match:
        details["connections"] = int(connections_match.group(1))

    speed_match = re.search(r"\bDL:([^\s\]]+)", line)
    if speed_match:
        speed = compact_progress_value(speed_match.group(1))
        details["speed"] = speed if speed.endswith("/s") else f"{speed}/s"

    eta_match = re.search(r"\bETA:([^\s\]]+)", line)
    if eta_match:
        details["eta"] = eta_match.group(1).strip()

    return details


def parse_aria2_fragment_activity(line):
    if "[#" not in line:
        return None

    active_fragments = len(re.findall(r"\[#\S+", line))
    if active_fragments <= 0:
        return None

    details = parse_aria2_progress_details(line)
    details["fragment"] = f"{active_fragments} active"
    return {
        "stage": "download",
        "line": line,
        **details,
    }


def parse(line, state):
    if line.startswith("[#"):
        percent_match = re.search(r"\((\d+(?:\.\d+)?)%\)", line)
        if percent_match:
            return {
                "stage": "download",
                "percent": float(percent_match.group(1)),
                "line": line,
                **parse_aria2_progress_details(line),
            }

    activity = parse_aria2_fragment_activity(line)
    if activity:
        return activity

    return {"stage": "log", "line": line}
