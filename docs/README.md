# Qwin Documentation

This directory contains the full documentation for Qwin Video Downloader.

## Documentation Map

- [Installation and browser setup](installation.md) - native helper install, Chrome setup, Yandex Browser setup, Firefox setup, and what the installer changes.
- [Usage, supported detection, and speed behavior](usage.md) - how to download, what the extension can detect, download management, output folders, and fast mode limits.
- [Troubleshooting](troubleshooting.md) - common helper, dependency, browser, URL, and download-speed problems.
- [Project structure and tests](project-structure.md) - repo layout and test commands.

## Short Summary

Qwin Video Downloader detects playable MP4/WebM, HLS M3U8, DASH MPD, Smooth Streaming ISM, supported video page URLs, and manually pasted video page links, then sends supported URLs to a native Python helper. The helper uses `yt-dlp` and `ffmpeg` to save videos, uses `aria2c` for segmented fast downloads, and can use N_m3u8DL-RE or Streamlink as stream fallbacks when available.

Qwin also supports BitTorrent downloads through `aria2c`. Paste a magnet link (`magnet:?xt=urn:btih:...`) or select a local `.torrent` file from the settings panel to start a BitTorrent download.
