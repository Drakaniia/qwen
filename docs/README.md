# Qwin Documentation

This directory contains the full documentation for Qwin Video Downloader.

## Documentation Map

- [Installation and browser setup](installation.md) — native helper install, Chrome/Firefox/Yandex setup, CDM installer, capture binary installer, and what the installer changes.
- [Usage, supported detection, and speed behavior](usage.md) — how to download, what the extension can detect, download management, output folders, fast mode limits, uBlock Origin filter integration, and CDM decryption pipeline.
- [Troubleshooting](troubleshooting.md) — common helper, dependency, browser, URL, download-speed problems, CDM issues, and filter list issues.
- [Project structure and tests](project-structure.md) — repo layout, new modules, and test commands.
- [uBlock Origin integration specification](uBlock-integration-spec.md) — detailed spec for ad-filter integration with uBO patterns and filter lists.
- [Go companion binary](go/README.md) — the `qwin-capture` Go binary for CDM key extraction, segment decryption, and CDP relay.

## Short Summary

Qwin Video Downloader detects playable MP4/WebM, HLS M3U8, DASH MPD, Smooth Streaming ISM, supported video page URLs, and manually pasted video page links, then sends supported URLs to a native Python helper. The helper uses `yt-dlp` and `ffmpeg` to save videos, uses `aria2c` for segmented fast downloads, and can use N_m3u8DL-RE or Streamlink as stream fallbacks when available.

Qwin also supports:
- **BitTorrent downloads** through `aria2c` — paste a magnet link or select a `.torrent` file.
- **uBlock Origin filter integration** — loads and parses uBO filter lists (Unbreak, EasyList, EasyPrivacy) to block ad URLs while whitelisting known video CDN domains, with automatic background refresh every 5 days.
- **Widevine CDM pipeline** — Go companion binary (`qwin-capture`) for CDM initialization, license key extraction, AES-128 CTR segment decryption, and fMP4 assembly.
- **CDP relay chain** — Chrome DevTools Protocol commands relayed through Go → Python → Extension → `chrome.debugger` for advanced video source extraction.
- **Screen recording** — tab capture with progress monitoring, MSE/Blob segment capture for custom players.
