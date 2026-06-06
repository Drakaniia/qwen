import importlib.util
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from browser_context import append_browser_context_options
from native_paths import sanitize_filename
from native_protocol import HostError


FILEPATH_MARKER = "__QWIN_FILEPATH__:"
DEFAULT_FORMAT_SELECTOR = "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCAL_ARIA2C = PROJECT_ROOT / "tools" / "aria2" / "aria2c.exe"
MAX_FAST_CONNECTIONS = 32
DEFAULT_CONCURRENT_FRAGMENTS = MAX_FAST_CONNECTIONS
DEFAULT_ARIA2_CONNECTIONS = MAX_FAST_CONNECTIONS


def get_imageio_ffmpeg_exe():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def resolve_yt_dlp_command():
    executable = shutil.which("yt-dlp")
    if executable:
        return [executable]

    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]

    raise HostError("yt-dlp is not installed. Run scripts\\install.bat, then restart your browser.")


def resolve_ffmpeg_location():
    executable = shutil.which("ffmpeg")
    if executable:
        return executable

    imageio_ffmpeg = get_imageio_ffmpeg_exe()
    if imageio_ffmpeg and Path(imageio_ffmpeg).exists():
        return imageio_ffmpeg

    raise HostError("ffmpeg is not installed. Run scripts\\install.bat, then restart your browser.")


def bounded_int(value, default, minimum=1, maximum=MAX_FAST_CONNECTIONS):
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


def resolve_aria2c_location():
    configured = os.environ.get("QWIN_ARIA2C")
    if configured:
        configured_path = Path(os.path.expandvars(os.path.expanduser(configured)))
        if configured_path.exists():
            return str(configured_path)

    executable = shutil.which("aria2c")
    if executable:
        return executable

    if LOCAL_ARIA2C.exists():
        return str(LOCAL_ARIA2C)

    return None


def has_yt_dlp():
    return bool(shutil.which("yt-dlp") or importlib.util.find_spec("yt_dlp"))


def has_ffmpeg():
    imageio_ffmpeg = get_imageio_ffmpeg_exe()
    return bool(shutil.which("ffmpeg") or (imageio_ffmpeg and Path(imageio_ffmpeg).exists()))


def has_aria2c():
    return bool(resolve_aria2c_location())


def build_yt_dlp_command(
    url,
    download_dir,
    referer=None,
    user_agent=None,
    request_headers=None,
    cookies_file=None,
    yt_dlp_command=None,
    ffmpeg_location=None,
    aria2c_location=None,
    selected_format=None,
    concurrent_fragments=None,
    aria2_connections=None,
):
    download_root = str(Path(download_dir))
    output_template = "%(title).180B/%(title).180B [%(id)s].%(ext)s"
    format_selector = format_selector_for_choice(selected_format)
    fragment_count = bounded_int(concurrent_fragments, DEFAULT_CONCURRENT_FRAGMENTS)
    command = [
        *(yt_dlp_command or ["yt-dlp"]),
        "--ignore-config",
        "--newline",
        "--no-color",
        "--progress",
        "--windows-filenames",
        "--restrict-filenames",
        "--trim-filenames",
        "180",
        "--paths",
        f"home:{download_root}",
        # Leave temp unset so HLS/DASH fragments are written beside the templated output.
        "--concurrent-fragments",
        str(fragment_count),
        "--no-keep-fragments",
        "--no-playlist",
        "-f",
        format_selector,
        "--merge-output-format",
        "mp4",
        "--recode-video",
        "mp4",
        "--print",
        f"after_move:{FILEPATH_MARKER}%(filepath)s",
        "-o",
        output_template,
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])
    if aria2c_location:
        connection_count = bounded_int(aria2_connections, DEFAULT_ARIA2_CONNECTIONS)
        aria2_args = " ".join(
            [
                f"--max-connection-per-server={connection_count}",
                f"--split={connection_count}",
                "--min-split-size=1M",
                "--continue=true",
                "--file-allocation=none",
                "--max-tries=8",
                "--retry-wait=2",
                "--summary-interval=1",
            ]
        )
        command.extend(
            [
                "--downloader",
                str(aria2c_location),
                "--downloader",
                "dash,m3u8:native",
                "--downloader-args",
                f"aria2c:{aria2_args}",
            ]
        )
    append_browser_context_options(
        command,
        referer=referer,
        user_agent=user_agent,
        request_headers=request_headers,
        cookies_file=cookies_file,
    )

    command.append(url)
    return command


def format_selector_for_choice(selected_format):
    selected = str(selected_format or "").strip()
    if not selected or selected == "best":
        return DEFAULT_FORMAT_SELECTOR
    if any(separator in selected for separator in ["+", "/", ","]):
        return selected
    return f"{selected}+bestaudio/best"


def build_formats_command(
    url,
    referer=None,
    user_agent=None,
    request_headers=None,
    cookies_file=None,
    yt_dlp_command=None,
    ffmpeg_location=None,
):
    command = [
        *(yt_dlp_command or ["yt-dlp"]),
        "--ignore-config",
        "--dump-single-json",
        "--no-warnings",
        "--no-color",
        "--no-playlist",
        "--skip-download",
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])
    append_browser_context_options(
        command,
        referer=referer,
        user_agent=user_agent,
        request_headers=request_headers,
        cookies_file=cookies_file,
    )

    command.append(url)
    return command


def human_size(num_bytes):
    if not num_bytes:
        return ""
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return ""


def format_label(item):
    height = item.get("height")
    width = item.get("width")
    ext = str(item.get("ext") or "").upper()
    note = str(item.get("format_note") or "").strip()
    fps = item.get("fps")

    if height:
        label = f"{int(height)}p"
    elif width:
        label = f"{int(width)}w"
    elif note:
        label = note
    else:
        label = str(item.get("format_id") or "format")

    if ext:
        label = f"{label} {ext}"
    if fps and float(fps) > 30:
        label = f"{label} {int(float(fps))}fps"
    return label


def format_sort_key(item):
    return (
        int(item.get("height") or 0),
        float(item.get("tbr") or 0),
        int(item.get("width") or 0),
    )


def is_segmented_stream_format(item):
    protocol = str(item.get("protocol") or "").lower()
    url = str(item.get("url") or "").lower()
    manifest_url = str(item.get("manifest_url") or "").lower()
    format_note = str(item.get("format_note") or "").lower()

    if any(token in protocol for token in ["m3u8", "hls", "dash"]):
        return True
    if any(value.endswith((".m3u8", ".mpd")) for value in [url.split("?", 1)[0], manifest_url.split("?", 1)[0]]):
        return True
    if item.get("fragments") and any(token in format_note for token in ["hls", "dash", "fragment"]):
        return True
    return False


def summarize_formats(info):
    title = sanitize_filename(info.get("title") or info.get("fulltitle") or "Video")
    webpage_url = info.get("webpage_url") or info.get("original_url") or ""
    raw_formats = info.get("formats") or []
    seen_ids = set()
    choices = [
        {
            "id": "best",
            "label": "Best available MP4",
            "ext": "mp4",
            "height": None,
            "size": "",
            "note": "Recommended",
        }
    ]

    video_formats = []
    for item in raw_formats:
        format_id = str(item.get("format_id") or "").strip()
        if not format_id or format_id in seen_ids:
            continue
        if str(item.get("vcodec") or "none").lower() == "none":
            continue
        if is_segmented_stream_format(item):
            continue
        seen_ids.add(format_id)
        video_formats.append(item)

    for item in sorted(video_formats, key=format_sort_key, reverse=True)[:25]:
        choices.append(
            {
                "id": str(item.get("format_id")),
                "label": format_label(item),
                "ext": item.get("ext") or "",
                "height": item.get("height"),
                "width": item.get("width"),
                "fps": item.get("fps"),
                "vcodec": item.get("vcodec") or "",
                "acodec": item.get("acodec") or "",
                "tbr": item.get("tbr"),
                "size": human_size(item.get("filesize") or item.get("filesize_approx")),
                "note": item.get("format_note") or "",
            }
        )

    return {
        "title": title,
        "webpageUrl": webpage_url,
        "formats": choices,
    }


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

    total_fragments_match = re.search(r"^\[(?:hlsnative|dashsegments|download)\]\s+Total fragments:\s+(\d+)", line, flags=re.IGNORECASE)
    if total_fragments_match:
        return {
            "stage": "extract",
            "line": line,
            "fragment": f"0/{total_fragments_match.group(1)}",
        }

    if line.startswith("[hls") or line.startswith("[dash") or line.startswith("[generic]"):
        return {"stage": "extract", "line": line}

    return {"stage": "log", "line": line}


def require_executable(name, install_hint):
    found = shutil.which(name)
    if not found:
        raise HostError(f"{name} is not installed or is not on PATH. {install_hint}")
    return found


def creation_flags():
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def terminate_process_tree(process):
    if process is None or process.poll() is not None:
        return

    pid = getattr(process, "pid", None)
    if os.name == "nt" and pid:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                creationflags=creation_flags(),
            )
            return
        except Exception:
            pass

    try:
        process.terminate()
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def is_aria2_access_refusal(details):
    text = str(details or "").lower()
    if "aria2" not in text:
        return False
    return any(token in text for token in ["status=401", "status=403", "http error 401", "http error 403"])
