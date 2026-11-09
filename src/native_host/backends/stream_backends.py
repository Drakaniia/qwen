import re
from pathlib import Path

from browser_context import clean_request_headers
from native_paths import sanitize_filename
from native_protocol import HostError

STREAM_URL_RE = re.compile(r"(?:\.m3u8|\.mpd|\.ism(?:/Manifest)?)(?:$|[?#])", re.IGNORECASE)

# How many "Title (N)" siblings reserve_stream_output_path tries before giving up.
MAX_OUTPUT_NAME_ATTEMPTS = 1000


def is_stream_manifest_url(url, media_format=""):
    format_text = str(media_format or "").upper()
    if format_text in {"M3U8", "MPD", "ISM"}:
        return True
    return bool(STREAM_URL_RE.search(str(url or "")))


def _safe_stream_title(title):
    """A folder/file stem for `title`: illegal characters and Windows-reserved names
    (CON, NUL, COM1, ...) are handled by `sanitize_filename`, then capped at 120 chars."""
    return sanitize_filename(str(title or "").strip() or "Video")[:120].rstrip(" .") or "Video"


def stream_output_path(download_dir, title, suffix="mp4"):
    """Where a stream job named `title` would write, WITHOUT claiming it.

    Pure path arithmetic for callers that only describe a command (the probe table,
    tests). A real download goes through `reserve_stream_output_path`, which is what
    makes the path this job's alone.
    """
    safe_title = _safe_stream_title(title)
    return Path(download_dir) / safe_title / f"{safe_title}.{suffix}"


def reserve_stream_output_path(download_dir, title, suffix="mp4"):
    """Claim a brand-new folder for one stream job and return the file path inside it.

    Every stream job used to write `<dir>/<title>/<title>.mp4`, and the extension sent
    no title, so all of them collided on `Video/Video.mp4`: ffmpeg `-y` / streamlink
    `--force` overwrote each other, and a cancel's cleanup of `<dir>/Video` deleted
    other jobs' finished files. `mkdir()` without `exist_ok` is atomic, so of two
    concurrent jobs with the same title exactly one gets `Clip`, the other `Clip (2)`.

    The folder did not exist before this call, so everything in it belongs to this job:
    that is what makes `-y` / `--force` (re-running *our own* partial after a pause or a
    fallback) and the cancel-time folder delete safe.
    """
    base = _safe_stream_title(title)
    root = Path(download_dir)
    for attempt in range(1, MAX_OUTPUT_NAME_ATTEMPTS + 1):
        name = base if attempt == 1 else f"{base} ({attempt})"
        folder = root / name
        try:
            folder.mkdir()
        except FileExistsError:
            continue
        except OSError as exc:
            raise HostError(f"Could not create the output folder {folder}: {exc}") from exc
        return folder / f"{name}.{suffix}"
    raise HostError(f"Could not find a free output folder name for {base!r} in {root}.")


def header_args_for_n_m3u8dl_re(request_headers):
    args = []
    for header in clean_request_headers(request_headers):
        if header["name"].lower() in {"cookie", "referer", "origin", "user-agent", "accept", "accept-language"}:
            args.extend(["-H", f"{header['name']}: {header['value']}"])
    return args


def header_args_for_streamlink(request_headers):
    args = []
    for header in clean_request_headers(request_headers):
        name = header["name"].lower()
        if name == "cookie":
            continue
        if name in {"referer", "origin", "user-agent", "accept", "accept-language"}:
            args.extend(["--http-header", f"{header['name']}={header['value']}"])
    return args


def build_n_m3u8dl_re_command(
    url,
    output_path,
    request_headers=None,
    n_m3u8dl_re_location=None,
    ffmpeg_location=None,
):
    output = Path(output_path)
    command = [
        str(n_m3u8dl_re_location or "N_m3u8DL-RE"),
        "--auto-select",
        # Piped stdout disables the live grid, so HLS progress never arrives.
        # --force-ansi-console keeps the rows flowing; --no-ansi-color keeps the
        # tested no-spinner shape (parsers/n_m3u8dl_re.py strips ANSI anyway).
        "--force-ansi-console",
        "--no-ansi-color",
        "--thread-count",
        "32",
        "--download-retry-count",
        "8",
        "--save-dir",
        str(output.parent),
        "--save-name",
        output.stem,
        "-M",
        "format=mp4",
    ]
    if ffmpeg_location:
        command.extend(["--ffmpeg-binary-path", str(ffmpeg_location)])
    command.extend(header_args_for_n_m3u8dl_re(request_headers))
    command.append(str(url))
    return command


def build_streamlink_command(
    url,
    output_path,
    request_headers=None,
    cookies_file=None,
    streamlink_command=None,
    ffmpeg_location=None,
    max_height=0,
):
    command = [
        *(streamlink_command or ["streamlink"]),
        # NOTE: `--json` is deliberately NOT passed, despite spec §3.2 / D5 proposing it.
        # Verified in the installed streamlink_cli/console/console.py: `msg` and
        # `msg_status` both `return` when `self.json` is set, and `Progress.update`
        # writes through exactly those two -- and nothing calls `msg_json` for progress.
        # So `--json` emits no progress object at all *and* suppresses the `[cli][info]` /
        # `[download][info]` text that `download_task.py:353` turns into the user-facing
        # error. It would trade real diagnostic text for nothing. See
        # `download/parsers/streamlink.py`, which still parses the shape for a build that
        # does emit it.
        "--retry-streams",
        "2",
        "--retry-max",
        "3",
        "--stream-segment-attempts",
        "5",
        "--stream-segment-timeout",
        "15",
        "--stream-segment-threads",
        "4",
        "--ringbuffer-size",
        "128M",
        # Safe only because the output folder is reserved fresh per job
        # (`reserve_stream_output_path`): the one file --force can replace is this
        # job's own partial from an earlier attempt or a pause.
        "--force",
        "-o",
        str(output_path),
    ]
    if max_height and int(max_height) > 0:
        # The quality cap: `best` then means "best at or below N", the same answer
        # yt-dlp's `[height<=N]` selector gives.
        command.extend(["--stream-sorting-excludes", f">{int(max_height)}p"])
    if ffmpeg_location:
        command.extend(["--ffmpeg-ffmpeg", str(ffmpeg_location), "--ffmpeg-fout", "mp4"])
    if cookies_file:
        command.extend(["--http-cookies-file", str(cookies_file)])
    command.extend(header_args_for_streamlink(request_headers))
    command.extend([str(url), "best"])
    return command


def ffmpeg_headers_args(request_headers):
    """The ``-headers`` argument for ffmpeg, or ``[]`` when there is nothing to send.

    ffmpeg takes the whole header block as one CRLF-joined string rather than
    repeated ``-H`` flags (spec §4.2). Extracted out of
    build_ffmpeg_direct_command() so the thumbnail grab and the download path
    cannot drift apart on the join or on which headers survive the filter.
    """
    parts = [f"{header['name']}: {header['value']}" for header in clean_request_headers(request_headers)]
    return ["-headers", "\r\n".join(parts)] if parts else []


def build_ffmpeg_direct_command(
    url,
    output_path,
    request_headers=None,
    ffmpeg_location=None,
):
    """Build an ffmpeg command for direct HLS/DASH stream copying.

    Produces::

        ffmpeg -progress pipe:2 -headers <k:v pairs> -i <url> -c copy -y <output>

    This is the simplest, most reliable way to download an HLS or DASH
    stream once the manifest URL has been intercepted. Used as a fallback
    before gallery-dl / yt-dlp-native steps.

    `-progress pipe:2` (spec §3.3, D12) is what turns ffmpeg's stderr into a machine-readable
    `key=value` stream. It needs no Popen change: stderr is already merged into stdout.

    Args:
        url: The stream manifest URL (m3u8, mpd, etc.).
        output_path: Full path for the output file (parent dir must exist --
                     `reserve_stream_output_path` creates it).
        request_headers: Optional list of {"name": ..., "value": ...} dicts
                         to forward as custom HTTP headers.
        ffmpeg_location: Path to ffmpeg binary; defaults to "ffmpeg".

    Returns:
        List of command-line arguments suitable for subprocess.Popen.
    """
    command = [str(ffmpeg_location or "ffmpeg"), "-progress", "pipe:2"]

    # Build custom header string (ffmpeg accepts -headers for HTTP headers)
    command.extend(ffmpeg_headers_args(request_headers))

    command.extend(
        [
            "-i",
            str(url),
            "-c",
            "copy",
            # See --force in build_streamlink_command: the folder is this job's alone.
            "-y",
            str(output_path),
        ]
    )
    return command
