# Qwin Documentation

This directory contains the documentation for Qwin Video Downloader.

## Documentation Map

- [Installation and browser setup](guides/installation.md) — installing the native helper, loading
  the unpacked extension into Yandex or Chrome, and what the installer changes on disk.
- [Usage, detection and download behavior](guides/usage.md) — what the extension can detect, how
  to download from a page or a pasted link, the Downloads and Options pages, download
  management, output folders and fast mode.
- [Download backends](guides/downloaders.md) — which external tools Qwin shells out to, what each
  one is for, how the winning backend is picked, and why the rest of the ecosystem is excluded.
- [Troubleshooting](guides/troubleshooting.md) — helper, dependency, browser, URL, speed and
  filter-list problems.
- [Release notes template](guides/release-notes.md) — the skeleton used for GitHub releases.

## In short

Qwin Video Downloader detects MP4/WebM/M4V media, HLS M3U8, DASH MPD and Smooth Streaming ISM
manifests, and recognised video page URLs such as YouTube watch / embed / shorts / live pages.
Detected URLs go to a local Python helper, which uses `yt-dlp` to enumerate formats and to
download, `aria2c` for segmented parallel transfers and `ffmpeg` for merging. `N_m3u8DL-RE` and
Streamlink act as best-effort fallbacks for HLS / DASH manifests when they are installed.

Qwin also supports:

- **A Shadow-DOM on-page overlay** — a download button on each detected `<video>`, isolated
  from the host page's CSS.
- **TLS impersonation inside yt-dlp** — every yt-dlp command passes
  `--extractor-args generic:impersonate`, which lets yt-dlp's bundled curl_cffi match a real
  browser's TLS fingerprint for generic-site extraction. This helps with some Cloudflare and
  CDN blocks. It is not a JS-challenge solver, and there is no separate curl_cffi downloader.
- **uBlock Origin filter integration** — uBO filter lists (including Unbreak) plus EasyList and
  EasyPrivacy are downloaded and parsed to block ad URLs while whitelisting known video CDN
  domains, refreshed in the background every 5 days (1 day for the EasyList feeds).

## Not supported

These were removed from the codebase and are not planned. Do not look for them:

magnet links and `.torrent` files, screen recording, CDM / DRM capture, and the
lux / you-get / gallery-dl / gopeed fallback backends. See
[Download backends](guides/downloaders.md) for the full evaluation of what was considered.
