import os
import re
from pathlib import Path
from urllib.parse import urlparse

from native_protocol import HostError

# Extended env-var pattern: matches %VAR_NAME% on Windows
_ENV_VAR_RE = re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%")


def has_unexpanded_env_vars(path_str):
    """Check if a path string contains unexpanded Windows %VAR% patterns.

    After calling os.path.expandvars(), any remaining %VAR% references
    indicate either:
    - An undefined environment variable that wasn't expanded (potential injection)
    - Deliberate % signs in the path (extremely rare)

    Rejecting these prevents attackers from using e.g. %APPDATA% or %USERPROFILE%
    to redirect file operations to arbitrary locations.
    """
    if not isinstance(path_str, str):
        return False
    return bool(_ENV_VAR_RE.search(path_str))


def is_safe_resolved_path(resolved_path, allowed_bases=None):
    """Verify that a resolved path stays within an allowed base directory.

    This prevents directory traversal attacks that could write files outside
    the intended download directory or user's home folder.

    By default, the user's home directory and default Downloads folder are allowed.
    Returns True if the path is under at least one allowed base.
    """
    if allowed_bases is None:
        try:
            allowed_bases = [Path.home().resolve(), default_download_dir().resolve()]
        except (OSError, RuntimeError):
            return False

    try:
        resolved = Path(resolved_path).resolve(strict=False)
    except (OSError, ValueError):
        return False

    for base in allowed_bases:
        try:
            base_resolved = Path(base).resolve(strict=False)
            resolved.relative_to(base_resolved)
            return True
        except (ValueError, OSError):
            continue
    return False


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
        expanded = os.path.expandvars(os.path.expanduser(str(folder)))
        if has_unexpanded_env_vars(expanded):
            raise HostError("Download folder path contains unexpanded environment variables.")
        target = Path(expanded).resolve()
    else:
        target = default_download_dir().resolve()

    # Verify the resolved path is within the user's home directory
    if not is_safe_resolved_path(target):
        raise HostError(
            f"Download path is not within an allowed directory: {target}. "
            f"Please choose a folder within your user profile."
        )

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

    # magnet: links used to be waved through here although the torrent backend was
    # deleted (AGENTS.md: dad38be / f38e6de / 8c5c698) -- they reached yt-dlp and failed
    # there with a confusing error. They are rejected with every other non-http scheme.
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HostError(
            "Only http:// and https:// media, playlist, or supported video page URLs can be sent to yt-dlp. "
            "Browser-only blob:, data:, file:, and DRM-protected URLs cannot be downloaded this way."
        )
