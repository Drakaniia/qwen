# Qwin Video Downloader

[![CI](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml/badge.svg)](https://github.com/qwin-video-downloader/qwin/actions/workflows/ci.yml)
[![Build Installer](https://github.com/qwin-video-downloader/qwin/actions/workflows/build-installer.yml/badge.svg)](https://github.com/qwin-video-downloader/qwin/actions/workflows/build-installer.yml)

Qwin Video Downloader is a Windows-focused Chrome, Firefox, and Yandex Browser extension that detects playable video URLs on the current page and sends selected URLs to a local native messaging host. The helper uses `yt-dlp`, `ffmpeg`, and `aria2c` fast mode to save supported videos as MP4.

## Download

[![Download Latest](https://img.shields.io/github/v/release/qwin-video-downloader/qwin?label=Latest%20Release&color=brightgreen)](https://github.com/qwin-video-downloader/qwin/releases/latest)

**Windows users:** Download the self-contained installer from the [latest release](https://github.com/qwin-video-downloader/qwin/releases/latest).
No Python, Go, or Node.js required — everything is bundled.

- **Installer:** `Qwin-Video-Downloader-vX.X.X-Setup.exe` (~89 MB)
- **Installed size:** ~131 MB
- **Browsers supported:** Chrome, Firefox, Edge, Brave, Yandex, Chromium

> The installer includes yt-dlp, aria2c, ffmpeg, streamlink, N_m3u8DL-RE, lux, and the
> Widevine CDM pipeline (CDM sourced from Chrome at install time).
> See [packaging/README.md](packaging/README.md) for build details.

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

1. Install the native helper:

```bash
cd /d C:\Users\Qwenzy\Desktop\qwin
scripts/install.sh
```

2. Restart Chrome, Firefox, or Yandex Browser.
3. Load the extension:
   - Chrome: open `chrome://extensions`, enable Developer mode, click Load unpacked, and select `C:\Users\Qwenzy\Desktop\qwin\dist\chromium`.
   - Yandex Browser: open `browser://extensions`, enable Developer mode, click Upload unpacked extension, and select `C:\Users\Qwenzy\Desktop\qwin\dist\yandex`.
   - Firefox: open `about:debugging#/runtime/this-firefox`, click Load Temporary Add-on, and select `C:\Users\Qwenzy\Desktop\qwin\dist\firefox\manifest.json`.
4. Visit a page with a playing video, open the Qwin popup, choose a detected video/quality, and download.
5. If a page is not detected, open settings and paste the video page link into `Download from link`.
6. To download a magnet or .torrent file, open settings and use the `Download from magnet link` or `Download .torrent file` options.
7. For DRM content, install the CDM and capture binary (see docs).

## Full Documentation

- [Documentation index](docs/README.md)
- [Installation and browser setup](docs/guides/installation.md)
- [Usage, supported detection, and speed behavior](docs/guides/usage.md)
- [Troubleshooting](docs/guides/troubleshooting.md)
- [Project structure and tests](docs/reference/project-structure.md)
- [uBlock Origin integration specification](docs/reference/uBlock-integration-spec.md)
- [Go companion binary](go/README.md)
