import json
import subprocess
import tempfile

from registry import register_handler
from spotify_metadata import is_spotify_url
from spotify_resolver import resolve_spotify_formats

from browser_context import remove_temp_files, write_cookie_file_from_headers
from native_paths import validate_download_url
from native_protocol import HostError, send_native_message
from process_control import creation_flags
from yt_dlp_command import (
    build_flat_playlist_command,
    build_formats_command,
    build_playlist_info_command,
    is_youtube_collection_url,
    summarize_audio_formats,
    summarize_formats,
)
from yt_dlp_dependencies import (
    resolve_ffmpeg_location,
    resolve_yt_dlp_command,
)


@register_handler("formats")
def run_format_list(
    message,
    send=send_native_message,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []

    # Use a temporary yt-dlp config file for headers to avoid Windows
    # command-line length limits (WinError 206).
    headers_config = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", suffix=".conf", delete=False, prefix="qwin-ytdlp-hdrs-"
    )
    headers_config_path = headers_config.name
    headers_config.close()  # close so yt-dlp can read it; we remove it in finally
    temp_files.append(headers_config_path)

    # No probe phase here: it duplicated the yt-dlp extraction that execute_yt_dlp()
    # does immediately below, and its only wire effect was progress messages tagged
    # with this request id, which native_requests.js resolves on as the response.
    yt_dlp_command = yt_dlp_command_resolver()
    ffmpeg_location = ffmpeg_location_resolver()

    def execute_yt_dlp(nocheckcertificate=False):
        command = build_formats_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            nocheckcertificate=nocheckcertificate,
            headers_config_path=headers_config_path,
        )
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            creationflags=creation_flags(),
        )

    try:
        completed = execute_yt_dlp(nocheckcertificate=False)
        if completed.returncode != 0:
            details = (completed.stderr or completed.stdout or "").strip()
            if "CERTIFICATE_VERIFY_FAILED" in details:
                completed = execute_yt_dlp(nocheckcertificate=True)
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while asking yt-dlp for available qualities.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc
    finally:
        remove_temp_files(temp_files)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()

        # -- Spotify DRM fallback --------------------------------------------------
        # yt-dlp hard-blocks Spotify with [DRM]. Use the Spotify resolver to fetch
        # metadata from Spotify's embed page, search YouTube, and return YouTube audio
        # formats instead.
        if is_spotify_url(url) and "DRM" in details:
            try:
                result = resolve_spotify_formats(
                    url,
                    yt_dlp_command=yt_dlp_command_resolver(),
                    ffmpeg_location=ffmpeg_location_resolver(),
                )
                send({"type": "formats", "id": request_id, **result})
                return
            except HostError:
                # Propagate the resolver's error message (e.g. "only tracks
                # supported") instead of the raw yt-dlp DRM error — it is more
                # actionable for the user.
                raise
        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    try:
        info = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise HostError("yt-dlp returned invalid format metadata.") from exc

    music_mode = bool(message.get("musicMode") or message.get("music_mode") or False)
    if music_mode:
        send({"type": "formats", "id": request_id, **summarize_audio_formats(info)})
    else:
        send({"type": "formats", "id": request_id, **summarize_formats(info)})


# The ladder is capped because every extra URL rides along on each row's synced history
# entry (see `background/download/native.ts` on the ~100KB budget).
MAX_PLAYLIST_THUMBNAILS = 3


def _entry_artwork(entry):
    """Thumbnail ladder for one playlist entry: `thumbnail` first, then `thumbnails`.

    https/http only. Never a `data:` URL — an ffmpeg frame grab arrives as
    `data:image/jpeg;base64,…` (hls-thumbnail-spec.md §5.2/§11) and one such blob per row
    destroys the synced-history budget on its own.
    """
    raw = entry.get("thumbnail")
    urls = [raw] if isinstance(raw, str) else []
    for thumb in entry.get("thumbnails") or []:
        if isinstance(thumb, dict) and thumb.get("url"):
            urls.append(str(thumb["url"]))

    ladder = []
    for url in urls:
        url = url.strip()
        if not url.lower().startswith(("https://", "http://")) or url in ladder:
            continue
        ladder.append(url)
        if len(ladder) == MAX_PLAYLIST_THUMBNAILS:
            break
    return ladder


# Short, because the probe is decoration: the enumeration it decorates has already
# succeeded by the time it runs, and a slow cover must never turn a working answer
# into a failure.
PLAYLIST_ARTWORK_TIMEOUT_SECONDS = 15


def _playlist_cover(command):
    """The playlist's own cover URL, or "" — best effort, never an error.

    `--flat-playlist` describes the ENTRIES of a playlist and carries no artwork for
    the collection itself, so the extension's folder has nothing to show without this
    probe. Every failure mode collapses to "": a non-zero exit, unparseable output, a
    timeout, a missing yt-dlp. The caller has a complete enumeration in hand at this
    point and one more subprocess is not worth turning into a user-visible error.

    ponytail: one extra yt-dlp subprocess on a user-visible path, spent purely on a
    folder cover. Delete `_playlist_cover` and the `build_playlist_info_command`
    partial if the spawn is ever felt — the folder header falls back to a music glyph
    and nothing else changes.
    """
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PLAYLIST_ARTWORK_TIMEOUT_SECONDS,
            creationflags=creation_flags(),
        )
    except (subprocess.SubprocessError, OSError, ValueError):
        return ""

    if completed.returncode != 0:
        return ""
    try:
        info = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(info, dict):
        return ""

    ladder = _entry_artwork(info)
    return ladder[0] if ladder else ""


@register_handler("enumeratePlaylist")
def run_playlist_enumeration(
    message,
    send=send_native_message,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
):
    """Enumerate items in a playlist via yt-dlp --flat-playlist --dump-json.

    Returns a JSON array of playlist items, each containing:
      - id (str): The video ID
      - url (str): The video URL
      - title (str): The video title
      - duration (int, optional): Duration in seconds (may not be available with flat-playlist)

    Sends a message with type ``playlistItems``.
    """
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    if is_spotify_url(url):
        from spotify_resolver import resolve_spotify_playlist

        result = resolve_spotify_playlist(url)
        # A Spotify playlist/album URL is always a real collection — there is no
        # single-video shape of one to be mistaken for, and a `/track/` URL never reaches
        # this line (the resolver raises the sentinel instead).
        send({"type": "playlistItems", "id": request_id, "ok": True, "isCollection": True, **result})
        return

    request_headers = message.get("requestHeaders")
    cookies_file = write_cookie_file_from_headers(url, request_headers)
    temp_files = [cookies_file] if cookies_file else []

    # Use a temporary yt-dlp config file for headers to avoid Windows
    # command-line length limits (WinError 206).
    headers_config = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", suffix=".conf", delete=False, prefix="qwin-ytdlp-hdrs-"
    )
    headers_config_path = headers_config.name
    headers_config.close()
    temp_files.append(headers_config_path)

    def execute_yt_dlp(nocheckcertificate=False):
        command = build_flat_playlist_command(
            url=url,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command_resolver(),
            ffmpeg_location=ffmpeg_location_resolver(),
            nocheckcertificate=nocheckcertificate,
            headers_config_path=headers_config_path,
        )
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=creation_flags(),
        )

    try:
        completed = execute_yt_dlp(nocheckcertificate=False)
        if completed.returncode != 0:
            details = (completed.stderr or completed.stdout or "").strip()
            if "CERTIFICATE_VERIFY_FAILED" in details:
                completed = execute_yt_dlp(nocheckcertificate=True)
        # Only once the enumeration has succeeded, and only while the cookie and header
        # temp files still exist — a probe that needs them cannot run after the `finally`
        # below has deleted them.
        playlist_thumbnail_url = ""
        if completed.returncode == 0:
            playlist_thumbnail_url = _playlist_cover(
                build_playlist_info_command(
                    url=url,
                    referer=message.get("pageUrl"),
                    user_agent=message.get("userAgent"),
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                    yt_dlp_command=yt_dlp_command_resolver(),
                    ffmpeg_location=ffmpeg_location_resolver(),
                    headers_config_path=headers_config_path,
                )
            )
    except subprocess.TimeoutExpired as exc:
        raise HostError("Timed out while enumerating playlist items.") from exc
    except OSError as exc:
        raise HostError(f"Could not start yt-dlp: {exc}") from exc
    finally:
        remove_temp_files(temp_files)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise HostError(details or f"yt-dlp exited with status {completed.returncode}.")

    # Parse each line as a JSON entry (--dump-json outputs one JSON line per item)
    items = []
    playlist_title = ""
    for line in completed.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Capture playlist-level info from the first entry
        if not playlist_title:
            playlist_title = entry.get("playlist_title") or entry.get("playlist") or ""

        # Each entry represents one item in the playlist
        item_id = str(entry.get("id") or "").strip()
        item_url = str(entry.get("url") or "").strip() or entry.get("webpage_url") or ""
        item_title = str(entry.get("title") or "").strip()
        item_duration = entry.get("duration") or 0

        if not item_id and not item_url:
            continue

        artwork = _entry_artwork(entry)

        items.append(
            {
                "id": item_id,
                "url": item_url,
                "title": item_title or f"Item {len(items) + 1}",
                "duration": int(item_duration) if item_duration else 0,
                # Artwork for the expanded rows. The head of the ladder is also the
                # canonical `thumbnailUrl`, so a consumer that reads one field still gets art.
                "thumbnailUrl": artwork[0] if artwork else "",
                "thumbnailCandidates": artwork,
            }
        )

    send(
        {
            "type": "playlistItems",
            "id": request_id,
            "ok": True,
            "items": items,
            "playlistTitle": playlist_title,
            # The collection's own cover, for the popup's folder header. Absent art stays
            # `""` so the extension's own glyph takes the slot — see `_playlist_cover`.
            "playlistThumbnailUrl": playlist_thumbnail_url,
            "totalItems": len(items),
            # Whether this was REALLY a collection. `--flat-playlist` answers an ordinary
            # video URL with exactly one entry, which the popup would otherwise read as a
            # one-item playlist — losing the quality sheet for every plain paste. yt-dlp
            # stamps `playlist_title` on a real playlist and leaves it empty for a single
            # video, so that plus the item count is the whole signal…
            # …except on YouTube Music, where a `playlist?list=` paste returns flat entries
            # with no `playlist_title` at all and a one-track playlist then reads as a single
            # video. There the URL shape is the stronger signal, so it promotes the answer:
            # `is_youtube_collection_url` excludes `/watch`, so a plain video paste still
            # falls through to the quality sheet.
            "isCollection": bool(playlist_title) or len(items) > 1 or is_youtube_collection_url(url),
        }
    )
