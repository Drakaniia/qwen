"""Direct HTTP download engine for explicit media URLs.

Downloads media files directly via HTTP(S) using Python urllib,
with support for cancellation and progress reporting.
"""

import urllib.error
import urllib.request
from pathlib import Path
from threading import Event

from native_protocol import HostError


def is_direct_media_url(url):
    """Check whether a URL likely points directly at a media file."""
    path = str(url or "").split("?", 1)[0].split("#", 1)[0].lower()
    return any(
        path.endswith(ext)
        for ext in [
            ".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv",
            ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav",
            ".m3u8", ".mpd",
        ]
    )


_SUPPORTED_DIRECT_EXTS = frozenset({
    ".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv",
    ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav",
})


def download_direct(
    url,
    output_path,
    cancel_event=None,
    progress_callback=None,
    chunk_size=1048576,
):
    """Download a direct media URL to a local file using Python urllib.

    Supports pause/cancel via the cancel_event. Reports progress as
    bytes downloaded via progress_callback(bytes_downloaded, total_bytes).

    Returns the output_path on success. Raises HostError on failure.
    """
    from urllib.parse import urlparse

    parsed = urlparse(str(url))
    if parsed.scheme not in {"http", "https"}:
        raise HostError(f"Unsupported URL scheme for direct download: {parsed.scheme}")

    cancel = cancel_event or Event()
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    req = urllib.request.Request(
        str(url),
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0

            with open(str(output), "wb") as f:
                while True:
                    if cancel.is_set():
                        f.close()
                        if output.exists():
                            output.unlink()
                        return None

                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total)
    except urllib.error.HTTPError as exc:
        raise HostError(f"Direct download failed: HTTP {exc.code} {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise HostError(f"Direct download failed: {exc.reason}") from exc
    except OSError as exc:
        raise HostError(f"Direct download failed: {exc}") from exc

    return str(output)
