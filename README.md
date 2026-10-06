# Qwin Video Downloader

[![CI](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml/badge.svg)](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml)

> ⚡ **Primary browser: Yandex** — all development and manual testing targets Yandex Browser
> first. Chrome/Chromium is secondary.

Qwin Video Downloader is a **Windows-focused Chromium extension** (Manifest V3) plus a local
Python **native messaging host**. The extension finds video on the page you are looking at,
asks the helper what formats exist, and downloads the one you pick — with live progress, a
downloads page, and an options page.

## What it does

- **Detects video on the page** — direct `MP4` / `WebM` / `M4V`, HLS `M3U8`, DASH `MPD` and
  Smooth Streaming `ISM` manifests, plus recognised video page URLs (YouTube watch / embed /
  shorts / live). Found by scanning the DOM and by watching network requests.
- **On-page overlay** — a small download button is attached to each detected `<video>`
  element. It renders in a Shadow DOM so it cannot be broken or restyled by the host page.
- **Enumerates formats** — for each candidate the extension asks the native host, which runs
  `yt-dlp` and returns resolution / size / format / bitrate per stream.
- **Downloads** — `yt-dlp` with `aria2c` for segmented parallel transfers and `ffmpeg` for
  merging and remuxing to MP4. `N_m3u8DL-RE` and Streamlink are used as best-effort fallbacks
  for HLS / DASH manifests when they are installed. Simple direct media URLs can instead go
  straight through the browser's own downloader.
- **Audio-only downloads** — paste a Spotify / YouTube Music / SoundCloud / Deezer / Bandcamp
  link and download the audio in your chosen format. The native host resolves whether a link
  is video or audio, so there is nothing to pick up front.
- **Live progress and job control** — pause, resume, cancel, retry, redownload and remove,
  in the popup or on the Downloads page.
- **Download history** — optionally synced through the browser profile's storage and capped at
  200 entries.
- **Ad/tracker filtering** — built-in patterns plus uBlock Origin and EasyList filter lists,
  refreshed in the background, with exception handling so known video CDNs are not blocked.

There is **no** magnet / BitTorrent support, **no** screen recording, and **no** DRM capture.
Those backends were removed; nothing in this repository implements them.

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) (CI builds and tests on Node 24)
- [Python](https://www.python.org/downloads/windows/) 3.11+ with `pip` (the native host)
- [Git Bash](https://git-scm.com/downloads) (the installer is a bash script)
- Yandex Browser 26.x (Chromium 150) or Chrome / Chromium / Edge / Brave 148+

## Install

Run this from a **Git Bash** terminal in the project root:

```bash
npm run setup
```

That invokes `scripts/install.sh`, which:

1. detects Python,
2. installs `yt-dlp[default,curl-cffi]`, `imageio-ffmpeg`, `certifi` and `streamlink` with `pip`,
3. installs system `ffmpeg` via `winget` when available,
4. downloads `aria2c.exe` into `tools/aria2` and `N_m3u8DL-RE.exe` into `tools/n_m3u8dl-re`,
5. runs the extension build (`npm run build`),
6. writes the native messaging manifests to `config/native-host/` and registers the host in
   the Windows registry under `HKCU\Software\{Browser}\NativeMessagingHosts\com.qwin.video_downloader`
   for Chrome, Edge, Brave, Chromium and Yandex.

### Load the extension

**Yandex (primary)** — `browser://extensions` → enable Developer mode → _Upload unpacked
extension_ → select `dist/yandex`.

**Chrome / Chromium / Edge / Brave** — `chrome://extensions` → Developer mode → _Load
unpacked_ → select `dist/chromium`.

In both cases the extension ID must be:

```
dbjddokdmkodnkiaccmbjagfalmmmkmi
```

If it is not, the native host will refuse every request. The ID is pinned by the `key` field
in `config/extension/manifest.chromium.json`.

Restart the browser after running the installer, then open the popup — the header should show
the helper as connected.

## Develop

The browser always loads `dist/`, never `src/`. Rebuild after every source change.

```bash
npm run build          # both targets
npm run build:yandex   # dist/yandex only
npm run build:chromium # dist/chromium only
npm run dev            # vite build --watch, for the popup pages
```

Then hit reload on the extension card in `browser://extensions`.

`scripts/load-extension.ps1` restarts Yandex with `dist/yandex` already loaded, if that is
faster than clicking through the UI.

## Test

```bash
npm test               # vitest: 1118 tests across 31 files
npm run test:watch     # vitest, watch mode
npm run test:native    # pytest: 8 tests, native host
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src/ + ruff check src/native_host/
npm run format         # prettier --write + ruff format
```

All four of `lint`, `typecheck`, `test` and `test:native` run in CI, alongside the build.

## Project layout

```
qwin/
├── config/          # the extension manifest + native messaging manifests
├── src/
│   ├── background/  # service worker: download orchestration, webRequest, message routing
│   ├── content/     # content script: page detection + the Shadow-DOM overlay
│   ├── popup/       # popup.html, downloads.html, options.html, components, signals
│   ├── shared/      # contracts used by background, content and popup alike
│   ├── ui/          # the design system: tokens, icons, motion, hooks, components
│   └── native_host/ # the Python native messaging host
├── tests/js/        # vitest
├── tests/native/    # pytest
├── scripts/         # build + install
└── dist/            # generated, gitignored
```

The popup pages are built by Vite; the content script and the service worker are bundled to a
single IIFE by esbuild. That split is deliberate — a declared content script cannot be an ES
module, so those two must stay self-contained.

## Documentation

- [Documentation index](docs/README.md)
- [Installation and browser setup](docs/guides/installation.md)
- [Usage, detection and download behavior](docs/guides/usage.md)
- [Download backends](docs/guides/downloaders.md)
- [Troubleshooting](docs/guides/troubleshooting.md)

## Legal

Download only content you have the right to download. You are responsible for complying with
applicable law and with the terms of the sites you visit.

Qwin's own code is GPL-3.0-only ([LICENSE](LICENSE)). The external tools it shells out to —
yt-dlp, ffmpeg, aria2c, N_m3u8DL-RE, Streamlink — are free and open-source under their own
licenses and are not redistributed here; see
[Download backends](docs/guides/downloaders.md#licenses).
