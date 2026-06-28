"""Shared helper functions for fallback download engines."""

from pathlib import Path


def _human_size(num_bytes):
    """Convert a byte count to a human-readable string (e.g. '12.5 MB')."""
    if not num_bytes:
        return ""
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return ""


def _find_latest_file(directory):
    """Find the most recently modified file in a directory tree."""
    directory = Path(directory)
    if not directory.is_dir():
        return None
    files = [f for f in directory.rglob("*") if f.is_file()]
    if not files:
        return None
    latest = max(files, key=lambda f: f.stat().st_mtime)
    return str(latest)
