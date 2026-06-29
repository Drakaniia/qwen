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

    # Try Gopeed CLI parser as fallback for BitTorrent/magnet downloads
    try:
        from gopeed_adapter import parse_gopeed_line as _gopeed_parse

        gopeed_result = _gopeed_parse(line)
        if gopeed_result["stage"] != "log":
            # Preserve the original line for logging
            if "line" not in gopeed_result:
                gopeed_result["line"] = line
            return gopeed_result
    except ImportError:
        pass
    except Exception:
        pass

    return {"stage": "log", "line": line}


def is_aria2_access_refusal(details):
    text = str(details or "").lower()
    if "aria2" not in text:
        return False
    return any(token in text for token in ["status=401", "status=403", "http error 401", "http error 403"])


# Cloudflare challenge page detection
def is_cloudflare_challenge(content: bytes) -> bool:
    """Check if downloaded content is a Cloudflare challenge page.

    When Cloudflare blocks a request, it returns an HTML challenge page
    instead of the actual video content. This helps detect corrupted
    downloads that "succeeded" but contained HTML instead of video.
    """
    if len(content) < 100:
        return False
    try:
        text = content[:2000].decode("utf-8", errors="ignore").lower()
    except Exception:
        return False
    # Check for Cloudflare-specific challenge page indicators
    # The actual Cloudflare page always has "cloudflare" in it, but we check
    # for both standalone indicators (like cf-chl) and combined patterns
    return ("cloudflare" in text and "attention required" in text) or "cf-chl" in text or "challenge-platform" in text


def is_html_error_page(content: bytes) -> bool:
    """Check if downloaded content is an HTML error page instead of video.

    Returns True if the content looks like an error page (not video).
    This catches cases where the server returns HTML for errors but the
    download tool doesn't detect it properly.
    """
    if len(content) < 100:
        return False
    try:
        text = content[:2000].decode("utf-8", errors="ignore").lower()
    except Exception:
        return False
    # Check for common error page indicators that aren't video content
    if text.startswith("<!doctype html"):
        return any(
            indicator in text
            for indicator in ["<title>error", "<title>403", "<title>404", "<title>500", "forbidden", "access denied"]
        )
    return False


if __name__ == "__main__":
    # Quick smoke test when run directly
    _CLOUDFLARE_HTML = b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>"
    assert is_cloudflare_challenge(_CLOUDFLARE_HTML), "Should detect Cloudflare challenge page"
    _VIDEO_HEADER = b"\x00\x00\x00\x20ftypisom"
    assert not is_cloudflare_challenge(_VIDEO_HEADER), "Should not flag video header as challenge"
    print("Cloudflare detection tests passed")
