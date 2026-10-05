# Usage

## What It Can Detect

Qwin can detect:

- Direct `MP4`, `M4V` and `WebM` URLs seen in network requests.
- HLS `M3U8` playlists, DASH `MPD` manifests and Smooth Streaming `ISM` manifests seen in
  network requests.
- HTML5 `<video>` and `<source>` elements in the page DOM, including inside iframes and
  inside other elements' shadow roots where the content script can reach.
- Reusable MP4/WebM/M3U8/MPD/ISM URLs embedded in visible player markup or inline player
  configuration scripts.
- Video-like media requests matched by response `Content-Type` or by CDN URL patterns.
- Recognised video page URLs. For YouTube, Qwin sends the watch / embed / shorts / live page
  URL to `yt-dlp` rather than the temporary `googlevideo.com` playback URL, so the whole
  format list is available.
- Video titles from page metadata, `<video>` labels, `yt-dlp` metadata, or the filename.

An on-page download button appears over each `<video>` that looks like a real player rather
than a GIF or a tiny clip. It is rendered inside a Shadow DOM, so the page's CSS cannot reach
it and Qwin's cannot reach the page.

The extension filters obvious ad/tracker media URLs, GIF and GIFV previews (including the
Giphy and Tenor preview hosts), tiny hidden media, short muted looping autoplay clips, and
HLS/DASH fragment URLs such as `.ts`, `.m4s`, `segment-*`, `chunk-*` and `frag-*`. Download
the playlist or master manifest URL, not individual segment URLs.

## uBlock Origin Filter Integration

Qwin integrates with uBlock Origin's community-maintained filter lists to improve ad URL
blocking and video CDN whitelisting.

### How It Works

1. **At startup**, the extension loads cached filter patterns from `chrome.storage.local`.
2. **Exception domains** from filter lists (especially uBO's Unbreak list) are passed to
   `isBlockedMediaUrlWithExceptions()` — a URL from a known video CDN that matches an ad
   pattern is not blocked.
3. **Every 5 days** the service worker re-downloads the lists and recompiles the video-relevant
   domain patterns.
4. **Ad domains** discovered from the lists are added to the blocking set alongside the
   built-in `AD_RE` regex in `src/shared/media_candidates.ts`.

If the cache is empty (first install) an immediate refresh is triggered, so the exception
rules are available without waiting five days.

### Supported Filter Lists

| List                  | Source                                                | Refresh |
| --------------------- | ----------------------------------------------------- | ------- |
| uBlock filters        | `uBlockOrigin/uAssets` → `filters/filters.txt`        | 5 days  |
| uBlock Unbreak        | `uBlockOrigin/uAssets` → `filters/unbreak.txt`        | 5 days  |
| uBlock Resource abuse | `uBlockOrigin/uAssets` → `filters/resource-abuse.txt` | 5 days  |
| uBlock Privacy        | `uBlockOrigin/uAssets` → `filters/privacy.txt`        | 5 days  |
| EasyList              | `easylist.to` → `easylist.txt`                        | 1 day   |
| EasyPrivacy           | `easylist.to` → `easyprivacy.txt`                     | 1 day   |

The **Unbreak** list is the most valuable — it holds the exception rules that restore player
functionality on sites where aggressive blocking would break playback.

The **Options** page shows each list with its expected size, its refresh interval, and when it
was last fetched. Nothing there is configurable: the list set is fixed.

### Exception-Aware Blocking

When a URL matches both an ad pattern and an exception domain (`akamaihd.net` is both a common
ad CDN _and_ essential for streaming), the exception wins. That is what prevents false
positives on legitimate video CDNs.

## TLS Impersonation Inside yt-dlp

Qwin's `yt-dlp` commands carry `--extractor-args generic:impersonate`, which tells yt-dlp to
use its bundled `curl_cffi` for TLS/HTTP2 fingerprint matching when extracting from generic
(unknown) sites. A site that rejects a plain HTTP client on the basis of its TLS fingerprint
may then behave as it does for a real browser.

```python
# src/native_host/backends/yt_dlp/yt_dlp_command.py
GENERIC_EXTRACTOR_ARGS = "generic:impersonate"
```

This is one lever inside one step of one pipeline. It is **not** a general WAF bypass: it
cannot solve JavaScript challenges (Cloudflare Turnstile, hCaptcha), behavioural detection, or
login/session requirements. `curl_cffi` itself arrives as the `curl-cffi` extra of
`yt-dlp[default,curl-cffi]`; the native host does not probe or import it itself, it only hands
yt-dlp the flag above and lets yt-dlp do the impersonation.

You can check the fingerprint yourself from a Python shell:

```bash
python -c "from curl_cffi import requests; print(requests.get('https://tls.browserleaks.com/json', impersonate='chrome').json()['ja3_hash'])"
```

## Download A Video

1. Visit a page with a playing video.
2. Open the Qwin toolbar popup and stay on the **Media** view.
3. Wait for the scan to finish. Duplicate source URLs and quality variants are grouped into
   one entry per video; use the search box, the sort control and the size filter to narrow
   the list down.
4. Click the download button on the video itself, or Download on a detected row in the popup.
5. Compare the available versions by resolution, size, format, bitrate and source.
6. Pick one. `Best available MP4` is the safe choice when you are unsure.
7. Watch progress in the popup's **Downloads** view, or on the full **Downloads** page.

## Download From A Link

1. Open the popup to the **Media** view.
2. Paste a URL into the **Paste a link** box at the top.
3. Click **Download** (or press Enter in the box).
4. Choose a quality when `yt-dlp` returns versions.

This is the fallback for pages the detector cannot read. The URL goes to `yt-dlp` first; for
stream manifests the helper may then try N_m3u8DL-RE or Streamlink if they are installed. It
does not make unsupported, private or DRM-protected videos downloadable.

There is one box for every kind of link. Qwin does not guess video vs audio from the URL —
the native helper resolves the link, and the returned dialog already knows which it is. For
audio links (Spotify, YouTube Music, SoundCloud, Deezer, Bandcamp) the audio candidate appears
in **Media** with a purple badge; the output container comes from Options → Audio format.

## Download Management

Both the popup's **Downloads** view and the full **Downloads** page support:

- Pause and resume an active download.
- Cancel an active or paused download.
- Retry a failed or cancelled download.
- Redownload a finished one.
- Remove a job from the list.
- Open the saved file, or reveal it in File Explorer, when a path is known.

The Downloads page adds free-text search over titles, faceted filters by status / format /
source, and the bulk actions **Retry failed**, **Clear all** and **Reveal newest**.
**Clear all** drops every finished job *and* the synced history behind it, so a cleared
list stays cleared; active downloads are left running.

Pause/resume stops `yt-dlp` and restarts the same job later. `yt-dlp` resumes from its
partial files when the site and format allow it; some streams start over.

Completed downloads are appended to the synced history when that option is on. History lives
in the browser profile's sync storage and is capped at 200 entries; Options shows the current
count and can clear it.

## Options

Open Options from the popup's header gear, or from the browser's extension options entry. It
holds everything durable, in five sections with a search field at the top:

**Downloads**

- **Download folder** — a Windows path, or **Browse...** for the folder picker. Blank means
  the Windows Downloads folder.
- **Audio format** — used when a download is audio only.
- **Hide videos smaller than** — the starting value for the popup's size filter.
- **Download subtitles by default** — whether `yt-dlp` fetches subtitles without being asked.

**Appearance**

- **Theme** — System / Light / Dark. System follows your operating system. The choice applies
  immediately and survives a restart. The popup header carries the same control.

**Page integration**

- **Show a download button on detected video players** — turn the per-video overlay off and on.
- **Sync completed downloads across browsers** — see the entry count and clear it.

**Native helper**

- Connection state, a per-dependency checklist, **Check again**, and a
  **Copy install command** button.

**Advanced**

- **Filter list sources** — read-only status for each list.
- **Synced history** — the entry count and a **Clear synced history** button.

The popup itself carries only per-session controls: the paste box, the search/sort/size
filter row and the per-row download button. Everything durable is in Options, which writes to
the same `qwinSettings` key, so a change there is reflected the next time the popup opens.

## Download Folder

By default, videos save under the Windows Downloads folder. Choose a custom one in Options →
Download folder → **Browse...**.

Each download is saved inside a title folder:

```text
Downloads\Video Title\Video Title [id].mp4
```

Leaving the setting blank uses the default Downloads folder.

## Download Speed

The helper uses:

- Concurrent HLS/DASH fragments via `yt-dlp --concurrent-fragments`.
- `aria2c` as the external downloader for parallel byte-range connections.
- `ffmpeg` for merging video and audio and remuxing to MP4.
- `N_m3u8DL-RE` or Streamlink as best-effort fallbacks for accessible HLS, DASH or Smooth
  Streaming manifests when `yt-dlp` cannot handle the stream.

For direct MP4/WebM downloads, `aria2c` splits the file into byte ranges, fetches them in
parallel and reassembles the output. Fast mode only helps when the origin server permits
multiple connections — see [Troubleshooting](troubleshooting.md) if downloads are slow.
