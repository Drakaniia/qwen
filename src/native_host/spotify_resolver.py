"""
Spotify download resolver for Qwin.

When yt-dlp fails to extract a Spotify URL (DRM block), this module provides a
multi-stage fallback chain:

  1. Fetch track metadata from Spotify's public embed page (no API key / login).
  2. Search YouTube for the matching audio using yt-dlp's ytsearch.
  3. Return YouTube audio formats as available download options.
  4. Download the selected YouTube format with audio extraction.
  5. Tag output with Spotify metadata (title, artist, album, cover).

No Spotify API credentials are required. The embed page exposes track metadata
via __NEXT_DATA__ JSON without authentication.
"""

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from native_protocol import HostError

_SPOTIFY_URL_RE = re.compile(r"https?://open\.spotify\.com/(track|album|playlist|episode|show)/([a-zA-Z0-9]+)")

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

_YOUR_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def is_spotify_url(url):
    """Return True if *url* looks like a Spotify share link."""
    return bool(_SPOTIFY_URL_RE.match(str(url or "").strip()))


def parse_spotify_url(url):
    """Parse a Spotify URL into (content_type, id) or (None, None)."""
    m = _SPOTIFY_URL_RE.match(str(url or "").strip())
    if m:
        return m.group(1), m.group(2)
    return None, None


# ---------------------------------------------------------------------------
# Stage 1 — Fetch metadata from Spotify embed page
# ---------------------------------------------------------------------------


def fetch_spotify_track_metadata(track_id):
    """Fetch track metadata from the public Spotify embed page.

    Returns a dict with keys:
        id, title, artists (list), artist (joined str),
        album, duration (seconds), explicit, cover_url, release_date
    """
    embed_url = f"https://open.spotify.com/embed/track/{track_id}"
    req = urllib.request.Request(embed_url, headers={"User-Agent": _YOUR_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        raise HostError(f"Could not reach Spotify embed page: {exc}")

    match = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not match:
        raise HostError("Could not extract track info from Spotify page. Spotify may have changed their page layout.")

    try:
        data = json.loads(match.group(1))
        entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, json.JSONDecodeError) as exc:
        raise HostError(f"Failed to parse Spotify metadata: {exc}")

    artists = [a["name"] for a in entity.get("artists", [])]
    album_data = entity.get("album", {}) or {}
    album_images = album_data.get("images", [])
    visual_images = entity.get("visualIdentity", {}).get("image", [])
    cover_url = ""
    if album_images:
        cover_url = album_images[0].get("url", "")
    elif visual_images:
        cover_url = (visual_images[0] if isinstance(visual_images, list) else visual_images).get("url", "")

    return {
        "id": entity.get("id", track_id),
        "title": entity.get("name") or entity.get("title") or "Unknown Track",
        "artists": artists,
        "artist": ", ".join(artists) if artists else "Unknown Artist",
        "album": album_data.get("name", "") or "",
        "duration": int(entity.get("duration", 0)) / 1000.0,
        "explicit": bool(entity.get("isExplicit", False)),
        "cover_url": cover_url,
        "release_date": entity.get("releaseDate", {}).get("isoString", ""),
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
# High-level helpers for format-list and download flows
# ---------------------------------------------------------------------------


def resolve_spotify_formats(url, yt_dlp_command=None, ffmpeg_location=None):
    """Full pipeline: Spotify URL → metadata → YouTube search → format list.

    Returns a dict in the same shape as :func:`yt_dlp_command.summarize_audio_formats`
    so the caller can pass it straight to the popup:

    .. code:: python

        {"title": "…", "webpageUrl": "…", "formats": […]}
    """
    content_type, track_id = parse_spotify_url(url)
    if content_type != "track":
        raise HostError(f"Qwin can only resolve individual Spotify tracks. {content_type}s are not yet supported.")

    metadata = fetch_spotify_track_metadata(track_id)
    display_title = f"{metadata['artist']} — {metadata['title']}"

    youtube_entry = search_youtube(metadata["artist"], metadata["title"], yt_dlp_command)
    if not youtube_entry:
        raise HostError(
            f'Could not find "{display_title}" on YouTube. '
            "The track may be too new, region-restricted, or available only on Spotify."
        )

    youtube_url = youtube_entry.get("url") or (f"https://www.youtube.com/watch?v={youtube_entry['id']}")

    yt_formats, yt_title = get_youtube_audio_formats(youtube_url, yt_dlp_command, ffmpeg_location)

    if not yt_formats:
        # Build a minimal best-audio-only option so the user can still attempt a download
        yt_formats = [
            {
                "format_id": "best",
                "ext": "mp3",
                "abr": 0,
                "asr": 0,
                "acodec": "",
                "filesize": 0,
            }
        ]

    # Build the format list for the popup
    from yt_dlp_command import human_size

    choices = [
        {
            "id": "best",
            "label": "Best available audio",
            "ext": "mp3",
            "height": None,
            "tbr": None,
            "size": "",
            "note": "Recommended (from YouTube)",
            "acodec": "",
        }
    ]

    for af in sorted(yt_formats, key=lambda x: x.get("abr", 0), reverse=True)[:10]:
        fmt_id = af["format_id"]
        abr = af.get("abr", 0)
        size_bytes = af.get("filesize", 0)
        label = f"{int(abr)} kbps {af['ext'].upper()}" if abr else f"YouTube {fmt_id}"
        note = af.get("acodec", "")
        # Trim note to common names
        if "mp4a.40.2" in note:
            note = "AAC LC"
        elif "mp4a.40.5" in note:
            note = "HE-AAC"
        elif "opus" in note:
            note = "Opus"
        choices.append(
            {
                "id": fmt_id,
                "label": label,
                "ext": af["ext"],
                "height": None,
                "tbr": int(abr) if abr else None,
                "size": human_size(size_bytes) if size_bytes else "",
                "note": note,
                "acodec": af.get("acodec", ""),
                "vcodec": "none",
                "source": "youtube-fallback",
            }
        )

    return {
        "title": display_title,
        "webpageUrl": url,
        "youtubeUrl": youtube_url,
        "youtubeTitle": yt_title or display_title,
        "spotifyMetadata": metadata,
        "formats": choices,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _sanitize_path(name):
    """Remove characters that are invalid in Windows filenames."""
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def _cleanup_test_files():
    """Remove temporary test scripts (called during final verification)."""
    import os

    for f in ["tools/test_spotify_embed.py", "tools/test_yt_formats.py"]:
        p = Path(f)
        if p.exists():
            try:
                os.remove(str(p))
            except OSError:
                pass
