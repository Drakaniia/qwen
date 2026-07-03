"""Download orchestration — probes backends, dispatches download jobs.

This module serves as the main entry point for yt-dlp / streaming / direct
download orchestration.  The aria2c command builders, BitTorrent/magnet
download functions, and Spotify fallback pipeline have been extracted into
sibling modules and are re-exported here for backward compatibility.
"""

import threading

# ── Re-exports from sub-modules (backward compatibility) ─────────────────
from aria2c_commands import (
    MAGNET_ARIA2_ARGS,
    build_aria2c_magnet_command,
    build_aria2c_torrent_command,
)
from bittorrent_downloads import (  # noqa: F401 — re-exports, consumed via _download_manager.X in host.py
    ACTIVE_DOWNLOADS,
    ACTIVE_DOWNLOADS_LOCK,
    _active_downloads_lock,
    cancel_active_downloads,
    control_download,
    run_gopeed_magnet_download,
    run_gopeed_torrent_download,
    run_magnet_download,
    run_torrent_download,
)
from download_logger import get_logger
from spotify_fallback import run_spotify_fallback_download

import curl_cffi_adapter as _curl_cffi_adapter
from browser_context import write_cookie_file_from_headers, write_cookie_file_from_string
from download_task import DownloadTask
from native_paths import resolve_download_dir, validate_download_url
from native_protocol import send_native_message
from probe_runner import (
    ProbeConfig,
    probe_curl_cffi,
    probe_n_m3u8dl_re,
    probe_streamlink,
    probe_yt_dlp,
    run_parallel_probes,
)
from stream_backends import (
    build_ffmpeg_direct_command,
    build_n_m3u8dl_re_command,
    build_streamlink_command,
    is_stream_manifest_url,
    stream_output_path,
)
from yt_dlp_command import build_yt_dlp_command, build_yt_dlp_fallback_variants, is_youtube_url
from yt_dlp_dependencies import (
    require_aria2c_location,
    resolve_ffmpeg_location,
    resolve_n_m3u8dl_re_location,
    resolve_streamlink_command,
    resolve_yt_dlp_command,
)

# ── Cookie injection helper ──────────────────────────────────────────────


def _inject_cookie_header(request_headers, cookie_header):
    """Merge a raw cookie header string into the request headers dict.

    Returns a new headers dict with the Cookie header added (or updated)
    alongside existing headers. Used to inject browser session cookies
    into curl_cffi probes and other non-yt-dlp backends.
    """
    if not cookie_header:
        return request_headers
    headers = dict(request_headers or {})
    # Only inject if there isn't already a Cookie header
    if not any(k.lower() == "cookie" for k in headers):
        headers["Cookie"] = cookie_header
    return headers


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
):
    """Build the list of probe configs for parallel reachability checks.

    Returns a list of ProbeConfig objects for all applicable backends.
    The selection matches the spec in parallel-reachability-spec.md:

    - yt-dlp: Always included (primary extractor)
    - curl_cffi: Only for direct media URLs (not stream manifests, not YouTube)
    - N_m3u8DL-RE: Only for stream manifest URLs
    - Streamlink: Only for stream manifest URLs
    """
    probes = []
    requested_backend = str(message.get("backend") or "auto").lower()
    # Extract browser version for version-specific impersonation
    chrome_version = str(message.get("browserVersion") or "").strip()[:10] or None

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
            ),
        )
    )

    # 2. curl_cffi — only for direct media URLs
    if not is_stream_manifest_url(url, message.get("format")) and not is_youtube_url(url):
        # Determine the impersonation string based on browser version
        impersonate_str = f"chrome{chrome_version}" if chrome_version else "chrome"
        # Chrome versions for TLS fingerprint rotation on 403/block
        chrome_versions = ["131", "127", "124", "120"]
        probes.append(
            ProbeConfig(
                backend="curl_cffi",
                label="curl-cffi (HEAD)",
                probe_fn=lambda u, ce, cv=chrome_version, cvs=chrome_versions: probe_curl_cffi(
                    url=u,
                    cancel_event=ce,
                    headers=request_headers,
                    chrome_version=cv,
                    chrome_versions=cvs,
                ),
                command=_curl_cffi_adapter.download_curl_cffi_command(
                    url=url,
                    output_path=stream_output_path(download_dir, message.get("title") or "Video"),
                    headers=request_headers,
                    impersonate=impersonate_str,
                ),
            )
        )

    # 3. N_m3u8DL-RE — for stream manifest URLs
    # NOTE: Promoted to Tier 1 parallel probe per ssr-video-detection spec.
    # N_m3u8DL-RE is purpose-built for HLS/DASH streams with 32-thread
    # parallel downloads, AES-128 decryption, and live recording support.
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

    # 4. Streamlink — for stream manifest URLs
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

    # ── Magnet / torrent URL exclusion ───────────────────────────────────
    # Magnet and torrent URLs bypass the probe phase entirely and go
    # directly to gopeed / aria2c for BitTorrent downloading.
    is_magnet = url.startswith("magnet:")
    is_torrent = url.lower().endswith(".torrent")
    if is_magnet or is_torrent:
        from download_task import DownloadTask
        if is_magnet:
            run_gopeed_magnet_download(message=message, task_class=(task_class or DownloadTask))
        else:
            run_gopeed_torrent_download(message=message, task_class=(task_class or DownloadTask))
        return

    yt_dlp_command = yt_dlp_command_resolver()
    ffmpeg_location = ffmpeg_location_resolver()
    aria2c_location = aria2c_location_resolver()
    n_m3u8dl_re_location = n_m3u8dl_re_location_resolver()
    streamlink_command = streamlink_command_resolver()

    download_dir = resolve_download_dir(message.get("downloadFolder"))
    request_headers = message.get("requestHeaders")

    # Track all temp files for cleanup, including both request-header-derived
    # and session cookies files if both are created.
    temp_files = []

    cookies_file = write_cookie_file_from_headers(url, request_headers)
    if cookies_file:
        temp_files.append(cookies_file)

    # Also extract cookie header from browser session (if provided).
    # Session cookies from the browser are more comprehensive than
    # request-header-derived cookies, so prefer them for yt-dlp.
    cookie_header = message.get("cookieHeader") or ""
    if cookie_header:
        session_cookies_file = write_cookie_file_from_string(cookie_header, url)
        if session_cookies_file:
            temp_files.append(session_cookies_file)
            cookies_file = session_cookies_file

    # Add session cookie header to request headers for curl_cffi probes
    request_headers_with_cookies = _inject_cookie_header(request_headers, cookie_header)
    extract_audio = bool(message.get("musicMode") or message.get("extractAudio") or False)
    audio_format = str(message.get("audioFormat") or "mp3").strip().lower() if extract_audio else None
    download_subtitles = bool(message.get("downloadSubtitles", True))

    # Extract browser version for version-specific impersonation (used in fallback chain)
    chrome_version = str(message.get("browserVersion") or "").strip()[:10] or None

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
            request_headers=request_headers_with_cookies,
            cookies_file=cookies_file,
            yt_dlp_command=yt_dlp_command,
            ffmpeg_location=ffmpeg_location,
            selected_format=message.get("formatId"),
            extract_audio=extract_audio,
            audio_format=audio_format,
            download_subtitles=download_subtitles,
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
        request_headers=request_headers_with_cookies,
        cookies_file=cookies_file,
        yt_dlp_command=yt_dlp_command,
        ffmpeg_location=ffmpeg_location,
        aria2c_location=aria2c_location,
        n_m3u8dl_re_location=n_m3u8dl_re_location,
        streamlink_command=streamlink_command,
        extract_audio=extract_audio,
        audio_format=audio_format,
        download_subtitles=download_subtitles,
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

    # ---- Cloudflare block early abort (all probes returned 403 Cloudflare errors) ----
    # When EVERY probe reports cloudflare_block, there is no point trying the
    # sequential fallback chain — every backend will also get blocked by
    # Cloudflare and download challenge HTML pages, producing corrupted output.
    if probe_result.errors and all(
        err.error_type == "cloudflare_block" for err in probe_result.errors
    ):
        cf_probe_count = sum(1 for err in probe_result.errors if err.error_type == "cloudflare_block")
        from native_protocol import HostError
        raise HostError(
            f"All {cf_probe_count} probe{'s' if cf_probe_count != 1 else ''} "
            f"detected Cloudflare anti-bot protection blocking access to this URL. "
            f"The download has been aborted to avoid downloading a corrupted file."
        )

    # ---- Sequential fallback chain (Tier 2) --------------------------------------
    command = build_yt_dlp_command(**build_command_kwargs({"aria2c_location": aria2c_location}))
    # aria2c is required — no fallback without it
    fallback_command = None

    fallback_commands = []
    requested_backend = str(message.get("backend") or "auto").lower()

    # 1. N_m3u8DL-RE for HLS/DASH manifest URLs — promoted to PRIMARY
    #    for stream manifests per the SSR detection & N_m3u8DL-RE promotion spec.
    #    For pure stream manifest URLs, N_m3u8DL-RE is tried BEFORE yt-dlp
    #    because it handles multi-segment parallel downloads (32 threads),
    #    AES-128 decryption, key rotation, live recording, and MP4 muxing.
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

    # 2. curl-cffi direct download (with version-specific impersonation if available)
    if not is_stream_manifest_url(url, message.get("format")) and not is_youtube_url(url):
        impersonate_str = f"chrome{chrome_version}" if chrome_version else "chrome"
        fallback_commands.append(
            {
                "command": _curl_cffi_adapter.download_curl_cffi_command(
                    url=url,
                    output_path=stream_output_path(download_dir, message.get("title") or "Video"),
                    headers=request_headers_with_cookies,
                    impersonate=impersonate_str,
                ),
                "label": "curl-cffi (direct download)",
            }
        )

    # 3. yt-dlp strategy variants
    fallback_commands.extend(
        build_yt_dlp_fallback_variants(**build_command_kwargs({"aria2c_location": aria2c_location}))
    )

    # 4. Streamlink for live-stream / HLS manifest URLs
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

    # 5. ffmpeg direct stream copy
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

    # 6. you-get — video downloader for Asian media platforms
    if not is_stream_manifest_url(url, message.get("format")):
        from fallback_engines import has_you_get

        if has_you_get():
            fallback_commands.append(
                {
                    "command": ["you-get", "--output-dir", str(download_dir), str(url)],
                    "label": "you-get",
                }
            )

    # 7. lux — Go-based video downloader for Asian platforms
    if not is_stream_manifest_url(url, message.get("format")):
        from fallback_engines import has_lux

        if has_lux():
            fallback_commands.append(
                {
                    "command": ["lux", "-o", str(download_dir), str(url)],
                    "label": "lux",
                }
            )

    # 8. yt-dlp with native downloader (no aria2c)
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
