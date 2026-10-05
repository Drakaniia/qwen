"""One ffmpeg frame as a base64 JPEG — the last rung of the thumbnail ladder.

Every rung in `content/page_detection.ts:280` is a URL somebody published *about*
the video — poster, site-derived art, og:image — except the canvas capture, which
reads pixels. An HLS stream has none of the first three (hls.js sets no poster,
there is no page to derive from, yt-dlp has no thumbnail for a raw manifest), so
the ladder is empty and the row keeps its format glyph. This reads the stream
itself.

Failure is not an error (H10, spec §4.3). A stream ffmpeg cannot decode — DRM, a
403, a dead edge, a slate at 1s — returns `frameUrl: ""`, because the caller's
glyph is already the correct answer. `HostError` is reserved for *the host cannot
do this at all*: no ffmpeg binary, or a URL ffmpeg could never open.
"""

import base64
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urljoin, urlparse

from registry import register_handler

from browser_context import remove_temp_files
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message
from process_control import creation_flags
from stream_backends import ffmpeg_headers_args
from yt_dlp_dependencies import resolve_ffmpeg_location

# H6: 1s, not 3s — one spawn per URL, and 1s is past most fade-ins without being
# far enough into the stream to miss a short clip.
DEFAULT_AT_SECONDS = "1"


@register_handler("thumbnailFrame")
def run_thumbnail_frame(
    message,
    send=send_native_message,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    page_url = str(message.get("pageUrl") or "").strip()

    # pageUrl "lets the host resolve a relative manifest" (spec §4.1) — same reason
    # the formats message carries it. An absolute URL is left alone.
    if page_url and not urlparse(url).scheme:
        url = urljoin(page_url, url)
    validate_download_url(url)

    # Raises HostError when no ffmpeg exists at all: the one failure here that is
    # not H10, because there is nothing the extension could fall back to.
    ffmpeg_location = ffmpeg_location_resolver()

    frame_file = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False, prefix="qwin-thumb-")
    frame_path = frame_file.name
    frame_file.close()  # Windows holds the handle, so ffmpeg cannot write until it is closed.

    command = [str(ffmpeg_location), "-ss", _seek_argument(message)]
    command.extend(ffmpeg_headers_args(message.get("requestHeaders")))
    command.extend(
        [
            "-i",
            url,
            "-frames:v",
            "1",
            "-vf",
            # LONGEST_EDGE_PX in content/frame_capture.ts:23, so a host grab and an
            # in-page capture are the same size and the row never changes dimensions
            # when one replaces the other. ffmpeg upscales a source smaller than 160;
            # the canvas path clamps at 1 to avoid that. A thumbnail either way.
            "scale=160:-2",
            "-q:v",
            "6",
            "-y",
            frame_path,
        ]
    )

    try:
        frame_url = _grab_frame(command, frame_path)
    finally:
        remove_temp_files([frame_path])

    send({"type": "thumbnailFrame", "id": request_id, "ok": True, "frameUrl": frame_url})


def _seek_argument(message):
    """`-ss` value. H6 puts the timestamp on the host side; anything unparseable or
    negative falls back to the constant rather than failing the whole request."""
    try:
        seconds = float(message.get("atSeconds", DEFAULT_AT_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_AT_SECONDS
    return f"{max(seconds, 0):g}"


def _grab_frame(command, frame_path):
    """Run ffmpeg and return a `data:` URL, or "" when there is no frame (H10)."""
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,  # H9's per-grab budget
            creationflags=creation_flags(),
        )
    except subprocess.TimeoutExpired:
        return ""
    except OSError as exc:
        # The resolver found a path that cannot be executed (deleted, blocked, not
        # a binary). Still "the host cannot do this", not "this stream has no frame".
        raise HostError(f"Could not start ffmpeg: {exc}") from exc

    if completed.returncode != 0:
        return ""
    return _data_url(frame_path)


def _data_url(path):
    try:
        payload = Path(path).read_bytes()
    except OSError:
        return ""
    if not payload:
        return ""
    # A data: URL, not a file path (H5): `background/thumbnail_captures.ts` already
    # recognises data: as a frame capture, so nothing else needs to know about this.
    return f"data:image/jpeg;base64,{base64.b64encode(payload).decode('ascii')}"
