# Project Structure And Tests

## Files

- `manifest.json` — Chromium/Yandex Manifest V3 development manifest.
- `config/extension/` — Browser-specific extension manifest templates.
- `config/native-host/` — Generated Chrome, Yandex Browser, and Firefox native messaging manifest files.
- `dist/` — Generated browser-specific extension folders; ignored by git.
- `go/` — Go companion binary (`qwin-capture`) for CDM, key extraction, segment decryption, and CDP relay. See [go/README.md](../../go/README.md).

### Extension — Shared Modules

- `src/shared/media_candidates.js` — Shared extension-side media URL classification, ad-blocking regex patterns (AD_RE, CDN_HINT_RE, etc.), exception-aware URL blocking (`isBlockedMediaUrlWithExceptions`), and downloadability contract.
- `src/shared/video_filters.js` — Shared video filtering, grouping, display, full-length candidate rules, and quality inference.
- `src/shared/filter_list_loader.js` — uBlock Origin filter list downloader/parser/cache. Downloads and parses uBO filter lists (filters.txt, unbreak.txt, EasyList, EasyPrivacy), extracts video-relevant domain patterns, caches in `chrome.storage.local`, and supports HTTP conditional requests with ETags.
- `src/shared/popup_api.js` — Popup extension API wrapper exposing download, recording, CDM status, and CDP commands.
- `src/shared/popup_state.js` — Popup state management for settings and downloads.
- `src/shared/quality_format.js` — Quality/format picker dialog state.
- `src/shared/quality_dialog.js` — Quality selection dialog component.
- `src/shared/browser_api.js` — Cross-browser API abstraction layer.
- `src/shared/video_picker.js` — Video picker UI overlay component.

### Extension — Background

- `src/background/background.js` — Background service worker that wires browser events, state, message routing, filter list initialization, CDP relay, CDM capture, and segment capture.
- `src/background/download_orchestration.js` — Download lifecycle module for native download start, retry, pause, resume, cancel, remove, clear, and fallback resolution flows.
- `src/background/download_state.js` — Download state helpers for progress normalization, ETA formatting, and speed display.
- `src/background/download_fallbacks.js` — Download fallback resolution: page fallback, media candidate resolution, variant enumeration.
- `src/background/tab_state.js` — Tab-scoped video, download, and settings state with `chrome.storage.session` persistence.
- `src/background/message_router.js` — Declarative message router for `chrome.runtime.onMessage` dispatch.
- `src/background/native_requests.js` — Native messaging request wrapper.
- `src/background/cdp_relay.js` — CDP relay module that manages persistent `chrome.debugger` connections and forwards CDP commands.
- `src/background/cdp_extraction.js` — CDP-based video source extraction via `Runtime.evaluate`.
- `src/background/cdm_network_intercept.js` — CDM network interception via `chrome.debugger` for capturing Widevine license exchanges.
- `src/background/segment_capture.js` — MSE/Blob segment capture orchestration.

### Extension — Content Scripts

- `src/content/content.js` — Content-script entry point for page scanning schedules, video overlays, and quality/download interaction.
- `src/content/page_detection.js` — Content-side candidate construction, URL normalization, YouTube/page fallback detection, and text scanning.
- `src/content/media_source_intercept.js` — MSE/Blob URL media source interception for custom players.

### Extension — Popup

- `src/popup/popup.html` / `src/popup/popup.js` / `src/popup/popup.css` — Toolbar popup HTML, JavaScript, and CSS.
- `src/popup/download_list.js` — Download list view component.
- `src/shared/qwin_overlay.css` — In-player Download overlay styling.

### Native Host (Python)

- `src/native_host/host.py` — Python native messaging host entry point.
- `src/native_host/host_dispatch.py` — Native-host message dispatch and main-loop module with CDP relay forwarding.
- `src/native_host/capture_manager.py` — Manages the `qwin-capture` Go subprocess lifecycle: spawn, stop, send commands, background reader thread, CDP relay forwarding, CDM auto-init. Provides Python API for `cdm_init`, `extract_keys`, `decrypt_segments`, `assemble_segments`.
- `src/native_host/media_candidates.py` — Python mirror of the JS media URL classification patterns.
- `src/native_host/download_manager.py` — Download job management and progress reporting.
- `src/native_host/download_task.py` — Individual download task runner (yt-dlp, aria2c, streamlink wrappers).
- `src/native_host/download_logger.py` — Structured JSONL download logger.
- `src/native_host/yt_dlp_adapter.py` — yt-dlp command construction and output parsing.
- `src/native_host/yt_dlp_command.py` — yt-dlp subprocess management.
- `src/native_host/yt_dlp_dependencies.py` — yt-dlp dependency detection.
- `src/native_host/stream_backends.py` — Stream fallback backends (N_m3u8DL-RE, Streamlink).
- `src/native_host/format_list.py` — Format list parsing from yt-dlp output.
- `src/native_host/media_resolver.py` — Media URL resolution.
- `src/native_host/fallback_engines.py` — Fallback stream resolution engines.
- `src/native_host/browser_context.py` — Browser context header reconstruction.
- `src/native_host/folder_picker.py` — Windows folder picker integration.
- `src/native_host/process_control.py` — Subprocess lifecycle management.
- `src/native_host/progress_parser.py` — yt-dlp progress output parser.
- `src/native_host/native_paths.py` — Native file path resolution.
- `src/native_host/native_protocol.py` — Native messaging framing protocol.
- `src/native_host/artifacts.py` — Download artifact cleanup.
- `src/native_host/spotify_resolver.py` — Spotify URL resolution for music downloads.
- `src/native_host/qwin_video_host.bat` — Windows batch launcher for the native host.

### Scripts

- `scripts/install.bat` — Installs all dependencies and registers the native host for Chrome, Yandex Browser, and Firefox.
- `scripts/install-aria2.ps1` — Installs or verifies the portable `aria2c` fast downloader.
- `scripts/install-stream-fallbacks.ps1` — Installs or verifies Streamlink and portable N_m3u8DL-RE.
- `scripts/install-cdm.ps1` — Detects Chrome's bundled Widevine CDM, copies it to `tools/cdm/`, or downloads a known-compatible fallback version. Writes `tools/cdm/status.json` for the native host.
- `scripts/install-capture.ps1` — Downloads and installs the `qwin-capture` Go companion binary from GitHub releases into `tools/capture/`.
- `scripts/build-extension.ps1` — Builds loadable Chromium, Yandex Browser, and Firefox extension folders under `dist`.
- `scripts/build-bundles.js` — Node.js build script for extension bundle assembly.
- `scripts/build-test-bundles.js` — Test bundle build script.
- `scripts/test.ps1` — Runs native-host tests, extension checks, and extension build checks.

### Tests

- `tests/extension/` — Node-based extension structure and behavior checks.
- `tests/native-host/` — Python unit tests for the native host helpers.
- `tests/fixtures/` — Test fixtures (media_candidate_rules.json, etc.).

### Documentation

- `docs/README.md` — Documentation index.
- `docs/guides/installation.md` — Installation and browser setup.
- `docs/guides/usage.md` — Usage, detection, filter list integration, CDM pipeline.
- `docs/guides/troubleshooting.md` — Troubleshooting guide.
- `docs/reference/project-structure.md` — This file.
- `docs/reference/uBlock-integration-spec.md` — uBlock Origin filter integration specification.
- `go/README.md` — Go companion binary documentation.

## Tests

### Native Host Tests (Python)

```bat
python -m unittest discover -s tests\native-host -p test_*.py
```

Or with `py -3`:

```bat
py -3 -m unittest discover -s tests\native-host -p test_*.py
```

### Extension Checks (Node)

Run an individual check:

```bat
node tests\extension\test_video_filters.js
```

Run all extension checks:

```powershell
Get-ChildItem tests\extension -Filter test_*.js | ForEach-Object { node $_.FullName }
```

Key test files include:
- `test_filter_integration.js` — uBlock Origin ad/regex/exception integration tests
- `test_filter_list_loader.js` — Filter list parser and cache tests
- `test_cdp_relay.js` — CDP relay chain tests
- `test_cdp_extraction.js` — CDP video source extraction tests
- `test_cdm_network_intercept.js` — CDM network interception tests
- `test_recording_ui.js` — Screen recording UI tests
- `test_segment_capture.js` — MSE segment capture tests
- `test_music_streaming_support.js` — Spotify/music detection tests
- `test_video_filters.js` — Video grouping, sorting, and candidate filtering tests
- `test_background_download_controls.js` — Download lifecycle tests

### Go Tests

```bat
cd go
go test -v ./...
```

### All Tests (npm)

```powershell
npm run build          # builds chromium, firefox, yandex targets under dist/
npm test               # runs native-host unittest, extension checks, and build checks
npm run test:native    # Python unittest only (no build required)
npm run test:extension # JS extension checks only (requires prior build)
npm run test:build     # runs build script as a validation check
```
