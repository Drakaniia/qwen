# Qwin Documentation

This directory contains the full documentation for Qwin Video Downloader.

## Documentation Map

- [Installation and browser setup](installation.md) - native helper install, Chrome setup, Firefox setup, and what the installer changes.
- [Usage, supported detection, and speed behavior](usage.md) - how to download, what the extension can detect, download management, output folders, and fast mode limits.
- [Troubleshooting](troubleshooting.md) - common helper, dependency, browser, URL, and download-speed problems.
- [Project structure and tests](project-structure.md) - repo layout and test commands.

## Short Summary

Qwin Video Downloader detects playable MP4/WebM, HLS M3U8, and DASH MPD URLs from browser pages and sends supported URLs to a native Python helper. The helper uses `yt-dlp` and `ffmpeg` to save videos, and can use `aria2c` for segmented fast downloads when available.

No browser extension can guarantee downloading every video from every site. DRM, protected streams, login-only authorization, and server-side throttling may still block or slow downloads.
