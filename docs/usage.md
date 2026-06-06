# Usage

## What It Can Detect

Qwin can detect:

- Direct MP4, M4V, and WebM URLs seen in network requests.
- HLS M3U8 playlists and DASH MPD manifests seen in network requests.
- HTML5 `<video>` and `<source>` elements in the page DOM.
- Video URLs loaded in iframes where the extension is allowed to inject content scripts.
- Video-like media requests based on response `Content-Type` and common video CDN URL patterns.
- Real HTML5 video players on the page. A small in-player Download overlay appears when the video area looks like a real player instead of a tiny clip or GIF-style animation.
- Video titles from page metadata, video element labels, `yt-dlp` metadata, or filename fallback.

The extension filters obvious ad/tracker media URLs, GIF/GIFV previews, common GIF-preview hosts such as Giphy and Tenor, tiny hidden media, short muted looping autoplay clips, and HLS/DASH fragment URLs such as `.ts`, `.m4s`, `segment-*`, `chunk-*`, and `frag-*`. Download the M3U8/MPD playlist or master URL, not individual segment URLs.

## Download A Video

1. Visit a page with a playing video.
2. Open the Qwin Video Downloader toolbar popup.
3. Wait for detected full videos to appear. Duplicate source URLs and quality variants are grouped into one video entry.
4. Click the Download overlay on the video player, or click Download next to a detected item in the popup.
5. Compare the available versions by resolution, size, format, bitrate, and source.
6. Choose the version to download. `Best available MP4` is recommended when you are unsure.
7. Open the Downloads view in the popup to watch progress and manage jobs.

## Download Management

The Downloads view supports:

- Pause active downloads.
- Resume paused downloads.
- Cancel active or paused downloads.
- Retry failed or canceled downloads.
- Redownload finished downloads.
- Remove jobs from history.
- Open saved files in File Explorer when a saved file path is available.

Pause/resume is handled by stopping `yt-dlp` and restarting the same job later. `yt-dlp` will continue from partial files when the site and file format support resuming. Some streams may restart from the beginning.

## Download Folder

By default, videos save under the Windows Downloads folder. Use the settings button in the popup to set a custom Windows folder path.

Each download is saved inside a title folder:

```text
Downloads\Video Title\Video Title [id].mp4
```

Leaving the folder setting blank uses the default Downloads folder.

## Download Speed

The native helper uses:

- Concurrent HLS/DASH fragments through `yt-dlp --concurrent-fragments`.
- Optional `aria2c` segmented external downloads when `aria2c` is available.

Fast mode uses up to 32 parallel fragments or byte-range connections by default. For direct MP4/WebM downloads, `aria2c` splits the file into byte ranges and downloads those ranges in parallel before assembling the final file.

This can improve speed on direct MP4/WebM, HLS, and DASH sources that allow multiple connections. It cannot force a slow server, overloaded CDN, DRM-protected stream, or rate-limited site to send data faster.

If the popup shows `fast mode`, `aria2c` is available. If it shows `standard mode`, downloads still work but segmented `aria2c` acceleration is unavailable.

## Honest Limits

No browser extension can guarantee downloading any video on any website. This implementation will not bypass:

- DRM or encrypted media extensions.
- Paid-access controls.
- Private authorization that `yt-dlp` cannot reproduce.
- Site-specific anti-download systems.
- Browser-only `blob:`, `data:`, or local URLs unless the extension also detects the underlying MP4, WebM, M3U8, or MPD URL.

Some sites require account cookies, headers, or tokens that are not available to this helper. In those cases `yt-dlp` may return an error even though the video plays in the browser.
