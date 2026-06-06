# Qwin Video Downloader

Qwin Video Downloader is a Windows-focused Chrome, Firefox, and Yandex Browser extension that detects playable video URLs on the current page and sends selected URLs to a local Python native messaging host. It can also detect real YouTube video pages from the visible player. The helper uses `yt-dlp`, `ffmpeg`, and optional `aria2c` fast mode to save supported videos as MP4.

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
5. If a page is not detected, open settings and paste the video page link into `Download from link`.

## Full Documentation

- [Documentation index](docs/README.md)
- [Installation and browser setup](docs/installation.md)
- [Usage, supported detection, and speed behavior](docs/usage.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Project structure and tests](docs/project-structure.md)
 
