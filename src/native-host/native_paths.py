import os
import re
from pathlib import Path
from urllib.parse import urlparse

from native_protocol import HostError


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
