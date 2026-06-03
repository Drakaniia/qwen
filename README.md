# Qwin Video Downloader

Qwin Video Downloader is a Windows-focused Chrome/Firefox extension that detects playable video URLs in the current tab and sends selected URLs to a local Python native messaging host. The host calls `yt-dlp` and `ffmpeg` to save the result as MP4 in the Windows Downloads folder or in the folder configured from the popup.

## What It Can Detect

- Direct MP4, M4V, and WebM URLs seen in network requests.
- HLS M3U8 playlists and DASH MPD manifests seen in network requests.
- HTML5 `<video>` and `<source>` elements in the page DOM.
- Video URLs loaded in iframes where the extension is allowed to inject content scripts.
- Video-like media requests based on response `Content-Type` and common video CDN URL patterns.
- Real HTML5 video players on the page. A small in-player Download overlay appears when the video area looks like a real player instead of a tiny clip or GIF-style animation.
- Video titles from page metadata, video element labels, yt-dlp metadata, or filename fallback.

## Honest Limits

No browser extension can guarantee downloading any video on any website. This implementation will not bypass DRM, paid-access controls, encrypted media extensions, private authorization that `yt-dlp` cannot reproduce, or site-specific anti-download systems. Browser-only `blob:` URLs are shown as unsupported in the popup unless the underlying MP4, WebM, M3U8, or MPD network URL is also detected. The page overlay can still trigger the best detected network URL for blob-backed HLS/DASH players.

Some sites require account cookies, headers, or tokens that are not available to this helper. In those cases `yt-dlp` may return an error even though the video plays in the browser.

The ad/GIF/segment filtering is best-effort detection filtering, not a full webpage ad blocker. It suppresses obvious ad/tracker media URLs, GIF/GIFV files, common GIF-preview hosts/patterns such as Giphy and Tenor preview clips, tiny hidden media, short muted looping autoplay clips, and HLS/DASH fragment URLs such as `.ts`, `.m4s`, `segment-*`, `chunk-*`, and `frag-*` from the popup and overlay. Download the M3U8/MPD playlist or master URL, not the individual segment URLs.

## Files

- `manifest.json` - Manifest V3 extension manifest for Chrome and Firefox.
- `src/shared/video_filters.js` - Shared media classification and ad/GIF filtering rules.
- `src/background/background.js` - Background service worker/event page that stores detected videos and manages native downloads.
- `src/content/content.js` - All-frame page scanner for video elements and performance resource entries.
- `src/popup/` - Toolbar popup HTML, CSS, and JavaScript.
- `src/native-host/` - Python native messaging host and Windows launcher.
- `config/native-host/` - Generated Chrome and Firefox native messaging manifest files.
- `scripts/install.bat` - Installs dependencies and registers the native host for Chrome and Firefox.
- `tests/extension/` - Node-based extension structure and behavior checks.
- `tests/native-host/` - Python unit tests for the native host helpers.

## Install The Native Helper

1. Open Command Prompt.
2. Go to this folder:

   ```bat
   cd /d C:\Users\Qwenzy\Desktop\qwin
   ```

3. Run:

   ```bat
   scripts\install.bat
   ```

The installer uses `pip` to install or update `yt-dlp` and `imageio-ffmpeg`, uses `winget` to install system `ffmpeg` if available, writes Chrome and Firefox native messaging manifests under `config\native-host`, and registers them in:

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qwin.video_downloader`
- `HKCU\Software\Mozilla\NativeMessagingHosts\com.qwin.video_downloader`

Restart Chrome and Firefox after running the installer.

## Load In Chrome

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select `C:\Users\Qwenzy\Desktop\qwin`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

The fixed ID comes from the `key` in `manifest.json`. The native host registration depends on that exact ID.

## Load In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on.
3. Select `C:\Users\Qwenzy\Desktop\qwin\manifest.json`.

The Firefox add-on ID is fixed in the manifest as `qwin-video-downloader@example.com`, which is what the native host allows. Temporary Firefox add-ons are removed when Firefox closes; permanent Firefox installation requires packaging and signing the extension.

## Use

1. Visit a page with a playing video.
2. Open the Qwin Video Downloader toolbar popup.
3. Wait for detected URLs to appear.
4. Click the Download overlay on the video player, or click Download next to a detected item in the popup.
5. Choose a quality when the quality picker appears. `Best available MP4` is recommended when you are unsure.
6. Open the Downloads view in the popup to watch progress and manage jobs. Active downloads can be paused, resumed, or canceled. Finished, failed, and canceled jobs can be retried/redownloaded, removed from history, or opened in File Explorer when a saved file path is available.

Use the settings button in the popup to set a custom Windows folder path. Leave it blank to use the default Downloads folder.

Pause/resume is handled by stopping yt-dlp and restarting the same job later. yt-dlp will continue from partial files when the site and file format support resuming; some streams may restart from the beginning.

## Troubleshooting

- `Helper not connected`: run `scripts\install.bat`, then restart the browser.
- `yt-dlp is not installed` or `ffmpeg is not installed`: run `scripts\install.bat` again and make sure Python and pip are available. `winget` is optional; without it, the helper uses the `imageio-ffmpeg` binary installed by pip.
- `Access to native host is forbidden`: reload the extension and re-run `scripts\install.bat`; Chrome must use ID `dbjddokdmkodnkiaccmbjagfalmmmkmi`, Firefox must use ID `qwin-video-downloader@example.com`.
- `Only direct http:// and https://...`: the detected URL is a browser-only `blob:`, `data:`, or local URL. Wait for a real media URL to appear.
- `yt-dlp` errors: the site may require cookies, DRM decryption, a login session, or site-specific extraction that is not available from the detected URL alone.
- Many short clips in the popup: reload the extension and reload the webpage. The current build cleans old stored fragment detections on startup and filters new HLS/DASH segment URLs.

## Test

Run the native host unit tests:

```bat
python -m unittest discover -s tests\native-host -p test_*.py
```

Run the extension checks:

```bat
node tests\extension\test_video_filters.js
node tests\extension\test_background_download_controls.js
node tests\extension\test_popup_css.js
node tests\extension\test_popup_download_view.js
```
