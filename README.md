# Qwin Video Downloader

[![CI](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml/badge.svg)](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml)
[![Build Installer](https://github.com/qwin-video-downloader/qwin/actions/workflows/build-installer.yml/badge.svg)](https://github.com/qwin-video-downloader/qwin/actions/workflows/build-installer.yml)

> ⚡ **Primary browser: Yandex** — All development and testing targets Yandex Browser first.

Qwin Video Downloader is a **Windows-focused browser extension** (Yandex, Chrome, Firefox) that detects playable video URLs on the current page and sends selected URLs to a local native messaging host. The helper uses `yt-dlp`, `ffmpeg`, and `aria2c` fast mode to save supported videos as MP4.

## Download

[![Download Latest](https://img.shields.io/github/v/release/qwin-video-downloader/qwin?label=Latest%20Release&color=brightgreen)](https://github.com/qwin-video-downloader/qwin/releases/latest)

**Windows users:** Download the self-contained installer from the [latest release](https://github.com/qwin-video-downloader/qwin/releases/latest). No Python, Go, or Node.js required — everything is bundled.

- **Installer:** `Qwin-Video-Downloader-vX.X.X-Setup.exe` (~89 MB)
- **Installed size:** ~131 MB
- **Browsers supported:** Yandex, Chrome, Firefox, Edge, Brave, Chromium

> The installer includes yt-dlp, aria2c, ffmpeg, streamlink, N_m3u8DL-RE, lux, and the
> Widevine CDM pipeline. See [packaging/README.md](packaging/README.md) for build details.

## Features

- **Video detection** — MP4/WebM/M4V, HLS M3U8, DASH MPD, Smooth Streaming ISM, YouTube shorts/live/embed, and manual page links.
- **TLS impersonation** — `curl_cffi` library provides browser-matching TLS/HTTP2 fingerprints at two levels: inside `yt-dlp` via `--extractor-args generic:impersonate`, and as a standalone direct-download adapter when yt-dlp fails. Bypasses Cloudflare, Akamai, and WAF CDN blocking.
- **Ad filtering** — Built-in ad/tracker URL patterns (AD_RE, CDN_HINT_RE) plus **uBlock Origin filter list integration** for community-maintained ad blocking and video CDN exception whitelisting.
- **Widevine CDM Pipeline** — Experimental Go companion binary (`qwin-capture`) for CDM initialization, license key extraction, and AES-128 CTR segment decryption.
- **CDP Relay** — Chrome DevTools Protocol commands relayed through Go → Python → Extension → `chrome.debugger` for advanced video source extraction.
- **Screen recording** — Tab capture with live progress updates and MSE/Blob segment capture for custom players.
- **BitTorrent** — Magnet links and `.torrent` files via `aria2c`.
- **Fast downloads** — Concurrent fragments, segmented byte-range connections, and stream fallback tools.

## Quickstart

### Prerequisites

- [Node.js](https://nodejs.org/) (for npm commands)
- [Python 3.11+](https://www.python.org/downloads/windows/) with pip
- [Go](https://go.dev/dl/) 1.21+ (for qwin-capture binary)
- [Git Bash](https://git-scm.com/downloads) (for install scripts)

Open a **Git Bash** terminal and navigate to the project root:

```bash
cd /c/Users/Qwenzy/Desktop/qwin
```

### 1. Setup

Install all native dependencies, Python packages, tools, build the extension, and register the native messaging host:

```bash
npm run setup
```

This runs `scripts/install.sh` which handles:
- Python package installation (yt-dlp, curl-cffi, streamlink, ffmpeg, you-get)
- Tool installation (aria2c, Gopeed, N_m3u8DL-RE, qwin-capture)
- Widevine CDM detection (sourced from Yandex/Chrome/Edge user data)
- Extension build (creates `dist/yandex`, `dist/chromium`, `dist/firefox`)
- Native messaging host registration (Windows Registry for all supported browsers)

The script will also:
- Detect and install the **Widevine CDM** from your Yandex or Chrome installation into `tools/cdm/`
- Register the native messaging host in your Windows Registry

### 2. Load the extension in Yandex Browser

1. Open **`browser://extensions`**
2. Enable **Developer mode** (toggle in top-right)
3. Click **"Upload unpacked extension"**
4. Select **`dist/yandex`** (relative to the project root)
5. Confirm the extension ID is **`dbjddokdmkodnkiaccmbjagfalmmmkmi`**

The extension icon should now appear in the Yandex toolbar.

> **Note:** If loading into **Chrome**, open `chrome://extensions` and select `dist/chromium`.
> If loading into **Firefox**, open `about:debugging#/runtime/this-firefox` and select `dist/firefox/manifest.json`.

### 3. Test it

Visit a page with a playing video, open the Qwin popup (click the extension icon), choose a detected video/quality, and download.

> If a page isn't detected automatically, paste the video page URL into the popup's **"Download from link"** field.

### 4. Rebuild after updates

When you pull changes or update source files, rebuild and reinstall:

```bash
npm run setup
```

Then reload the extension in Yandex Browser (`browser://extensions` → refresh icon on Qwin card).

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Full install: deps, tools, CDM, build, native host registration |
| `npm run build` | Build all extension targets (`dist/yandex`, `dist/chromium`, `dist/firefox`) |
| `npm run build:yandex` | Build Yandex target only |
| `npm run build:chromium` | Build Chrome/Chromium target only |
| `npm run build:firefox` | Build Firefox target only |
| `npm test` | Run all tests (native host + extension checks + build checks) |
| `npm run test:native` | Run Python native host unit tests (no build required) |
| `npm run test:extension` | Run JS extension checks (requires prior build) |
| `npm run lint` | Lint JS (ESLint) + Python (Ruff) |
| `npm run format` | Format JS/CSS/JSON (Prettier) + Python (Ruff) |
| `npm run build:installer` | Build the full self-contained Windows installer |
| `npm run build:installer:quick` | Quick build (skip PyInstaller, Go, and tools) |

## Project Structure

```
qwin/
├── src/background/      # Service worker: download orchestration, CDM, CDP
├── src/content/          # Content scripts: video/page detection, MSE intercept
├── src/native_host/      # Python native messaging host (yt-dlp, aria2, ffmpeg)
├── src/popup/            # Popup UI (HTML + CSS + JS modules)
├── src/shared/           # Shared JS contracts across extension components
├── go/                   # Go companion binary (qwin-capture)
├── config/               # Extension manifests + native host configs
├── scripts/              # Build, install, packaging scripts
├── docs/                 # Guides, legal docs, reference specs
├── tests/                # Extension JS + native-host Python tests
├── dist/                 # Build output (generated by npm run build/setup)
└── tools/                # Installed tools (aria2, CDM, n_m3u8dl-re, etc.)
```

## Full Documentation

- [Documentation index](docs/README.md)
- [Installation and browser setup](docs/guides/installation.md)
- [Usage, supported detection, and speed behavior](docs/guides/usage.md)
- [Troubleshooting](docs/guides/troubleshooting.md)
- [Project structure and tests](docs/reference/project-structure.md)
- [uBlock Origin integration specification](docs/reference/uBlock-integration-spec.md)
- [Go companion binary](go/README.md)

## Troubleshooting

If you run into issues:

1. **Helper not connected** — run `npm run setup` again and restart the browser
2. **Widevine CDM not found** — play a DRM video in Yandex/Chrome, then re-run `npm run setup`
3. **Extension not appearing** — open `browser://extensions`, check Developer mode is on, verify the extension is listed
4. **Native host not registered** — check Windows Registry at `HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\com.qwin.video_downloader`

For more help, see the [troubleshooting guide](docs/guides/troubleshooting.md) or use `@failed-download-troubleshooting` in the Codebuff CLI.
