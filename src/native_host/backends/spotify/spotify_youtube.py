"""YouTube search and download for Spotify fallback.

Handles:
    - Searching YouTube for a matching audio track by artist/title
    - Fetching audio-only format listings from a YouTube video
    - Building yt-dlp download commands with Spotify metadata embedding

Public API:
    - search_youtube(artist, title, yt_dlp_command) -> dict|None
    - get_youtube_audio_formats(youtube_url, yt_dlp_command, ffmpeg_location) -> (list, str|None)
    - build_youtube_download_command(youtube_url, format_id, download_dir, spotify_metadata, ...) -> list
"""

import json
import re
import subprocess
import sys

from progress_parser import FILEPATH_MARKER

# YouTube format IDs for audio-only streams (Opus and AAC variants)
# Ordered by quality (highest first)
_YT_AUDIO_FORMATS = {
    "251": {"ext": "opus", "abr": 160, "acodec": "opus", "label": "160 kbps Opus"},
    "250": {"ext": "opus", "abr": 70, "acodec": "opus", "label": "70 kbps Opus"},
    "249": {"ext": "opus", "abr": 50, "acodec": "opus", "label": "50 kbps Opus"},
    "140": {"ext": "m4a", "abr": 128, "acodec": "mp4a.40.2", "label": "128 kbps M4A"},
    "256": {"ext": "m4a", "abr": 256, "acodec": "mp4a.40.2", "label": "256 kbps M4A (DASH)"},
    "258": {"ext": "m4a", "abr": 384, "acodec": "mp4a.40.2", "label": "384 kbps M4A (DASH)"},
    "139": {"ext": "m4a", "abr": 48, "acodec": "mp4a.40.5", "label": "48 kbps M4A"},
    "233": {"ext": "webm", "abr": 48, "acodec": "opus", "label": "48 kbps WebM"},
    "234": {"ext": "webm", "abr": 70, "acodec": "opus", "label": "70 kbps WebM"},
}


# ---------------------------------------------------------------------------
# Stage 2 — Search YouTube for the matching track
# ---------------------------------------------------------------------------


def search_youtube(artist, title, yt_dlp_command=None):
    """Search YouTube for the best matching audio track.

    Tries progressively broader search queries. Returns the first YouTube
    entry found (dict with ``url``, ``id``, ``title``, ``duration``) or None.
    """
    queries = [
        f'"{artist}" "{title}" audio',
        f'"{artist}" "{title}" official audio',
        f'"{artist}" "{title}" official video',
        f'"{artist}" "{title}" lyrics',
        f"{artist} {title} audio",
        f"{artist} {title}",
    ]

    for query in queries:
        entry = _single_yt_search(query, yt_dlp_command)
        if entry is not None and _entry_looks_like_match(entry, artist, title):
            return entry

    # Final loose pass — return first result if any
    for query in queries:
        entry = _single_yt_search(query, yt_dlp_command)
        if entry is not None:
            return entry
    return None


def _single_yt_search(query, yt_dlp_command=None):
    """Run a single yt-dlp ytsearch query and return the first result."""
    cmd = [
        *(yt_dlp_command or [sys.executable, "-m", "yt_dlp"]),
        "--ignore-config",
        "--dump-single-json",
        "--no-warnings",
        "--no-color",
        "--default-search",
        "ytsearch",
        f"ytsearch:{query}",
        "--skip-download",
        "--no-playlist",
        "--flat-playlist",
    ]
    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        entries = data.get("entries", [])
        if entries:
            return entries[0]
    except (json.JSONDecodeError, subprocess.TimeoutExpired, OSError):
        return None
    return None


def _entry_looks_like_match(entry, artist, title):
    """Heuristic: the entry title should mention both artist and title keywords."""
    entry_title = (entry.get("title") or "").lower()
    # Check that at least one keyword from artist and title appear
    artist_words = set(artist.lower().split())
    title_words = set(title.lower().split())
    entry_words = set(entry_title.split())
    # Count how many words match
    artist_hits = len(artist_words & entry_words)
    title_hits = len(title_words & entry_words)
    # Must match at least 1 word from artist AND 1 from title,
    # or 3+ words total
    return (artist_hits >= 1 and title_hits >= 1) or (artist_hits + title_hits) >= 3


# ---------------------------------------------------------------------------
# Stage 3 — Get audio-only formats from the matched YouTube video
# ---------------------------------------------------------------------------


def get_youtube_audio_formats(youtube_url, yt_dlp_command=None, ffmpeg_location=None):
    """Return a list of audio-only format dicts from a YouTube URL.

    Also returns the YouTube video title for display purposes.
    """
    cmd = [
        *(yt_dlp_command or [sys.executable, "-m", "yt_dlp"]),
        "--ignore-config",
        "--dump-single-json",
        "--no-warnings",
        "--no-color",
        "--skip-download",
        youtube_url,
    ]
    if ffmpeg_location:
        cmd.extend(["--ffmpeg-location", str(ffmpeg_location)])

    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if result.returncode != 0:
            return None, None
        video_info = json.loads(result.stdout)
    except (json.JSONDecodeError, subprocess.TimeoutExpired, OSError):
        return None, None

    formats = []
    for f in video_info.get("formats", []):
        vcodec = (f.get("vcodec") or "none").lower()
        acodec = (f.get("acodec") or "none").lower()
        if vcodec == "none" and acodec != "none":
            size = f.get("filesize") or f.get("filesize_approx") or 0
            formats.append(
                {
                    "format_id": f["format_id"],
                    "ext": f.get("ext", "m4a"),
                    "abr": float(f.get("abr") or f.get("tbr") or 0),
                    "asr": f.get("asr") or 0,
                    "acodec": acodec,
                    "filesize": int(size) if size else 0,
                }
            )

    return formats, video_info.get("title", "")


# ---------------------------------------------------------------------------
# Stage 4 — Build download command
# ---------------------------------------------------------------------------


def build_youtube_download_command(
    youtube_url,
    format_id,
    download_dir,
    spotify_metadata,
    yt_dlp_command=None,
    ffmpeg_location=None,
    aria2c_location=None,
):
    """Build a yt-dlp command that downloads audio from YouTube with Spotify metadata.

    The output filename uses the Spotify artist/title, and the file is tagged
    with embedded metadata (thumbnail, title, artist, album, etc.).
    """
    artist_str = spotify_metadata.get("artist", "Unknown Artist")
    title_str = spotify_metadata.get("title", "Unknown Track")
    safe_name = _sanitize_path(f"{artist_str} - {title_str}")
    output_template = f"{safe_name}/%(title).180B [%(id)s].%(ext)s"

    # Use the best audio available when "best" is selected
    audio_format_id = str(format_id or "best")
    if audio_format_id == "best":
        audio_format_id = "bestaudio/best"

    command = [
        *(yt_dlp_command or [sys.executable, "-m", "yt_dlp"]),
        "--ignore-config",
        "--newline",
        "--no-color",
        "--progress",
        "--windows-filenames",
        "--restrict-filenames",
        "--trim-filenames",
        "180",
        "--paths",
        f"home:{download_dir}",
        "--no-playlist",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "--add-metadata",
        "-f",
        audio_format_id,
        # The only way this download reports where it landed. `download_task.py` fills
        # `final_path` solely from this marker, and an empty `final_path` is what hides
        # the popup's Open / Folder buttons (`download_actions` gates both on
        # `job.filepath`) - so without it a music job is a file nobody can open. The
        # template above is dynamic, so the path cannot be precomputed and seeded the
        # way the stream backends do it.
        "--print",
        f"after_move:{FILEPATH_MARKER}%(filepath)s",
        "-o",
        output_template,
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])

    if aria2c_location:
        command.extend(["--downloader", str(aria2c_location)])

    command.append(youtube_url)
    return command


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sanitize_path(name):
    """Remove characters that are invalid in Windows filenames."""
    return re.sub(r'[<>:"/\\|?*]', "_", name)
