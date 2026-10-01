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
- Real YouTube video pages from the visible YouTube player. Qwin sends the YouTube watch/embed/shorts/live page URL to `yt-dlp`, then the helper saves the selected version as MP4.
- Manual video page links pasted in settings. This is a fallback for extractor-supported sites such as YouTube, Instagram, TikTok, X, Threads, and other URLs the helper tools can access.
- Video titles from page metadata, video element labels, `yt-dlp` metadata, or filename fallback.

The extension filters obvious ad/tracker media URLs, GIF/GIFV previews, common GIF-preview hosts such as Giphy and Tenor, tiny hidden media, short muted looping autoplay clips, and HLS/DASH fragment URLs such as `.ts`, `.m4s`, `segment-*`, `chunk-*`, and `frag-*`. Download the M3U8/MPD playlist or master URL, not individual segment URLs.

## uBlock Origin Filter Integration

Qwin integrates with uBlock Origin's community-maintained filter lists to improve ad URL blocking and video CDN whitelisting.

### How It Works

1. **At startup**, the extension loads cached filter patterns from `chrome.storage.local`.
2. **Exception domains** from filter lists (especially uBO's Unbreak list) are applied to `isBlockedMediaUrlWithExceptions()` — URLs from known video CDNs that match ad patterns are unblocked.
3. **Every 5 days**, the extension downloads fresh filter lists from uBO's GitHub repository and EasyList/EasyPrivacy and extracts video-relevant domain patterns.
4. **Ad domains** discovered from filter lists are added to the blocking set alongside the built-in `AD_RE` regex.

### Supported Filter Lists

| List | URL | Refresh |
|---|---|---|
| uBlock filters | `filters.txt` | 5 days |
| uBlock Unbreak | `unbreak.txt` | 5 days |
| uBlock Resource abuse | `resource-abuse.txt` | 5 days |
| uBlock Privacy | `privacy.txt` | 5 days |
| EasyList | `easylist.txt` | 1 day |
| EasyPrivacy | `easyprivacy.txt` | 1 day |

The **Unbreak** list is the most valuable — it contains exception rules that restore video player functionality on sites where aggressive blocking would break playback.

### Exception-Aware Blocking

When a URL matches both ad patterns and an exception domain (e.g., `akamaihd.net` is both a known ad CDN but also essential for streaming), the exception takes priority. This prevents false positives on legitimate video CDNs.

### Recompiling Patterns

If patterns are empty at startup (first install), the extension triggers an immediate refresh so filter-based exceptions are available right away.

## CDP-Based Video Extraction

Qwin uses Chrome DevTools Protocol (CDP) to extract video sources from players that don't expose them through standard DOM or network APIs.

### Extraction Methods

1. **Runtime.evaluate** — Executes JavaScript in the page context to find video elements, sources, and player configurations.
2. **Network instrumentation** — Captures license exchanges for key extraction.

## TLS Impersonation with curl_cffi

Qwin uses the [`curl_cffi`](https://github.com/yifeikong/curl_cffi) Python library to **impersonate real web browsers' TLS/SSL and HTTP/2 fingerprints**. This helps bypass Cloudflare, Akamai, and other WAF/CDN bot-detection systems that would otherwise block standard HTTP clients (like Python's `urllib` or raw `curl`).

### How It Works

When `curl_cffi` makes an HTTPS request, it mimics the exact TLS handshake characteristics of a real browser:

- **Cipher suites** — matches Chrome's supported cipher list
- **TLS extensions** — order and values match Chrome's actual negotiation
- **HTTP/2 frames** — SETTINGS, WINDOW_UPDATE, and priority framing match browser behavior
- **User-Agent** — automatically sent with the correct browser version string

The result: the remote server sees a connection that looks identical to one from a real Chrome browser.

### Two Levels of Integration

curl_cffi is integrated at **two levels** in the native host:

#### 1. Inside yt-dlp (primary path)

Every yt-dlp command includes `--extractor-args generic:impersonate`, which tells yt-dlp to use its bundled curl_cffi for TLS impersonation when extracting from generic/unknown sites. This is the **primary download path** — most downloads go through yt-dlp + aria2c with impersonation active.

```python
# src/native_host/yt_dlp_command.py
GENERIC_EXTRACTOR_ARGS = "generic:impersonate"
# Applied to every yt-dlp command:
command.extend(["--extractor-args", "generic:impersonate"])
```

#### 2. Standalone adapter (fallback path)

If yt-dlp fails entirely (site not supported, extraction error, etc.), a standalone `curl_cffi_adapter.py` module tries a direct HTTP download with full Chrome TLS impersonation. This catches URLs that yt-dlp's generic extractor cannot parse but that are accessible via direct download.

```
Primary:   yt-dlp + aria2c + impersonation (via --extractor-args generic:impersonate)
               │
               ▼ (if yt-dlp fails)
Fallback:  curl_cffi direct download (standalone adapter, impersonate="chrome")
               │
               ▼ (if curl_cffi fails)
More:      yt-dlp variants (no SSL, geo bypass, no impersonate, max retries, etc.)
```

### Download Flow with Impersonation

```
Media URL from extension
         │
         ├── YouTube?                   ──→ yt-dlp dedicated extractor (YouTube's own TLS)
         ├── HLS/DASH manifest (.m3u8, .mpd)? → N_m3u8DL-RE or Streamlink
         ├── Magnet link / .torrent?    ──→ aria2c BitTorrent engine
         └── Direct media URL (.mp4, .webm, etc.)
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
  yt-dlp + aria2c      yt-dlp + aria2c
  impersonation ON     impersonation ON
  (generic:impersonate)
         │
         ▼ (if primary fails)
  curl_cffi direct download
  impersonate="chrome"
         │
         ▼ (if curl_cffi fails)
  yt-dlp fallback variants
  (no SSL, geo bypass,
   no impersonate, retries,
   generic extractor, throttle detect)
```

### When curl_cffi Is Skipped

| URL Type | curl_cffi Used? | Reason |
|---|---|---|
| Direct `.mp4` / `.webm` / `.mkv` | **Yes** (standalone fallback) | Streams to disk with full browser impersonation |
| `.m3u8` (HLS) | **No** (standalone) | Needs specialized HLS downloader (N_m3u8DL-RE / ffmpeg) — yt-dlp handles it |
| `.mpd` (DASH) | **No** (standalone) | Needs specialized DASH downloader |
| YouTube | **No** (standalone) | yt-dlp has dedicated extractor + fine-grained format selection |
| Generic video page | **Yes** (inside yt-dlp) | yt-dlp's generic extractor uses `--extractor-args generic:impersonate` |
| Magnet / torrent | **No** | BitTorrent protocol, not HTTP |
| CDN behind Cloudflare | **Yes** | Primary use case — bypasses TLS fingerprint blocking |

### Verifying curl_cffi Is Working

The installer checks that curl_cffi is importable:
```
Verifying curl_cffi impersonation library...
curl_cffi version: <version>
```

If curl_cffi is missing, the installer shows a warning and the standalone fallback degrades to standard HTTP (less effective behind WAFs). The in-yt-dlp path also degrades but may still work for sites yt-dlp supports natively.

### Verifying with Live TLS Fingerprint

You can manually verify that curl_cffi is sending browser-matching fingerprints:

```bash
python -c "
from curl_cffi import requests
r = requests.get('https://tls.browserleaks.com/json', impersonate='chrome')
data = r.json()
print('JA3:', data.get('ja3_hash'))
print('User-Agent:', data.get('user_agent'))
"
```

Expected output:
```
JA3: <32-char hex string>
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ... Chrome/146...
```

The impersonated fingerprint will differ from standard curl's fingerprint (confirmed by running without `impersonate="chrome"`).

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
