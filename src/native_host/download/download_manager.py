"""Download orchestration — probes backends, dispatches download jobs."""

import tempfile
import threading

from download_logger import get_logger
from probe_runner import (
    ProbeConfig,
    probe_n_m3u8dl_re,
    probe_streamlink,
    probe_yt_dlp,
    run_parallel_probes,
)
from registry import register_handler
from spotify_fallback import run_spotify_fallback_download

from browser_context import write_cookie_file_from_headers, write_cookie_file_from_string
from download_task import DownloadTask
from native_paths import resolve_download_dir, validate_download_url
from native_protocol import HostError, send_native_message
from stream_backends import (
    build_ffmpeg_direct_command,
    build_n_m3u8dl_re_command,
    build_streamlink_command,
    is_stream_manifest_url,
    stream_output_path,
)
from yt_dlp_command import build_yt_dlp_command, build_yt_dlp_fallback_variants
from yt_dlp_dependencies import (
    require_aria2c_location,
    resolve_ffmpeg_location,
    resolve_n_m3u8dl_re_location,
    resolve_streamlink_command,
    resolve_yt_dlp_command,
)

# ── Active downloads state ───────────────────────────────────────────────

ACTIVE_DOWNLOADS: dict = {}
ACTIVE_DOWNLOADS_LOCK = threading.Lock()


def _active_downloads_lock():
    return ACTIVE_DOWNLOADS_LOCK


# ── Probe config building ────────────────────────────────────────────────


def winner_output_path(backend, download_dir, message):
    """Where a probe winner will write, or `""` when it reports its own path.

    yt-dlp is the only backend that names its output on the wire — the
    `after_move:__QWIN_FILEPATH__` print in `yt_dlp_command.py`, which
    `parsers/ytdlp.py` turns into `final_path`. The stream backends all take
    `-o stream_output_path(...)` and emit nothing the progress parser recognises, so
    without this hint a stream download finishes with `filepath: ""`, and an empty
    filepath is exactly what hides the popup's Open / Folder buttons
    (`downloadActions` gates both on it).

    Same value the Tier-2 chain attaches as `final_path` / `artifact_root` per
    fallback attempt; the probe-winner branch used to drop it.
    """
    if backend == "yt-dlp":
        return ""
    return str(stream_output_path(download_dir, message.get("title") or "Video"))


def _build_probe_configs(
    url,
    message,
    download_dir,
    request_headers,
    cookies_file,
    yt_dlp_command,
    ffmpeg_location,
    aria2c_location,
    n_m3u8dl_re_location,
    streamlink_command,
    extract_audio=False,
    audio_format=None,
    download_subtitles=True,
    headers_config_path=None,
):
    """Build the list of probe configs for parallel reachability checks.

    List order is priority order — the probe runner takes the lowest-index probe
    that reported ok, so the stream backends lead and yt-dlp is the catch-all:

    - N_m3u8DL-RE: For stream manifest URLs, when the binary resolves
    - Streamlink: For stream manifest URLs, when the command resolves
    - yt-dlp: Always included (last resort extractor)

    Each ProbeConfig also carries the command line that backend would actually
    download with, and it is the SAME one run_download()'s Tier-2 fallback chain
    reuses — build it once here, then read it back off the config by backend id.
    """
    probes = []

    # Hoisted: both stream backends below key off the same manifest check and
    # write to the same output path.
    is_stream = is_stream_manifest_url(url, message.get("format"))
    final_path = stream_output_path(download_dir, message.get("title") or "Video")

    # 1. N_m3u8DL-RE — for stream manifest URLs
    if n_m3u8dl_re_location and is_stream:
        probes.append(
            ProbeConfig(
                backend="n_m3u8dl_re",
                label="N_m3u8DL-RE",
                probe_fn=lambda u, ce: probe_n_m3u8dl_re(
                    url=u,
                    cancel_event=ce,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                    request_headers=request_headers,
                ),
                command=build_n_m3u8dl_re_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                    ffmpeg_location=ffmpeg_location,
                ),
            )
        )

    # 2. Streamlink — for stream manifest URLs
    if streamlink_command and is_stream:
        probes.append(
            ProbeConfig(
                backend="streamlink",
                label="Streamlink",
                probe_fn=lambda u, ce: probe_streamlink(
                    url=u,
                    cancel_event=ce,
                    streamlink_command=streamlink_command,
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                ),
                command=build_streamlink_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                    streamlink_command=streamlink_command,
                    ffmpeg_location=ffmpeg_location,
                ),
            )
        )

    # 3. yt-dlp — always participates, as the catch-all
    probes.append(
        ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda u, ce: probe_yt_dlp(
                url=u,
                cancel_event=ce,
                yt_dlp_command=yt_dlp_command,
                ffmpeg_location=ffmpeg_location,
                request_headers=request_headers,
                cookies_file=cookies_file,
                referer=message.get("pageUrl"),
                user_agent=message.get("userAgent"),
            ),
            command=build_yt_dlp_command(
                url=url,
                download_dir=download_dir,
                referer=message.get("pageUrl"),
                user_agent=message.get("userAgent"),
                request_headers=request_headers,
                cookies_file=cookies_file,
                yt_dlp_command=yt_dlp_command,
                ffmpeg_location=ffmpeg_location,
                selected_format=message.get("formatId"),
                extract_audio=extract_audio,
                audio_format=audio_format,
                download_subtitles=download_subtitles,
                aria2c_location=aria2c_location,
                headers_config_path=headers_config_path,
            ),
        )
    )

    return probes


# ── Main download orchestration ──────────────────────────────────────────


@register_handler("download")
def run_download(
    message,
    task_class=DownloadTask,
    yt_dlp_command_resolver=resolve_yt_dlp_command,
    ffmpeg_location_resolver=resolve_ffmpeg_location,
    aria2c_location_resolver=require_aria2c_location,
    n_m3u8dl_re_location_resolver=resolve_n_m3u8dl_re_location,
    streamlink_command_resolver=resolve_streamlink_command,
    probe_runner_fn=run_parallel_probes,
):
    request_id = str(message.get("id") or message.get("requestId") or "")
    url = str(message.get("url") or "").strip()
    validate_download_url(url)

    yt_dlp_command = yt_dlp_command_resolver()
    ffmpeg_location = ffmpeg_location_resolver()
    aria2c_location = aria2c_location_resolver()
    n_m3u8dl_re_location = n_m3u8dl_re_location_resolver()
    streamlink_command = streamlink_command_resolver()

    download_dir = resolve_download_dir(message.get("downloadFolder"))
    request_headers = message.get("requestHeaders")

    temp_files = []

    cookies_file = write_cookie_file_from_headers(url, request_headers)
    if cookies_file:
        temp_files.append(cookies_file)

    # Also extract cookie header from browser session (if provided)
    cookie_header = message.get("cookieHeader") or ""
    if cookie_header:
        session_cookies_file = write_cookie_file_from_string(cookie_header, url)
        if session_cookies_file:
            temp_files.append(session_cookies_file)
            cookies_file = session_cookies_file

    extract_audio = bool(message.get("musicMode") or message.get("extractAudio") or False)
    audio_format = str(message.get("audioFormat") or "mp3").strip().lower() if extract_audio else None
    download_subtitles = bool(message.get("downloadSubtitles", True))

    # Create a temporary yt-dlp config file for browser headers to avoid
    # Windows command-line length limits (WinError 206).
    _hdrs_cfg = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", suffix=".conf", delete=False, prefix="qwin-ytdlp-hdrs-"
    )
    headers_config_path = _hdrs_cfg.name
    _hdrs_cfg.close()
    temp_files.append(headers_config_path)

    # ---- Spotify YouTube fallback ------------------------------------------------
    from spotify_metadata import is_spotify_url

    if is_spotify_url(url):
        run_spotify_fallback_download(
            message=message,
            url=url,
            download_dir=download_dir,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            aria2c_location=aria2c_location,
            request_headers=request_headers,
            cookies_file=cookies_file,
            temp_files=temp_files,
            task_class=task_class,
        )
        return

    def build_command_kwargs(extra=None):
        kwargs = dict(
            url=url,
            download_dir=download_dir,
            referer=message.get("pageUrl"),
            user_agent=message.get("userAgent"),
            request_headers=request_headers,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            selected_format=message.get("formatId"),
            extract_audio=extract_audio,
            audio_format=audio_format,
            download_subtitles=download_subtitles,
            headers_config_path=headers_config_path,
        )
        if extra:
            kwargs.update(extra)
        return kwargs

    # ---- Parallel probe phase (Tier 1) -------------------------------------------
    cancel_event = threading.Event()
    logger = get_logger()

    probe_configs = _build_probe_configs(
        url=url,
        message=message,
        download_dir=download_dir,
        request_headers=request_headers,
        cookies_file=cookies_file,
        yt_dlp_command=yt_dlp_command,
        ffmpeg_location=ffmpeg_location,
        aria2c_location=aria2c_location,
        n_m3u8dl_re_location=n_m3u8dl_re_location,
        streamlink_command=streamlink_command,
        extract_audio=extract_audio,
        audio_format=audio_format,
        download_subtitles=download_subtitles,
        headers_config_path=headers_config_path,
    )

    probe_result = probe_runner_fn(
        url=url,
        probes=probe_configs,
        cancel_event=cancel_event,
        send_message=lambda msg: send_native_message({**msg, "id": request_id}),
        logger=logger,
        download_id=request_id,
    )

    # ---- Sequential fallback chain (Tier 2) --------------------------------------
    # The probe phase already built every command line; read them back instead of
    # rebuilding, so probing and falling back can never disagree on the command.
    by_backend = {config.backend: config.command for config in probe_configs}
    is_stream = is_stream_manifest_url(url, message.get("format"))
    final_path = stream_output_path(download_dir, message.get("title") or "Video")

    # A probe proves the manifest is fetchable, not that its segments download
    # (N_m3u8DL-RE's is `--skip-download`: parse the playlist, stop). A hotlink-
    # protected CDN can still reject the segment request -- a Pornhub CDN answers
    # 471 -- so the winner is the *first* attempt and the rest of the chain stays
    # behind it. Returning early here with `fallback_commands=[]` made that a dead
    # end: one attempt, then the raw tool stdout surfaced as the error text.
    winner_backend = probe_result.winner
    command = probe_result.command or by_backend["yt-dlp"]
    primary_final_path = winner_output_path(winner_backend, download_dir, message) if winner_backend else ""

    fallback_commands = []

    # 1. N_m3u8DL-RE for HLS/DASH manifest URLs
    if "n_m3u8dl_re" in by_backend and winner_backend != "n_m3u8dl_re":
        fallback_commands.append(
            {
                "command": by_backend["n_m3u8dl_re"],
                "label": "N_m3u8DL-RE",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    # 2. yt-dlp strategy variants
    #    Marked `"variant"` so DownloadTask.next_attempt_index can skip the whole
    #    contiguous block on an error no variant can fix (an expired signed URL).
    fallback_commands.extend(
        {**variant, "variant": True}
        for variant in build_yt_dlp_fallback_variants(**build_command_kwargs({"aria2c_location": aria2c_location}))
    )

    # 3. Streamlink for live-stream / HLS manifest URLs
    if "streamlink" in by_backend and winner_backend != "streamlink":
        fallback_commands.append(
            {
                "command": by_backend["streamlink"],
                "label": "Streamlink",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    # 4. ffmpeg direct stream copy — the one stream command with no probe, so it is
    #    built here. No binary-resolution gate: it runs on any stream manifest.
    if is_stream:
        fallback_commands.append(
            {
                "command": build_ffmpeg_direct_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    ffmpeg_location=ffmpeg_location,
                ),
                "label": "ffmpeg (direct stream copy)",
                "final_path": str(final_path),
            }
        )

    # 5. yt-dlp with native downloader (no aria2c)
    fallback_commands.append(
        {
            "command": build_yt_dlp_command(**build_command_kwargs({"aria2c_location": None})),
            "label": "yt-dlp (native downloader)",
        }
    )

    task = task_class(
        message=message,
        command=command,
        fallback_commands=fallback_commands,
        download_dir=download_dir,
        temp_files=temp_files,
        final_path=primary_final_path,
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()


# One function, three message types: the action *is* the message type on the wire.
# Each stacked registration keeps its own bound `action`, so HANDLERS holds three
# distinct wrappers around this single implementation.
@register_handler("pause", action="pause")
@register_handler("resume", action="resume")
@register_handler("cancel", action="cancel")
def control_download(message, action, send=send_native_message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    with _active_downloads_lock():
        task = ACTIVE_DOWNLOADS.get(request_id)
    if task is None:
        raise HostError(f"No active download with id {request_id!r}.")
    return send(getattr(task, action)())
