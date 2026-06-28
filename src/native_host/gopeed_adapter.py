import os
import re
import shutil
from pathlib import Path

from native_paths import has_unexpanded_env_vars
from native_protocol import HostError

# Gopeed progress bar regex
# Example: 'downloading... [■■■■□□□□□□□□□□□□□□□□] 20.0% 2.5MB/s 12.5MB'
# Example: 'complete [■■■■■■■■■■■■■■■■■■■■] 100.0% 0B/s 12.5MB'
# Example: 'fail [■■■■■■□□□□□□□□□□□□□□] 40.0% 2.0MB/s 5.0MB'
GOPEED_PROGRESS_RE = re.compile(
    r"^(?:(downloading)\.{3}|(complete)|(fail))\s+\[.*?\]\s+([\d.]+)%\s+([\d.]+[KMGTPE]?B/s)\s+([\d.]+[KMGTPE]?B)",
    re.IGNORECASE,
)

# Gopeed saving path line
# Example: 'saving path: C:\Users\...\file.mp4'
GOPEED_SAVING_PATH_RE = re.compile(r"^saving path:\s+(.+)$", re.IGNORECASE)

# Gopeed fail reason line
# Example: 'reason: connection refused'
GOPEED_FAIL_REASON_RE = re.compile(r"^reason:\s+(.+)$", re.IGNORECASE)


def resolve_gopeed_command(extra_paths=None, _which=None):
    """Locate the gopeed binary.

    Checks, in order:
    1. QWIN_GOPEED environment variable
    2. PATH via shutil.which()
    3. Extra paths (e.g. tools/gopeed/ or Go bin dir)

    Returns a list suitable for subprocess (e.g. ['gopeed']) or None.
    """
    # Check environment variable
    configured = os.environ.get("QWIN_GOPEED")
    if configured:
        expanded = os.path.expandvars(os.path.expanduser(configured))
        if has_unexpanded_env_vars(expanded):
            return None
        configured_path = Path(expanded)
        if configured_path.exists():
            return [str(configured_path)]

    # Use custom which function if provided (for testing)
    which_fn = _which or shutil.which

    # Check PATH
    executable = which_fn("gopeed")
    if executable:
        return [executable]

    # Check extra paths
    for extra_dir in extra_paths or []:
        candidate = Path(extra_dir) / "gopeed"
        if candidate.exists():
            return [str(candidate)]
        candidate_exe = Path(extra_dir) / "gopeed.exe"
        if candidate_exe.exists():
            return [str(candidate_exe)]

    return None


def require_gopeed_location(extra_paths=None, _which=None):
    """Resolve gopeed location or raise HostError if not found."""
    location = resolve_gopeed_command(extra_paths=extra_paths, _which=_which)
    if not location:
        raise HostError(
            "gopeed is not installed. It is required for BitTorrent and magnet downloads. "
            "Run scripts/install.sh, then restart your browser."
        )
    return location


def build_gopeed_command(url, download_dir, gopeed_location=None, connections=16):
    """Build a Gopeed CLI command for any supported URL type.

    Gopeed CLI: gopeed -D <dir> -C <connections> <url>

    Supports HTTP, HTTPS, magnet, and local .torrent file paths.
    """
    if gopeed_location is None:
        gopeed_location = require_gopeed_location()

    if isinstance(gopeed_location, list):
        cmd = list(gopeed_location)
    else:
        cmd = [str(gopeed_location)]

    cmd.extend(["-D", str(download_dir)])
    cmd.extend(["-C", str(connections)])
    cmd.append(str(url))

    return cmd


def build_gopeed_magnet_command(url, download_dir, gopeed_location=None, connections=16):
    """Build a Gopeed CLI command for magnet link download."""
    return build_gopeed_command(
        url=url,
        download_dir=download_dir,
        gopeed_location=gopeed_location,
        connections=connections,
    )


def build_gopeed_torrent_command(torrent_path, download_dir, gopeed_location=None, connections=16):
    """Build a Gopeed CLI command for .torrent file download.

    Gopeed accepts a local .torrent file path directly as the URL argument.
    """
    return build_gopeed_command(
        url=torrent_path,
        download_dir=download_dir,
        gopeed_location=gopeed_location,
        connections=connections,
    )


def build_gopeed_http_command(url, download_dir, gopeed_location=None, connections=16):
    """Build a Gopeed CLI command for HTTP/HTTPS download."""
    return build_gopeed_command(
        url=url,
        download_dir=download_dir,
        gopeed_location=gopeed_location,
        connections=connections,
    )


def parse_gopeed_line(line):
    """Parse a single line of Gopeed CLI output.

    Returns a dict with 'stage', and optionally 'percent', 'speed',
    'totalSize', 'filepath', 'error', and 'line'.

    Stages:
    - 'download': progress update (downloading...)
    - 'done': download complete
    - 'error': download failed or error reason
    - 'filepath': saving path for completed download
    - 'log': other log/status line
    """
    cleaned = str(line).rstrip("\r\n")

    # Check for saving path (sent before completion in CLI output)
    saving_match = GOPEED_SAVING_PATH_RE.match(cleaned)
    if saving_match:
        return {
            "stage": "filepath",
            "filepath": saving_match.group(1).strip(),
        }

    # Check for fail reason
    reason_match = GOPEED_FAIL_REASON_RE.match(cleaned)
    if reason_match:
        return {
            "stage": "error",
            "error": reason_match.group(1).strip(),
        }

    # Check for progress/complete/fail bar
    progress_match = GOPEED_PROGRESS_RE.match(cleaned)
    if progress_match:
        downloading, complete, fail = progress_match.group(1), progress_match.group(2), progress_match.group(3)
        percent = float(progress_match.group(4))
        speed = progress_match.group(5)
        total_size = progress_match.group(6)

        if fail:
            return {
                "stage": "error",
                "percent": percent,
                "speed": speed,
                "totalSize": total_size,
                "line": cleaned,
            }
        elif complete:
            return {
                "stage": "done",
                "percent": percent,
                "speed": speed,
                "totalSize": total_size,
                "line": cleaned,
            }
        else:
            return {
                "stage": "download",
                "percent": percent,
                "speed": speed,
                "totalSize": total_size,
                "line": cleaned,
            }

    return {"stage": "log", "line": cleaned}
