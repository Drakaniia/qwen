"""Spotify download resolver for Qwin.

When yt-dlp fails to extract a Spotify URL (DRM block), this module provides a
multi-stage fallback chain built from sub-modules:

  1. :mod:`spotify_metadata` — URL parsing and embed-page metadata fetch
  2. :mod:`spotify_youtube` — YouTube search, format listing, command building
  3. This module — orchestrator that ties the stages together

No Spotify API credentials are required.
"""

from spotify_metadata import fetch_spotify_track_metadata, parse_spotify_url
from spotify_youtube import (
    get_youtube_audio_formats,
    search_youtube,
)

from native_protocol import HostError

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


def resolve_spotify_playlist(url):
    """Playlist/album URL → the popup's expand-to-rows dict.

    ``{playlistTitle, items, totalItems, truncated, playlistThumbnailUrl}``.
    """
    from spotify_metadata import fetch_spotify_collection_tracks

    content_type, collection_id = parse_spotify_url(url)
    if content_type == "track":
        raise HostError("__QWIN_SINGLE_TRACK__ Use the formats flow for individual tracks.")
    if content_type not in ("playlist", "album"):
        raise HostError(
            f"Qwin can only resolve Spotify tracks, playlists and albums. {content_type}s are not yet supported."
        )
    # No `yt_dlp_command` / `ffmpeg_location` parameters: this branch never builds a
    # command, so accepting them said the function could when it cannot. The per-track
    # YouTube search runs later, inside the download, not here.
    collection = fetch_spotify_collection_tracks(collection_id, content_type)
    return {
        "playlistTitle": collection["title"],
        "items": collection["tracks"],
        # The REAL total, not the capped length — the popup prints "the first 100 of 300".
        "totalItems": collection["totalItems"],
        "truncated": collection["truncated"],
        # The collection's own cover, which the popup renders as the playlist folder's
        # image — the rows carry their own art, the folder carries this one.
        "playlistThumbnailUrl": collection.get("thumbnail", ""),
    }
