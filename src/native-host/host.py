#!/usr/bin/env python3
import json
import importlib.util
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from urllib.parse import urlparse


HOST_VERSION = "1.0.0"
MAX_INCOMING_BYTES = 64 * 1024 * 1024
MAX_OUTGOING_BYTES = 1024 * 1024
FILEPATH_MARKER = "__QWIN_FILEPATH__:"
DEFAULT_FORMAT_SELECTOR = "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCAL_ARIA2C = PROJECT_ROOT / "tools" / "aria2" / "aria2c.exe"
DEFAULT_CONCURRENT_FRAGMENTS = 8
DEFAULT_ARIA2_CONNECTIONS = 16
MAX_FAST_CONNECTIONS = 32
OUTGOING_LOCK = threading.Lock()
ACTIVE_DOWNLOADS = {}
ACTIVE_DOWNLOADS_LOCK = threading.Lock()
HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
NATIVE_HEADER_NAMES = {
    "accept",
    "accept-language",
    "authorization",
    "cookie",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "user-agent",
    "x-requested-with",
}
MAX_HEADER_VALUE_LENGTH = 8192


class HostError(Exception):
    pass


def configure_binary_stdio():
    if os.name != "nt":
        return

    try:
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception as exc:
        print(f"Failed to switch stdio to binary mode: {exc}", file=sys.stderr)


def encode_native_message(message):
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_OUTGOING_BYTES:
        raise HostError("Native messaging response is too large.")
    return struct.pack("=I", len(payload)) + payload


def read_native_message(input_stream=None):
    stream = input_stream or sys.stdin.buffer
    raw_length = stream.read(4)
    if raw_length == b"":
        raise EOFError
    if len(raw_length) != 4:
        raise HostError("Received an incomplete native messaging length prefix.")

    message_length = struct.unpack("=I", raw_length)[0]
    if message_length > MAX_INCOMING_BYTES:
        raise HostError("Native messaging request is too large.")

    raw_payload = stream.read(message_length)
    if len(raw_payload) != message_length:
        raise HostError("Received an incomplete native messaging payload.")

    return json.loads(raw_payload.decode("utf-8"))


def send_native_message(message, output_stream=None):
    stream = output_stream or sys.stdout.buffer
    encoded = encode_native_message(message)
    with OUTGOING_LOCK:
        stream.write(encoded)
        stream.flush()


def sanitize_filename(name):
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(name))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        return "video"

    reserved = {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
    }
    if cleaned.upper() in reserved:
        cleaned = f"{cleaned}_file"

    return cleaned[:180]


def default_download_dir(env=None):
    source = env if env is not None else os.environ
    user_profile = source.get("USERPROFILE")
    if user_profile:
        return Path(user_profile) / "Downloads"
    return Path.home() / "Downloads"


def resolve_download_dir(folder):
    if folder:
        target = Path(os.path.expandvars(os.path.expanduser(str(folder)))).resolve()
    else:
        target = default_download_dir().resolve()

    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HostError(f"Could not create or access download folder: {target}. {exc}") from exc

    if not target.is_dir():
        raise HostError(f"Download path is not a folder: {target}")

    return target


def validate_download_url(url):
    if not isinstance(url, str) or not url.strip():
        raise HostError("Download request did not include a video URL.")

    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HostError(
            "Only direct http:// and https:// video or playlist URLs can be sent to yt-dlp. "
            "Browser-only blob:, data:, file:, and DRM-protected URLs cannot be downloaded this way."
        )


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


def canonical_header_name(name):
    return "-".join(part[:1].upper() + part[1:].lower() for part in str(name).split("-") if part)


def clean_header_value(value):
    cleaned = re.sub(r"[\r\n]+", " ", str(value or "")).strip()
    return cleaned[:MAX_HEADER_VALUE_LENGTH]


def clean_request_headers(headers):
    cleaned = {}
    if not isinstance(headers, list):
        return []

    for header in headers:
        if not isinstance(header, dict):
            continue
        raw_name = str(header.get("name") or "").strip()
        name = raw_name.lower()
        value = clean_header_value(header.get("value"))
        if not name or not value:
            continue
        if name not in NATIVE_HEADER_NAMES or not HEADER_NAME_RE.match(raw_name):
            continue
        cleaned[name] = {
            "name": canonical_header_name(raw_name),
            "value": value,
        }

    return list(cleaned.values())


def append_browser_context_options(command, referer=None, user_agent=None, request_headers=None):
    headers = {header["name"].lower(): header for header in clean_request_headers(request_headers)}
    cleaned_referer = clean_header_value(referer)
    cleaned_user_agent = clean_header_value(user_agent)

    if cleaned_referer and "referer" not in headers:
        headers["referer"] = {"name": "Referer", "value": cleaned_referer}
    if cleaned_user_agent and "user-agent" not in headers:
        headers["user-agent"] = {"name": "User-Agent", "value": cleaned_user_agent}

    if cleaned_user_agent:
        command.extend(["--user-agent", cleaned_user_agent])

    for header in headers.values():
        command.extend(["--add-header", f"{header['name']}:{header['value']}"])


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
    yt_dlp_command=None,
    ffmpeg_location=None,
    aria2c_location=None,
    selected_format=None,
    concurrent_fragments=None,
    aria2_connections=None,
):
    output_template = str(Path(download_dir) / "%(title).180B" / "%(title).180B [%(id)s].%(ext)s")
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
        command.extend(["--downloader", str(aria2c_location), "--downloader-args", f"aria2c:{aria2_args}"])
    append_browser_context_options(command, referer=referer, user_agent=user_agent, request_headers=request_headers)

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
    append_browser_context_options(command, referer=referer, user_agent=user_agent, request_headers=request_headers)

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


def parse_yt_dlp_line(line):
    line = line.rstrip("\r\n")
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
        }

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


class DownloadTask:
    def __init__(self, message, command, download_dir, send=send_native_message):
        self.message = message
        self.command = command
        self.download_dir = download_dir
        self.send = send
        self.id = str(message.get("id") or message.get("requestId") or "")
        self.lock = threading.Lock()
        self.pause_requested = threading.Event()
        self.resume_requested = threading.Event()
        self.cancel_requested = threading.Event()
        self.process = None
        self.state = "queued"
        self.final_path = None
        self.current_path = None
        self.artifact_root = None
        self.recent_lines = deque(maxlen=25)
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, name=f"qwin-download-{self.id}", daemon=False)
        self.thread.start()
        return self.thread

    def set_state(self, state):
        with self.lock:
            self.state = state

    def send_message(self, message):
        self.send({"id": self.id, **message})

    def pause(self):
        with self.lock:
            if self.state == "paused":
                return {
                    "type": "paused",
                    "id": self.id,
                    "status": "paused",
                    "message": "Download is already paused.",
                }
            if self.state not in {"queued", "running", "starting", "pausing"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download cannot be paused now.",
                }
            self.state = "pausing"
            self.pause_requested.set()
            process = self.process

        terminate_process_tree(process)
        return {
            "type": "control",
            "id": self.id,
            "status": "pausing",
            "message": "Pausing download...",
        }

    def resume(self):
        with self.lock:
            if self.state not in {"paused", "pausing"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download is not paused.",
                }
            self.state = "running"
            self.pause_requested.clear()
            self.resume_requested.set()

        return {
            "type": "resumed",
            "id": self.id,
            "status": "running",
            "message": "Resuming download...",
        }

    def cancel(self):
        with self.lock:
            if self.state in {"done", "error", "canceled"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download is no longer active.",
                }
            self.state = "canceling"
            self.cancel_requested.set()
            self.pause_requested.clear()
            self.resume_requested.set()
            process = self.process

        terminate_process_tree(process)
        return {
            "type": "control",
            "id": self.id,
            "status": "canceling",
            "message": "Canceling download...",
        }

    def run_process_once(self):
        self.set_state("starting")
        try:
            process = subprocess.Popen(
                self.command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creation_flags(),
            )
        except OSError as exc:
            raise HostError(f"Could not start yt-dlp: {exc}") from exc

        with self.lock:
            self.process = process
            self.state = "running"

        assert process.stdout is not None
        for line in process.stdout:
            parsed = parse_yt_dlp_line(line)
            if parsed.get("filepath"):
                self.current_path = parsed["filepath"]
            if parsed.get("artifactRoot"):
                self.artifact_root = parsed["artifactRoot"]
            if parsed["stage"] == "filepath":
                self.final_path = parsed["filepath"]
            else:
                self.recent_lines.append(parsed.get("line", ""))
            self.send_message({"type": "progress", **parsed})

        exit_code = process.wait()
        with self.lock:
            if self.process is process:
                self.process = None
        return exit_code

    def wait_for_resume_or_cancel(self):
        self.resume_requested.clear()
        self.set_state("paused")
        self.send_message(
            {
                "type": "paused",
                "status": "paused",
                "filepath": self.current_path or self.final_path or "",
                "artifactRoot": self.artifact_root or "",
                "message": "Download paused. Resume will continue the partial file when yt-dlp can reuse it.",
            }
        )

        while not self.cancel_requested.is_set():
            if self.resume_requested.wait(0.2):
                self.resume_requested.clear()
                return True
        return False

    def run(self):
        try:
            attempt = 0
            while not self.cancel_requested.is_set():
                attempt += 1
                self.send_message(
                    {
                        "type": "started",
                        "status": "running",
                        "message": (
                            f"Downloading to {self.download_dir}"
                            if attempt == 1
                            else "Resuming download from partial files..."
                        ),
                    }
                )
                exit_code = self.run_process_once()

                if self.cancel_requested.is_set():
                    self.set_state("canceled")
                    self.send_message(
                        {
                            "type": "canceled",
                            "status": "canceled",
                            "filepath": self.current_path or self.final_path or "",
                            "artifactRoot": self.artifact_root or "",
                            "message": "Download canceled.",
                        }
                    )
                    return

                if self.pause_requested.is_set():
                    if not self.wait_for_resume_or_cancel():
                        self.set_state("canceled")
                        self.send_message(
                            {
                                "type": "canceled",
                                "status": "canceled",
                                "filepath": self.current_path or self.final_path or "",
                                "artifactRoot": self.artifact_root or "",
                                "message": "Download canceled.",
                            }
                        )
                        return
                    continue

                if exit_code != 0:
                    details = "\n".join(item for item in self.recent_lines if item).strip()
                    if not details:
                        details = f"yt-dlp exited with status {exit_code}."
                    raise HostError(details)

                self.set_state("done")
                self.send_message(
                    {
                        "type": "done",
                        "status": "done",
                        "filepath": self.final_path,
                        "artifactRoot": self.artifact_root or (str(Path(self.final_path).parent) if self.final_path else ""),
                        "message": "Download complete.",
                    }
                )
                return
        except HostError as exc:
            if self.cancel_requested.is_set():
                self.set_state("canceled")
                self.send_message(
                    {
                        "type": "canceled",
                        "status": "canceled",
                        "filepath": self.current_path or self.final_path or "",
                        "artifactRoot": self.artifact_root or "",
                        "message": "Download canceled.",
                    }
                )
            else:
                self.set_state("error")
                self.send_message(
                    {
                        "type": "error",
                        "status": "error",
                        "filepath": self.current_path or self.final_path or "",
                        "artifactRoot": self.artifact_root or "",
                        "error": str(exc),
                    }
                )
        except Exception as exc:
            self.set_state("error")
            self.send_message(
                {
                    "type": "error",
                    "status": "error",
                    "filepath": self.current_path or self.final_path or "",
                    "artifactRoot": self.artifact_root or "",
                    "error": f"Unexpected helper error: {exc}",
                }
            )
        finally:
            with ACTIVE_DOWNLOADS_LOCK:
                if ACTIVE_DOWNLOADS.get(self.id) is self:
                    del ACTIVE_DOWNLOADS[self.id]


def build_open_path_command(path, reveal=False):
    target = Path(path)
    if os.name == "nt":
        if reveal:
            return ["explorer.exe", "/select,", str(target)]
        return None

    opener = "open" if sys.platform == "darwin" else "xdg-open"
    return [opener, str(target.parent if reveal else target)]


def open_download_path(message, reveal=False):
    request_id = str(message.get("id") or message.get("requestId") or "")
    raw_path = str(message.get("path") or message.get("filepath") or "").strip()
    if not raw_path:
        raise HostError("No downloaded file path is available for this item.")

    target = Path(os.path.expandvars(os.path.expanduser(raw_path))).resolve()
    if not target.exists():
        parent = target.parent
        if reveal and parent.exists():
            target = parent
            reveal = False
        else:
            raise HostError(f"Downloaded file no longer exists: {target}")

    command = build_open_path_command(target, reveal=reveal)
    if command is None:
        try:
            os.startfile(str(target))  # type: ignore[attr-defined]
        except OSError as exc:
            raise HostError(f"Could not open downloaded file: {exc}") from exc
    else:
        try:
            subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags(),
            )
        except OSError as exc:
            raise HostError(f"Could not open downloaded file location: {exc}") from exc

    send_native_message({"type": "opened", "id": request_id, "path": str(target)})


def resolve_artifact_path(value):
    return Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()


def is_dangerous_delete_target(target):
    if not target or target.parent == target:
        return True

    lowered_name = target.name.lower()
    dangerous_names = {
        "",
        ".",
        "..",
        "downloads",
        "desktop",
        "documents",
        "videos",
        "music",
        "pictures",
    }
    if lowered_name in dangerous_names:
        return True

    try:
        if target == Path.home().resolve() or target == default_download_dir().resolve():
            return True
    except OSError:
        pass

    return False


def should_delete_parent_folder_for_file(path):
    parent = path.parent
    if is_dangerous_delete_target(parent):
        return False

    parent_name = parent.name.lower()
    file_stem = path.stem.lower()
    return bool(parent_name and (file_stem.startswith(parent_name) or parent_name in file_stem))


def unique_delete_targets(message):
    roots = []
    for key in ["artifactRoot", "artifactDir", "outputDirectory"]:
        value = message.get(key)
        if value:
            roots.append(resolve_artifact_path(value))

    raw_paths = []
    for key in ["path", "filepath"]:
        value = message.get(key)
        if value:
            raw_paths.append(resolve_artifact_path(value))
    for value in message.get("artifactPaths") or []:
        if value:
            raw_paths.append(resolve_artifact_path(value))

    if not roots:
        for path in raw_paths:
            roots.append(path.parent if should_delete_parent_folder_for_file(path) else path)

    candidates = []
    for target in roots:
        if is_dangerous_delete_target(target):
            continue
        if target not in candidates:
            candidates.append(target)

    candidates.sort(key=lambda item: len(item.parts))
    collapsed = []
    for target in candidates:
        if any(parent == target or parent in target.parents for parent in collapsed):
            continue
        collapsed.append(target)
    return collapsed


def delete_download_artifacts(message, send=send_native_message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    deleted = []
    missing = []

    for target in unique_delete_targets(message):
        if not target.exists():
            missing.append(str(target))
            continue
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except OSError as exc:
            raise HostError(f"Could not delete downloaded artifacts at {target}: {exc}") from exc
        deleted.append(str(target))

    send({"type": "deletedArtifacts", "id": request_id, "deleted": deleted, "missing": missing})


def control_download(message, action):
    request_id = str(message.get("id") or message.get("requestId") or "")
    with ACTIVE_DOWNLOADS_LOCK:
        task = ACTIVE_DOWNLOADS.get(request_id)

    if not task:
        raise HostError("That download is no longer active. Use Retry to start it again.")

    response = getattr(task, action)()
    send_native_message(response)


def cancel_active_downloads():
    with ACTIVE_DOWNLOADS_LOCK:
        tasks = list(ACTIVE_DOWNLOADS.values())
    for task in tasks:
        task.cancel()


def run_download(message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    yt_dlp_command = resolve_yt_dlp_command()
    ffmpeg_location = resolve_ffmpeg_location()
    aria2c_location = resolve_aria2c_location()

    download_dir = resolve_download_dir(message.get("downloadFolder"))
    command = build_yt_dlp_command(
        url=url,
        download_dir=download_dir,
        referer=message.get("pageUrl"),
        user_agent=message.get("userAgent"),
        request_headers=message.get("requestHeaders"),
        yt_dlp_command=yt_dlp_command,
        ffmpeg_location=ffmpeg_location,
        aria2c_location=aria2c_location,
        selected_format=message.get("formatId"),
    )

    task = DownloadTask(message=message, command=command, download_dir=download_dir)
    with ACTIVE_DOWNLOADS_LOCK:
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


def run_format_list(message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    command = build_formats_command(
        url=url,
        referer=message.get("pageUrl"),
        user_agent=message.get("userAgent"),
        request_headers=message.get("requestHeaders"),
        yt_dlp_command=resolve_yt_dlp_command(),
        ffmpeg_location=resolve_ffmpeg_location(),
    )

    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while asking yt-dlp for available qualities.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    try:
        info = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HostError("yt-dlp returned invalid format metadata.") from exc

    send_native_message({"type": "formats", "id": request_id, **summarize_formats(info)})


def dependency_status():
    return {
        "ytDlp": has_yt_dlp(),
        "ffmpeg": has_ffmpeg(),
        "aria2c": has_aria2c(),
    }


def handle_message(message):
    message_type = message.get("type")
    request_id = str(message.get("id") or message.get("requestId") or "")

    if message_type == "ping":
        send_native_message(
            {
                "type": "pong",
                "id": request_id,
                "version": HOST_VERSION,
                "dependencies": dependency_status(),
            }
        )
        return

    if message_type == "download":
        run_download(message)
        return

    if message_type in {"pause", "resume", "cancel"}:
        control_download(message, message_type)
        return

    if message_type == "openFile":
        open_download_path(message, reveal=False)
        return

    if message_type == "showFile":
        open_download_path(message, reveal=True)
        return

    if message_type == "deleteArtifacts":
        delete_download_artifacts(message)
        return

    if message_type == "formats":
        run_format_list(message)
        return

    raise HostError(f"Unknown native host request type: {message_type}")


def main():
    configure_binary_stdio()
    while True:
        try:
            message = read_native_message()
        except EOFError:
            cancel_active_downloads()
            return 0
        except Exception as exc:
            print(f"Native messaging protocol error: {exc}", file=sys.stderr)
            return 1

        request_id = ""
        if isinstance(message, dict):
            request_id = str(message.get("id") or message.get("requestId") or "")

        try:
            handle_message(message)
        except HostError as exc:
            send_native_message({"type": "error", "id": request_id, "error": str(exc)})
        except Exception as exc:
            print(f"Unhandled host error: {exc}", file=sys.stderr)
            send_native_message(
                {
                    "type": "error",
                    "id": request_id,
                    "error": f"Unexpected helper error: {exc}",
                }
            )


if __name__ == "__main__":
    raise SystemExit(main())
