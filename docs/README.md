# Qwin Documentation

This directory contains the full documentation for Qwin Video Downloader.

## Documentation Map

- [Installation and browser setup](guides/installation.md) — native helper install, Chrome/Firefox/Yandex setup, CDM installer, capture binary installer, and what the installer changes.
- [Usage, supported detection, and speed behavior](guides/usage.md) — how to download, what the extension can detect, download management, output folders, fast mode limits, uBlock Origin filter integration, and CDM decryption pipeline.
- [Troubleshooting](guides/troubleshooting.md) — common helper, dependency, browser, URL, download-speed problems, CDM issues, and filter list issues.
- [Project structure and tests](reference/project-structure.md) — repo layout, new modules, and test commands.
- [uBlock Origin integration specification](reference/uBlock-integration-spec.md) — detailed spec for ad-filter integration with uBO patterns and filter lists.
- [Go companion binary](go/README.md) — the `qwin-capture` Go binary for CDM key extraction, segment decryption, and CDP relay.

## Legal

- [Terms of Service](legal/terms-of-service.md) — License terms, acceptable use, and user responsibilities
- [Privacy Policy](legal/privacy-policy.md) — Data collection and storage practices
- [DMCA Notice](legal/dmca-notice.md) — Copyright infringement takedown procedure
- [Disclaimer](legal/disclaimer.md) — Warranty disclaimer and limitation of liability
- [Fair Use Notice](legal/fair-use-notice.md) — Guidance on copyright and fair use

## Short Summary

Qwin Video Downloader detects playable MP4/WebM, HLS M3U8, DASH MPD, Smooth Streaming ISM, supported video page URLs, and manually pasted video page links, then sends supported URLs to a native Python helper. The helper uses `yt-dlp` and `ffmpeg` to save videos, uses `aria2c` for segmented fast downloads, and can use N_m3u8DL-RE or Streamlink as stream fallbacks when available.

Qwin also supports:
- **`curl_cffi` TLS impersonation** — two levels of browser fingerprint matching to bypass Cloudflare, Akamai, and other WAF/CDN bot-detection: inside `yt-dlp` via `--extractor-args generic:impersonate`, and as a standalone direct-download adapter (`curl_cffi_adapter.py`) when yt-dlp fails.
- **BitTorrent downloads** through `aria2c` — paste a magnet link or select a `.torrent` file.
- **uBlock Origin filter integration** — loads and parses uBO filter lists (Unbreak, EasyList, EasyPrivacy) to block ad URLs while whitelisting known video CDN domains, with automatic background refresh every 5 days.
- **Widevine CDM pipeline** — Go companion binary (`qwin-capture`) for CDM initialization, license key extraction, AES-128 CTR segment decryption, and fMP4 assembly.
- **CDP relay chain** — Chrome DevTools Protocol commands relayed through Go → Python → Extension → `chrome.debugger` for advanced video source extraction.
- **Screen recording** — tab capture with progress monitoring, MSE/Blob segment capture for custom players.
