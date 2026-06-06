# Qwin Video Downloader

Qwin Video Downloader is a Windows-focused Chrome, Firefox, and Yandex Browser extension that detects playable video URLs on the current page and sends selected URLs to a local Python native messaging host. The helper uses `yt-dlp`, `ffmpeg`, and optional `aria2c` fast mode to save supported videos as MP4.

## Quickstart

1. Install the native helper:

   ```bat
   cd /d C:\Users\Qwenzy\Desktop\qwin
   scripts\install.bat
   ```

2. Restart Chrome, Firefox, or Yandex Browser.
3. Load the extension:
   - Chrome: open `chrome://extensions`, enable Developer mode, click Load unpacked, and select `C:\Users\Qwenzy\Desktop\qwin\dist\chromium`.
   - Yandex Browser: open `browser://extensions`, enable Developer mode, click Upload unpacked extension, and select `C:\Users\Qwenzy\Desktop\qwin\dist\yandex`.
   - Firefox: open `about:debugging#/runtime/this-firefox`, click Load Temporary Add-on, and select `C:\Users\Qwenzy\Desktop\qwin\dist\firefox\manifest.json`.
4. Visit a page with a playing video, open the Qwin popup, choose a detected video/quality, and download.

## Full Documentation

- [Documentation index](docs/README.md)
- [Installation and browser setup](docs/installation.md)
- [Usage, supported detection, and speed behavior](docs/usage.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Project structure and tests](docs/project-structure.md)

## Honest Limits

This extension does not bypass DRM, paid-access controls, browser-only `blob:` URLs without an underlying reusable media URL, private authorization that `yt-dlp` cannot reproduce, or site-specific anti-download systems. Fast mode can improve downloads when the server allows multiple connections, but it cannot force a slow or rate-limited server to send data faster.
