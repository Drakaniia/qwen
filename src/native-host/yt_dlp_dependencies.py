import importlib.util
import os
import shutil
import sys
from pathlib import Path

from native_protocol import HostError

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOCAL_ARIA2C = PROJECT_ROOT / "tools" / "aria2" / "aria2c.exe"
LOCAL_N_M3U8DL_RE = PROJECT_ROOT / "tools" / "n_m3u8dl-re" / "N_m3u8DL-RE.exe"


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


def resolve_ffmpeg_location(imageio_resolver=None):
    executable = shutil.which("ffmpeg")
    if executable:
        return executable

    resolver = imageio_resolver or get_imageio_ffmpeg_exe
    imageio_ffmpeg = resolver()
    if imageio_ffmpeg and Path(imageio_ffmpeg).exists():
        return imageio_ffmpeg

    raise HostError("ffmpeg is not installed. Run scripts\\install.bat, then restart your browser.")


def resolve_aria2c_location(local_aria2c=None):
    configured = os.environ.get("QWIN_ARIA2C")
    if configured:
        configured_path = Path(os.path.expandvars(os.path.expanduser(configured)))
        if configured_path.exists():
            return str(configured_path)

    executable = shutil.which("aria2c")
    if executable:
        return executable

    bundled = LOCAL_ARIA2C if local_aria2c is None else Path(local_aria2c)
    if bundled.exists():
        return str(bundled)

    return None


def require_aria2c_location(local_aria2c=None):
    """Resolve aria2c location or raise HostError if not found.

    Unlike ``resolve_aria2c_location()`` which returns None when aria2c
    is missing, this function raises an error because aria2c is required
    for all downloads (fast segmented mode, BitTorrent, etc.).
    """
    location = resolve_aria2c_location(local_aria2c=local_aria2c)
    if not location:
        raise HostError(
            "aria2c is not installed. It is required for all downloads. "
            "Run scripts\\install.bat, then restart your browser."
        )
    return location


def resolve_n_m3u8dl_re_location(local_n_m3u8dl_re=None):
    configured = os.environ.get("QWIN_N_M3U8DL_RE")
    if configured:
        configured_path = Path(os.path.expandvars(os.path.expanduser(configured)))
        if configured_path.exists():
            return str(configured_path)

    executable = shutil.which("N_m3u8DL-RE") or shutil.which("N_m3u8DL-RE.exe")
    if executable:
        return executable

    bundled = LOCAL_N_M3U8DL_RE if local_n_m3u8dl_re is None else Path(local_n_m3u8dl_re)
    if bundled.exists():
        return str(bundled)

    return None


def resolve_streamlink_command():
    executable = shutil.which("streamlink")
    if executable:
        return [executable]

    if importlib.util.find_spec("streamlink") is not None:
        return [sys.executable, "-m", "streamlink"]

    return None


def has_yt_dlp():
    return bool(shutil.which("yt-dlp") or importlib.util.find_spec("yt_dlp"))


def has_ffmpeg(imageio_resolver=None):
    resolver = imageio_resolver or get_imageio_ffmpeg_exe
    imageio_ffmpeg = resolver()
    return bool(shutil.which("ffmpeg") or (imageio_ffmpeg and Path(imageio_ffmpeg).exists()))


def has_aria2c(local_aria2c=None):
    return bool(resolve_aria2c_location(local_aria2c=local_aria2c))


def has_n_m3u8dl_re(local_n_m3u8dl_re=None):
    return bool(resolve_n_m3u8dl_re_location(local_n_m3u8dl_re=local_n_m3u8dl_re))


def resolve_gallery_dl_command():
    """Locate the gallery-dl executable (binary or python -m module)."""
    executable = shutil.which("gallery-dl")
    if executable:
        return [executable]

    if importlib.util.find_spec("gallery_dl") is not None:
        return [sys.executable, "-m", "gallery_dl"]

    return None


def has_gallery_dl():
    """Check whether gallery-dl is available."""
    return resolve_gallery_dl_command() is not None


def has_streamlink():
    return bool(resolve_streamlink_command())
