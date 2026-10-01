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
from spotify_fallback import run_spotify_fallback_download

from browser_context import write_cookie_file_from_headers, write_cookie_file_from_string
from download_task import DownloadTask
from native_paths import resolve_download_dir, validate_download_url
from native_protocol import send_native_message
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
    temp_files=None,
):
    """Build the list of probe configs for parallel reachability checks.

    Returns a list of ProbeConfig objects for all applicable backends:

    - yt-dlp: Always included (primary extractor)
    - N_m3u8DL-RE: Only for stream manifest URLs
    - Streamlink: Only for stream manifest URLs
    """
    probes = []
    requested_backend = str(message.get("backend") or "auto").lower()

    # 1. yt-dlp — always participates
    probes.append(
        ProbeConfig(
            backend="yt-dlp",
            label="yt-dlp (skip-download)",
            probe_fn=lambda u, ce: probe_yt_dlp(
                url=u,
                cancel_event=ce,
                yt_dlp_command=yt_dlp_command,
                ffmpeg_location=ffmpeg_location,
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

    # 2. N_m3u8DL-RE — for stream manifest URLs
    if (
        requested_backend in {"auto", "n_m3u8dl-re", "n_m3u8dl_re", "n-m3u8dl-re"}
        and n_m3u8dl_re_location
        and is_stream_manifest_url(url, message.get("format"))
    ):
        probes.append(
            ProbeConfig(
                backend="n_m3u8dl_re",
                label="N_m3u8DL-RE",
                probe_fn=lambda u, ce: probe_n_m3u8dl_re(
                    url=u,
                    cancel_event=ce,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                ),
                command=build_n_m3u8dl_re_command(
                    url=url,
                    output_path=stream_output_path(download_dir, message.get("title") or "Video"),
                    request_headers=request_headers,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                    ffmpeg_location=ffmpeg_location,
                ),
            )
        )

    # 3. Streamlink — for stream manifest URLs
    if (
        requested_backend in {"auto", "streamlink"}
        and streamlink_command
        and is_stream_manifest_url(url, message.get("format"))
    ):
        probes.append(
            ProbeConfig(
                backend="streamlink",
                label="Streamlink",
                probe_fn=lambda u, ce: probe_streamlink(
                    url=u,
                    cancel_event=ce,
                    streamlink_command=streamlink_command,
                ),
                command=build_streamlink_command(
                    url=url,
                    output_path=stream_output_path(download_dir, message.get("title") or "Video"),
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                    streamlink_command=streamlink_command,
                    ffmpeg_location=ffmpeg_location,
                ),
            )
        )

    return probes


# ── Main download orchestration ──────────────────────────────────────────


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
        temp_files=temp_files,
    )

    probe_result = probe_runner_fn(
        url=url,
        probes=probe_configs,
        cancel_event=cancel_event,
        send_message=lambda msg: send_native_message({**msg, "id": request_id}),
        logger=logger,
    )

    # If a winner was found, use it directly with empty fallbacks
    if probe_result.winner is not None and probe_result.command is not None:
        task = task_class(
            message=message,
            command=probe_result.command,
            fallback_command=None,
            fallback_commands=[],
            download_dir=download_dir,
            temp_files=temp_files,
        )
        with _active_downloads_lock():
            ACTIVE_DOWNLOADS[request_id] = task
        task.start()
        return

    # ---- Sequential fallback chain (Tier 2) --------------------------------------
    command = build_yt_dlp_command(**build_command_kwargs({"aria2c_location": aria2c_location}))
    fallback_command = None

    fallback_commands = []
    requested_backend = str(message.get("backend") or "auto").lower()

    # 1. N_m3u8DL-RE for HLS/DASH manifest URLs
    if (
        requested_backend in {"auto", "n_m3u8dl-re", "n_m3u8dl_re", "n-m3u8dl-re"}
        and n_m3u8dl_re_location
        and is_stream_manifest_url(url, message.get("format"))
    ):
        final_path = stream_output_path(download_dir, message.get("title") or "Video")
        fallback_commands.append(
            {
                "command": build_n_m3u8dl_re_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    n_m3u8dl_re_location=n_m3u8dl_re_location,
                    ffmpeg_location=ffmpeg_location,
                ),
                "label": "N_m3u8DL-RE",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    # 2. yt-dlp strategy variants
    fallback_commands.extend(
        build_yt_dlp_fallback_variants(**build_command_kwargs({"aria2c_location": aria2c_location}))
    )

    # 3. Streamlink for live-stream / HLS manifest URLs
    if (
        requested_backend in {"auto", "streamlink"}
        and streamlink_command
        and is_stream_manifest_url(url, message.get("format"))
    ):
        final_path = stream_output_path(download_dir, message.get("title") or "Video")
        fallback_commands.append(
            {
                "command": build_streamlink_command(
                    url=url,
                    output_path=final_path,
                    request_headers=request_headers,
                    cookies_file=cookies_file,
                    streamlink_command=streamlink_command,
                    ffmpeg_location=ffmpeg_location,
                ),
                "label": "Streamlink",
                "final_path": str(final_path),
                "artifact_root": str(final_path.parent),
            }
        )

    # 4. ffmpeg direct stream copy
    if is_stream_manifest_url(url, message.get("format")):
        final_path = stream_output_path(download_dir, message.get("title") or "Video")
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
        fallback_command=fallback_command,
        fallback_commands=fallback_commands,
        download_dir=download_dir,
        temp_files=temp_files,
    )
    with _active_downloads_lock():
        ACTIVE_DOWNLOADS[request_id] = task
    task.start()
