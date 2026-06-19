# Usage

## What It Can Detect

Qwin can detect:

- Direct MP4, M4V, and WebM URLs seen in network requests.
- HLS M3U8 playlists and DASH MPD manifests seen in network requests.
- HTML5 `<video>` and `<source>` elements in the page DOM.
- Video URLs loaded in iframes where the extension is allowed to inject content scripts.
- Reusable MP4/WebM/M3U8/MPD/ISM URLs embedded in visible player pages or inline player configuration scripts.
- Video-like media requests based on response `Content-Type` and common video CDN URL patterns.
- Real HTML5 video players on the page. A small in-player Download overlay appears when the video area looks like a real player instead of a tiny clip or GIF-style animation.
- Real YouTube video pages from the visible YouTube player. Qwin sends the YouTube watch/embed/shorts page URL to `yt-dlp`, then the helper saves the selected version as MP4.
- Manual video page links pasted in settings. This is a fallback for extractor-supported sites such as YouTube, Instagram, TikTok, X, Threads, and other URLs the helper tools can access.
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

## Download From A Link

1. Open the Qwin settings panel.
2. Paste a public or otherwise accessible video page URL into `Download from link`.
3. Click `Download link`.
4. Choose a quality when `yt-dlp` returns available versions.

This fallback sends the pasted URL to `yt-dlp` first. For stream manifest URLs, the helper can also try N_m3u8DL-RE or Streamlink when those tools are installed. It does not make unsupported, private, DRM-protected, or blocked videos downloadable.

## Download From A Magnet Link

1. Open the Qwin settings panel.
2. Paste a magnet link (starting with `magnet:?xt=urn:btih:...`) into `Download from magnet link`.
3. Click `Download magnet`.
4. Confirm in the quality dialog to start the BitTorrent download.

Magnet links are BitTorrent downloads that the native helper runs directly through `aria2c`. Progress is reported in the Downloads view just like video downloads.

## Download From A .torrent File

1. Open the Qwin settings panel.
2. Click `Download .torrent file`.
3. Select a local `.torrent` file using the native Windows file picker.
4. The download starts immediately using `aria2c`.

The native helper opens a Windows file picker (PowerShell `OpenFileDialog` with `.torrent` filter, falling back to Tk) to select a local `.torrent` file. The file path is validated to ensure it exists and has a `.torrent` extension before the download begins.

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

By default, videos save under the Windows Downloads folder. Use the settings button in the popup, then click `Browse` to choose a custom folder in the Windows folder picker.

Each download is saved inside a title folder:

```text
Downloads\Video Title\Video Title [id].mp4
```

Leaving the folder setting blank uses the default Downloads folder.

## Download Speed

The native helper uses:

- Concurrent HLS/DASH fragments through `yt-dlp --concurrent-fragments`.
- `aria2c` segmented external downloads for parallel byte-range connections.
- N_m3u8DL-RE or Streamlink fallback downloads for accessible HLS, DASH, or Smooth Streaming manifests when `yt-dlp` cannot use a stream source.

Fast mode uses up to 32 yt-dlp fragments and up to 16 `aria2c` byte-range connections by default. For direct MP4/WebM downloads, `aria2c` splits the file into byte ranges and downloads those ranges in parallel before assembling the final file.

## BitTorrent Download Behavior

Both magnet links and .torrent files use `aria2c`'s built-in BitTorrent engine. The download behaves like a standard BitTorrent download:

- **Seeding is disabled** by default (`--seed-time=0`). After the download completes, `aria2c` stops seeding immediately.
- **File allocation** is set to `none` to start writing immediately without pre-allocating space.
- **Parallel connections** are made to up to 50 BitTorrent peers by default.
- **Progress reporting** shows the same percent/speed/ETA display as video downloads.
- **Output folder** follows the same download folder setting. Files are saved directly into the chosen folder (not inside a subfolder).