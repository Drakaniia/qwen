# Project knowledge

Qwin Video Downloader — Chrome/Firefox/Yandex browser extension + Python native host for detecting and downloading videos. Widevine CDM decryption via Go companion binary.

## Quickstart
- **Setup:** `npm run setup` (installs deps, native host, aria2, gopeed, CDM)
- **Build:** `npm run build:all` → produces `dist/{chromium,firefox,yandex}/`
- **Test:** `npm run test` (runs Python + JS tests; use `:native`, `:extension`, or `:build` suite)
- **Lint:** `npm run lint` (JS: eslint, Python: ruff)
- **Format:** `npm run format` (JS: prettier, Python: ruff format)

## Architecture
- **`src/extension/background.js`** — Service worker: download orchestration, CDM intercept, CDP relay, filter integration, segment capture, batch state
- **`src/content/content.js`** — Content script: video detection, page detection, MSE intercept
- **`src/popup/`** — Popup UI (popup.html + CSS + 3 JS modules for UI/state/download list)
- **`src/shared/`** — Shared modules: batch state, media candidates, quality dialog, video picker, filters, overlay CSS
- **`src/native_host/`** — Python native messaging host (host.py dispatches to modules: download_manager, capture_manager, media_resolver, yt_dlp_adapter, etc.)
- **`go/`** — Go companion binary (`qwin-capture`): IPC loop in main.go, CDM init/key extraction in cdm.go, AES-128 CTR decrypt in decrypt.go, CDP relay in commands.go
- **`config/extension/`** — Manifest V3 templates per browser (manifest.chromium.json, manifest.firefox.json)
- **`scripts/`** — Install (.bat), build/test (.ps1), and bundle scripts
- **`tests/extension/`** — JS tests (run with Node after `build-test-bundles.js`)
- **`tests/native-host/`** — Python unittest tests

**Data flow:** Extension (content script detects video → popup lets user choose quality) → native messaging → Python host (yt-dlp/aria2/ffmpeg) → download. DRM path: Python → Go qwin-capture (CDM init → license key extraction → segment decryption → MP4 assembly).

## Conventions
- **JS:** ES modules, esbuild bundling, Manifest V3, Chrome Extension APIs. ESLint + Prettier (120 chars, 2-space indent, trailing commas, double quotes).
- **Python:** 3.11+, ruff (E/F/W/I, 120 chars, 4-space indent). First-party imports listed in ruff.toml (artifacts, browser_context, download_manager, etc.). Use `import X as _X` pattern for module-level imports.
- **Go:** Companion binary communicating via native messaging framing (4-byte LE length prefix + UTF-8 JSON). Commands dispatched from main.go → commands.go.
- **Build:** esbuild bundles content/background/popup into `dist/bundled/`, then `build-extension.ps1` copies source tree + bundles + browser manifest into `dist/{chromium,firefox,yandex}/`.
- **Native messaging:** 4-byte little-endian uint32 length prefix + UTF-8 JSON payload over stdin/stdout. Python host registered via Windows Registry under `HKCU\Software\{Browser}\NativeMessagingHosts\com.qwin.video_downloader`.
- **Extension ID (Chrome):** `dbjddokdmkodnkiaccmbjagfalmmmkmi` — must match in native host manifest allowed_origins.
- **Avoid:** Global npm packages. Installing deps via `npm run setup` (runs `scripts\install.bat`).
