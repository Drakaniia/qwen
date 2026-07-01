# src/native_host

Python 3.11+ native messaging host. Entry point is `host.py` which dispatches to specialized modules. Communicates with the extension via stdin/stdout using 4-byte LE length prefix + UTF-8 JSON.

## STRUCTURE

```
native_host/
├── host.py                    # Entry point: stdin/stdout IPC loop
├── host_dispatch.py           # Command routing
├── download_manager.py        # Main download coordinator
├── download_task.py           # Individual download task state
├── download_task_control.py   # Pause/resume/cancel controls
├── download_logger.py         # Structured logging
├── capture_manager.py         # DRM/segment capture coordination
├── capture_helpers.py         # Capture utilities
├── cdm_capture.py             # CDM-based segment capture
├── media_resolver.py          # Media URL resolution
├── media_candidates.py        # Candidate quality list
├── yt_dlp_adapter.py          # yt-dlp wrapper
├── yt_dlp_command.py          # yt-dlp command builder
├── yt_dlp_dependencies.py     # yt-dlp dependency checks
├── stream_backends.py         # Streaming protocol backends
├── aria2c_commands.py         # aria2 download commands
├── gopeed_adapter.py          # Gopeed downloader adapter
├── bittorrent_downloads.py    # Torrent/magnet downloads
├── probe_runner.py            # Probe execution
├── probe_backends.py          # Probe backends (ffmpeg, etc.)
├── probe_types.py             # Probe type definitions
├── browser_context.py         # Browser impersonation headers
├── curl_cffi_adapter.py       # curl_cffi (Cloudflare bypass)
├── artifacts.py               # Download artifact management
├── process_control.py         # Subprocess management
├── progress_parser.py         # Download progress parsing
├── format_list.py             # Format selection logic
├── folder_picker.py           # Output folder selection
├── fix_mp4_codec.py           # MP4 codec fix utilities
├── native_paths.py            # Path resolution
├── native_protocol.py         # Protocol framing
├── spotify_resolver.py        # Spotify URL resolver
├── spotify_metadata.py        # Spotify metadata fetch
├── spotify_fallback.py        # Spotify fallback strategies
├── spotify_youtube.py         # Spotify→YouTube bridge
└── fallback_engines/          # Fallback download engines
    ├── __init__.py
    ├── direct_download.py     # Direct HTTP download
    ├── gallery_dl_engine.py   # gallery-dl wrapper
    ├── helpers.py             # Shared fallback utilities
    ├── lux_engine.py          # lux (Bilibili) wrapper
    └── you_get_engine.py      # you-get wrapper
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| **Entry/dispatch** | `host.py` → `host_dispatch.py` | Start here for command flow |
| **Download lifecycle** | `download_manager.py` + `download_task.py` | Core download logic |
| **yt-dlp integration** | `yt_dlp_adapter.py` + `yt_dlp_command.py` | Largest + most complex module |
| **DRM capture** | `capture_manager.py` + `cdm_capture.py` | Widevine segment capture |
| **Cloudflare bypass** | `curl_cffi_adapter.py` + `browser_context.py` | Impersonation + anti-bot |
| **Stream probing** | `probe_runner.py` + `probe_backends.py` | Media stream analysis |
| **Fallback engines** | `fallback_engines/` | Secondary download methods |

## CONVENTIONS

- 4-space indent, ruff linting (E/F/W/I), 120-char line limit.
- First-party imports listed in `ruff.toml` — use `import X as _X` pattern for module-level imports.
- All I/O with extension via `native_protocol.py` framing.
- Uses `asyncio` subprocess management for external tools (yt-dlp, aria2, ffmpeg).

## ANTI-PATTERNS

- No `print()` to stdout (stdin/stdout reserved for protocol framing).
- No blocking the event loop — use `asyncio` for subprocesses.
- No direct filesystem writes outside designated download/output directories.
