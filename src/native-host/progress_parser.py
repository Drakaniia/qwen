import re
from pathlib import Path

FILEPATH_MARKER = "__QWIN_FILEPATH__:"


def latest_output_line(line):
    cleaned = str(line).rstrip("\r\n")
    parts = [part.strip() for part in re.split(r"[\r\n]+", cleaned) if part.strip()]
    return parts[-1] if parts else cleaned


def compact_progress_value(value):
    return re.sub(r"\s+", "", str(value or "").strip().lstrip("~").strip())


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


def iter_process_output_lines(stream):
    buffer = []
    while True:
        chunk = stream.read(1)
        if chunk == "":
            break
        if chunk in {"\r", "\n"}:
            if buffer:
                yield "".join(buffer)
                buffer = []
            continue
        buffer.append(chunk)

    if buffer:
        yield "".join(buffer)


def parse_yt_dlp_line(line):
    line = latest_output_line(line)
    if line.startswith(FILEPATH_MARKER):
        filepath = line[len(FILEPATH_MARKER) :]
        return {
            "stage": "filepath",
            "filepath": filepath,
            "artifactRoot": str(Path(filepath).parent) if filepath else "",
        }

    percent_match = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
    if percent_match:
        return {
            "stage": "download",
            "percent": float(percent_match.group(1)),
            "line": line,
            **parse_yt_dlp_progress_details(line),
        }

    aria2_percent_match = re.search(r"\((\d+(?:\.\d+)?)%\)", line) if line.startswith("[#") else None
    if aria2_percent_match:
        return {
            "stage": "download",
            "percent": float(aria2_percent_match.group(1)),
            "line": line,
            **parse_aria2_progress_details(line),
        }

    aria2_activity = parse_aria2_fragment_activity(line)
    if aria2_activity:
        return aria2_activity

    if line.startswith("[Merger]") or line.startswith("[VideoConvertor]") or line.startswith("[Fixup"):
        return {"stage": "postprocess", "line": line}

    if line.startswith("[download] Destination:"):
        filepath = line.split(":", 1)[1].strip()
        return {
            "stage": "destination",
            "line": line,
            "filepath": filepath,
            "artifactRoot": str(Path(filepath).parent) if filepath else "",
        }

    total_fragments_match = re.search(
        r"^\[(?:hlsnative|dashsegments|download)\]\s+Total fragments:\s+(\d+)", line, flags=re.IGNORECASE
    )
    if total_fragments_match:
        return {
            "stage": "extract",
            "line": line,
            "fragment": f"0/{total_fragments_match.group(1)}",
        }

    if line.startswith("[hls") or line.startswith("[dash") or line.startswith("[generic]"):
        return {"stage": "extract", "line": line}

    return {"stage": "log", "line": line}


def is_aria2_access_refusal(details):
    text = str(details or "").lower()
    if "aria2" not in text:
        return False
    return any(token in text for token in ["status=401", "status=403", "http error 401", "http error 403"])
