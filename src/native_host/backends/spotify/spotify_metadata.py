"""Spotify URL parsing and embed-page metadata extraction.

Public API:
    - is_spotify_url(url) -> bool
    - parse_spotify_url(url) -> (content_type|None, track_id|None)
    - fetch_spotify_track_metadata(track_id) -> dict
"""

import json
import re
import urllib.error
import urllib.request

from native_protocol import HostError

_SPOTIFY_URL_RE = re.compile(r"https?://open\.spotify\.com/(track|album|playlist|episode|show)/([a-zA-Z0-9]+)")

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


PLAYLIST_ITEM_LIMIT = 100


def _normalize_collection_track(entry, index):
    artists = [a.get("name", "") for a in entry.get("artists", []) if isinstance(a, dict)]
    artist = ", ".join(a for a in artists if a) or "Unknown Artist"
    title = entry.get("name") or entry.get("title") or f"Track {index + 1}"
    track_id = entry.get("id") or ""
    url = f"https://open.spotify.com/track/{track_id}" if track_id else ""
    return {"artist": artist, "title": title, "spotifyUrl": url, "url": url}


def _extract_track_list(entity):
    """Spotify's embed JSON shape drifts; try known nests, else scan one level."""
    tracks = entity.get("tracks") or {}
    if isinstance(tracks, dict) and isinstance(tracks.get("items"), list):
        return tracks["items"], entity.get("name") or entity.get("title") or "Spotify playlist"
    if isinstance(tracks, list):
        return tracks, entity.get("name") or entity.get("title") or "Spotify playlist"
    for value in entity.values():
        if isinstance(value, dict) and isinstance(value.get("items"), list):
            return value["items"], entity.get("name") or entity.get("title") or "Spotify playlist"
    raise HostError("Could not find a track list on this Spotify page. Spotify may have changed their page layout.")


def fetch_spotify_collection_tracks(collection_id, kind):
    """Fetch (title, tracks) for a playlist/album embed page. Tracks capped at PLAYLIST_ITEM_LIMIT."""
    embed_url = f"https://open.spotify.com/embed/{kind}/{collection_id}"
    req = urllib.request.Request(embed_url, headers={"User-Agent": _YOUR_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        raise HostError(f"Could not reach Spotify embed page: {exc}")
    match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not match:
        raise HostError("Could not extract playlist info from this Spotify page. Spotify may have changed its layout.")
    try:
        data = json.loads(match.group(1))
        entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, json.JSONDecodeError) as exc:
        raise HostError(f"Failed to parse Spotify metadata: {exc}")
    raw_items, title = _extract_track_list(entity)
    usable = raw_items[:PLAYLIST_ITEM_LIMIT]
    tracks = [_normalize_collection_track(e, i) for i, e in enumerate(usable) if isinstance(e, dict)]
    if not tracks:
        raise HostError("This Spotify playlist has no playable tracks.")
    return title, tracks
