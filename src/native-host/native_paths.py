import os
import re
from pathlib import Path
from urllib.parse import urlparse

from native_protocol import HostError


def is_magnet_url(url):
    """Check if the given URL is a magnet link."""
    if not isinstance(url, str) or not url.strip():
        return False
    return url.strip().startswith("magnet:?xt=urn:")


def validate_magnet_url(url):
    """Validate that the URL is a legitimate magnet link."""
    if not isinstance(url, str) or not url.strip():
        raise HostError("Download request did not include a magnet URL.")
    url = url.strip()
    if not url.startswith("magnet:?xt=urn:"):
        raise HostError("Invalid magnet link format. Magnet links should start with 'magnet:?xt=urn:btih:' or similar.")
    xt_part = url.split("xt=urn:", 1)
    if len(xt_part) < 2 or not xt_part[1]:
        raise HostError("Magnet link is missing the info hash (xt=urn:btih:...).")
    # Ensure there's actual hash content after the URN type prefix (e.g. "btih:")
    remaining = xt_part[1]
    hash_part = remaining.split("&", 1)[0] if "&" in remaining else remaining
    hash_value = hash_part.split(":", 1)[1] if ":" in hash_part else ""
    if not hash_value:
        raise HostError("Magnet link is missing the info hash value (expected 40 hex chars after btih:).")
    return url


def validate_torrent_file(path):
    """Validate that the path points to an existing local .torrent file.

    Returns the resolved absolute path string on success.
    """
    if not isinstance(path, str) or not path.strip():
        raise HostError("Download request did not include a .torrent file path.")

    candidate = Path(os.path.expandvars(os.path.expanduser(path.strip()))).resolve()
    if candidate.suffix.lower() != ".torrent":
        raise HostError("Selected file is not a .torrent file.")
    if not candidate.is_file():
        raise HostError(f"The .torrent file could not be found: {candidate}")
    return str(candidate)


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

    url = url.strip()
    if url.startswith("magnet:?"):
        return

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HostError(
            "Only http:// and https:// media, playlist, or supported video page URLs can be sent to yt-dlp. "
            "Browser-only blob:, data:, file:, and DRM-protected URLs cannot be downloaded this way."
        )
