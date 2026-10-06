"""Spotify URL parsing and embed-page metadata extraction.

Public API:
    - is_spotify_url(url) -> bool
    - parse_spotify_url(url) -> (content_type|None, track_id|None)
    - fetch_spotify_track_metadata(track_id) -> dict
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

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
    # A missing key raises `KeyError` above, but a present-and-wrong-typed `entity`
    # (a list, a string) reaches the `.get` calls below and dies as an `AttributeError`,
    # which reaches the user as "Unexpected helper error".
    if not isinstance(entity, dict):
        raise HostError("Failed to parse Spotify metadata: the page did not describe a track.")

    # `or []` / `or {}` throughout: Spotify sends these keys as null as often as it omits
    # them, and `get(key, default)` only substitutes the default for a MISSING key.
    artists = [a["name"] for a in entity.get("artists") or []]
    album_data = entity.get("album") or {}
    artwork = _artwork_urls(entity)

    return {
        "id": entity.get("id", track_id),
        "title": entity.get("name") or entity.get("title") or "Unknown Track",
        "artists": artists,
        "artist": ", ".join(artists) if artists else "Unknown Artist",
        "album": album_data.get("name", "") or "",
        "duration": int(entity.get("duration", 0)) / 1000.0,
        "explicit": bool(entity.get("isExplicit", False)),
        "cover_url": artwork[0] if artwork else "",
        "release_date": entity.get("releaseDate", {}).get("isoString", ""),
    }


THUMBNAIL_CANDIDATE_LIMIT = 3


def _artwork_urls(entity):
    """Every usable cover-art URL on a Spotify entity, best first, capped.

    The shapes are the ones `fetch_spotify_track_metadata` already knew: a track carries
    `album.images`, while a collection embed page carries the same art under
    `visualIdentity.image`. One helper for both means a shape that drifts only has to be
    fixed once.

    `data:` is dropped on purpose. These URLs ride into the popup's ladder, into every job
    record and into synced history, where a base64 JPEG per row would blow the ~100KB
    budget — see the note in `background/download/native.ts`.
    """
    images = list((entity.get("album") or {}).get("images") or [])
    visual = (entity.get("visualIdentity") or {}).get("image") or []
    images += visual if isinstance(visual, list) else [visual]

    urls = []
    for image in images:
        if not isinstance(image, dict):
            continue
        url = str(image.get("url") or "")
        if (url.startswith("http://") or url.startswith("https://")) and url not in urls:
            urls.append(url)
        if len(urls) >= THUMBNAIL_CANDIDATE_LIMIT:
            break
    return urls


PLAYLIST_ITEM_LIMIT = 100


def _normalize_collection_track(entry, index, artwork):
    artists = [a.get("name", "") for a in entry.get("artists") or [] if isinstance(a, dict)]
    artist = ", ".join(a for a in artists if a) or entry.get("subtitle") or "Unknown Artist"
    title = entry.get("name") or entry.get("title") or f"Track {index + 1}"
    track_id = entry.get("id") or ""
    if not track_id:
        uri_match = re.match(r"spotify:track:([A-Za-z0-9]+)", str(entry.get("uri") or ""))
        if uri_match:
            track_id = uri_match.group(1)
    url = f"https://open.spotify.com/track/{track_id}" if track_id else ""
    track = {"artist": artist, "title": title, "spotifyUrl": url, "url": url}
    # A collection embed page has ONE image, so every track in it shares the same art.
    # Camel-cased to the UI's own field names (`shared/contracts.ts`), NOT to this module's
    # `cover_url`: `playlist_helpers.enumeratePlaylistVideos` reads these two off the wire
    # reply and hands them to the detector, so a snake_case key here would be dropped again.
    if artwork:
        track["thumbnailUrl"] = artwork[0]
        track["thumbnailCandidates"] = list(artwork)
    return track


def fetch_track_cover(track_id, timeout=8):
    """One track's own album art, or "" — Spotify's oEmbed endpoint.

    The collection embed page carries ONE image for the whole playlist, so every track
    extracted from it shares that art. This is the only per-track source available without
    credentials, and it is a small JSON GET.
    """
    target = urllib.parse.quote(f"https://open.spotify.com/track/{track_id}", safe="")
    req = urllib.request.Request(
        f"https://open.spotify.com/oembed?url={target}",
        headers={"User-Agent": _YOUR_USER_AGENT},
    )
    # Never raise. A failed lookup must degrade to the collection art already on the track,
    # not fail the enumeration the user is waiting on. `json.JSONDecodeError` is a
    # `ValueError`, so the decode is covered by the same arm.
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError):
        return ""
    cover = payload.get("thumbnail_url") if isinstance(payload, dict) else ""
    # These keys ride into the popup, every job record and synced history, where a base64
    # JPEG per row would blow the ~100KB budget — same rule as `_artwork_urls`.
    if isinstance(cover, str) and cover.startswith(("http://", "https://")):
        return cover
    return ""


def _track_id_of(track):
    """A track's Spotify id, or "" — `_normalize_collection_track`'s URL is where it survives.

    It is never stored as a plain `id`, so the id has to be sliced back off the URL rather
    than re-requested from the page.
    """
    explicit = str(track.get("id") or "")
    if explicit:
        return explicit
    for key in ("url", "spotifyUrl"):
        match = re.search(r"open\.spotify\.com/track/([A-Za-z0-9]+)", str(track.get(key) or ""))
        if match:
            return match.group(1)
    return ""


def apply_track_covers(tracks, fetch=fetch_track_cover, workers=8):
    """Give each track its own cover where obtainable, leaving the shared fallback otherwise.

    Mutates in place and returns nothing. A track the fetcher cannot answer for is left
    exactly as `_normalize_collection_track` made it — the collection art is a better answer
    than none, so this only ever upgrades a row, never blanks one.
    """
    jobs = [(t, _track_id_of(t)) for t in tracks]
    jobs = [(track, track_id) for track, track_id in jobs if track_id]
    if not jobs:
        return

    def run(job):
        track, track_id = job
        cover = fetch(track_id) or ""
        if cover:
            # Same two camelCase keys, same reason (see `_normalize_collection_track`).
            track["thumbnailUrl"] = cover
            track["thumbnailCandidates"] = [cover]

    # ponytail: 8 workers, no retry, no memo — add caching if the same playlist gets pasted
    # repeatedly, or drop the pool for a serial loop under load.
    if len(jobs) < 10:
        for job in jobs:
            run(job)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(run, jobs))


def _extract_track_list(entity):
    """Spotify's embed JSON shape drifts; try known nests, else scan one level."""
    # Current shape (2026-10): `entity.trackList` is a plain list of
    # `{uri: "spotify:track:<id>", title, subtitle}` — no `tracks` key at all.
    track_list = entity.get("trackList")
    if isinstance(track_list, list):
        return track_list, entity.get("name") or entity.get("title") or "Spotify playlist"
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
    """Fetch one collection's first PLAYLIST_ITEM_LIMIT tracks.

    Returns ``{title, tracks, totalItems, truncated, thumbnail}``. ``totalItems`` and ``truncated``
    describe the WHOLE collection, not the capped list, so the popup can say "the first
    100 of 300" (spec §4) — which is only knowable while ``raw_items`` is still in scope.
    """
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
    # Same reasoning as the single-track fetch: a present-but-wrong-typed entity would
    # otherwise die as an `AttributeError` inside `_extract_track_list`.
    if not isinstance(entity, dict):
        raise HostError("Failed to parse Spotify metadata: the page did not describe a collection.")
    raw_items, title = _extract_track_list(entity)
    usable = raw_items[:PLAYLIST_ITEM_LIMIT]
    artwork = _artwork_urls(entity)
    tracks = [_normalize_collection_track(e, i, artwork) for i, e in enumerate(usable) if isinstance(e, dict)]
    if not tracks:
        raise HostError("This Spotify playlist has no playable tracks.")
    # Last, so it overwrites only the shared fallback art — the popup's rows want each
    # track's own cover, and the playlist's is one click away on the folder itself.
    apply_track_covers(tracks)
    return {
        "title": title,
        "tracks": tracks,
        "totalItems": len(raw_items),
        # The collection's OWN art, unlike the per-row keys: the popup draws it on the
        # playlist folder, so it must stay the playlist's even after every row is upgraded.
        "thumbnail": artwork[0] if artwork else "",
        # Strictly `>`: a playlist of exactly PLAYLIST_ITEM_LIMIT tracks is not truncated,
        # and recomputing this from the capped list below would report it as such.
        "truncated": len(raw_items) > PLAYLIST_ITEM_LIMIT,
    }
