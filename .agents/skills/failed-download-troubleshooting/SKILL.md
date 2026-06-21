---
name: failed-download-troubleshooting
description: General-purpose workflow for diagnosing and fixing failed video downloads. Use when a download fails, the wrong URL was sent to backends, or a video plays in the browser but the extension can't download it.
references: tdd, browser-use
---

# Failed Download Troubleshooting

A systematic, general-purpose debugging workflow for failed video downloads. Designed to work for any site, regardless of the root cause.

---

## Core Principle

Every failed download has one of two root causes. Determine which one before fixing anything:

| Category | Symptom | What it means |
|----------|---------|---------------|
| **False Positive** | The URL sent to backends is not a real stream — it's a page route, API endpoint, meta tag path, ad URL, or static asset | The detection system incorrectly flagged something as a video. Block the bad URL pattern. |
| **Missing Real Stream** | The actual video plays in the browser but the extension never found its stream URL | The detection system missed the real video. Add a new detection path or improve an existing one. |

---

## Workflow

### Step 1: Read the Download Log

Open `logs/downloads.jsonl`. Find the failed download (search for `DOWNLOAD_ERROR` or `ATTEMPT_END` with `exitCode` ≠ 0).

Look at these fields in the `DOWNLOAD_INIT` event:

- **`url`** — The URL that was sent to backends. Is this something a video player would request?
- **`pageUrl`** — Which page was the user on when this was detected?
- **`format`** — What format did the detection system assign? (M3U8, MP4, etc.)

Then check the `ATTEMPT_END` events for the backend error message.

**Red flags in the URL:**

- No video file extension (`.mp4`, `.m3u8`, `.mpd`, `.webm`)
- Looks like a page route, not a media asset (single path segment, no extension)
- Matches common non-video patterns: meta tags, HTTP headers, CSS properties, ad networks, font files, web manifests
- Very short or random-looking path segments
- Relative-looking paths that got resolved to the site domain

### Step 2: Classify the URL

Check what the server actually returns for the suspicious URL:

```
curl -sI "https://suspicious-site.com/bad-path"
```

Look at the response:
- **`Content-Type: text/html`** — It's an HTML page, not a video. False positive.
- **`Content-Type: application/json`** — It's an API response. False positive.
- **`Content-Type: video/mp4` or `application/x-mpegURL`** — It returns video content, but the backend can't handle it. Could be either category.

### Step 3: Determine the Detection Path

The extension detects video URLs through several paths. Different detection paths have access to different information:

1. **Network request interception** (`onBeforeRequest`) — Fires before the request. No content-type available. Only checks URL patterns and resource type.
2. **Network response interception** (`onHeadersReceived`) — Fires after the response. Has content-type. Can block `text/html`, `image/*`, `font/*`, etc.
3. **Content script scanning** — Scans performance entries and inline scripts for URLs. No content-type info available. Relies purely on URL pattern matching.
4. **DOM video element detection** — Finds `<video>` tags on the page. Has width, height, duration.
5. **CDP extraction** — Injects JavaScript via DevTools Protocol to extract video sources from the page context.

To find which path caught a bad URL:
- If it has a video extension → likely #1 or #2
- If it has no video extension but appears in the list → likely #3
- If it's a `<video>` element URL → likely #4

### Step 4: Fix False Positives

If the URL is not a real video:

1. **Categorize the URL pattern** — What type of non-video content is it?
   - Single-word page routes (meta tags, HTTP headers, CSS properties) → `STATIC_PAGE_ASSET_RE`
   - Player JavaScript/CSS assets (`.js`, `.css`, `.hlsjs`, `.map`) → `STATIC_PLAYER_ASSET_RE`
   - Web app manifests (`.webmanifest`, `manifest.json`) → `WEB_APP_MANIFEST_RE`
   - Ad networks (doubleclick, googleads, imasdk, preroll, etc.) → `AD_RE`
   - Stream segments (`.ts`, `.m4s`, `segment-00001`) → `SEGMENT_EXTENSION_RE`
   - GIF-style clips (giphy, tenor, animated-gif, loop-preview) → `GIF_VIDEO_RE`

2. **Add the pattern to the appropriate regex** in `src/shared/media_candidates.js`

3. **Apply TDD** (skill: `tdd`):
   - Add a test fixture to `tests/fixtures/media_candidate_rules.json` with `blocked: true`
   - Run `node tests/extension/test_video_filters.js` (it should pass after the fix)
   - Run `npm run build` to rebuild the extension

### Step 5: Fix Missing Real Streams

If the real video plays in the browser but the extension never detected it:

1. **Open DevTools → Network tab** on the actual site
2. **Filter for video types**: `.m3u8`, `.mpd`, `.mp4`, `.webm`
3. **Check how the video is served**:
   - Direct URL with extension → The network interceptors should catch it. Check why they missed it.
   - Blob URL (e.g., `blob:https://...`) → The player uses MediaSource Extensions (MSE). The `media_source_intercept.js` module handles this.
   - Encrypted (Widevine DRM) → Needs the CDM pipeline (cdm_network_intercept + Go binary for key extraction + decryption). This is a deeper integration, not a quick fix.
   - Embedded in JavaScript data → May need CDP Extraction (cdp_extraction.js) to pull the URL from the page's JS context.

4. **For each case**:
   - Direct URL: Check if `handleBeforeRequest` or `handleHeadersReceived` filters it. Maybe the regex needs updating.
   - Blob/MSE: Verify `media_source_intercept.js` is intercepting the source buffer. Check the content script is running on the page.
   - CDP extraction: Try running the CDP extraction flow from the popup to see if the video is found.

### Step 6: Verify

1. **Run the unit tests**:
   ```
   node tests/extension/test_video_filters.js
   ```
2. **Rebuild the extension**:
   ```
   npm run build
   ```
3. **Replay the actual error from the log** — Before declaring the fix done, test that your retry/regex changes work against the **exact error message** from the log. Extract the error text from the `ATTEMPT_END` event and run it through the relevant regex or function:
   ```
   node -e "
   const re = /Unsupported URL|did not find any downloadable video formats|No video formats|ConnectionResetError|TransportError|.../i;
   const error = process.argv[1];
   console.log('Match:', re.test(error));
   " "$(cat logs/downloads.jsonl | python -c "import sys,json; lines=[l for l in sys.stdin if l.strip()]; last=json.loads(lines[-1]); print(last.get('output',''))")
   ```
   If it returns `false`, the fix is incomplete — go back and adjust.
4. **Reload the extension** in the browser (`chrome://extensions` → reload)
5. **Visit the site** and confirm:
   - The bad URL no longer appears in the detected list
   - The real video stream still appears (if it was working before)
6. **Browser automation** (skill: `browser-use`): Use the browser agent to navigate to the site, verify no console errors, and confirm real streams load.

---

## Decision Tree

```
Log shows failed download
│
├─ URL has no video extension AND server returns text/html/application/json
│  └─ FALSE POSITIVE → Add URL pattern to block regex
│
├─ URL has no video extension AND server returns video content-type
│  └─ Check if this is an API endpoint that happens to serve video
│     ├─ If it's an internal API route → FALSE POSITIVE → block the URL pattern
│     └─ If it's an actual stream URL → improve detection to catch its extension
│
├─ URL has video extension but backend says "Unsupported URL"
│  └─ The URL structure is valid but the backend can't navigate the site → may need yt-dlp extractor args or site-specific handling
│
└─ No URL was sent to backend (no DOWNLOAD_INIT in log)
   └─ MISSING REAL STREAM → find the actual stream URL via DevTools Network tab
```

---

## Common False Positive Patterns (Reference)

| Category | What they look like | Block regex |
|----------|-------------------|-------------|
| Meta tag / HTTP header values | Single path segment like `/theme-color`, `/X-UA-Compatible` | `STATIC_PAGE_ASSET_RE` |
| Player static assets | `provider.hlsjs`, `bundle.js`, `styles.css` | `STATIC_PLAYER_ASSET_RE` |
| Web app manifests | `manifest.webm`, `manifest.json`, `.webmanifest` | `WEB_APP_MANIFEST_RE` |
| Ad / tracking URLs | `doubleclick.net`, `googleads`, `imasdk`, `preroll` | `AD_RE` |
| Stream segments | `segment-00001.ts`, `chunk-42.m4s` | `SEGMENT_EXTENSION_RE` |
| GIF / short clips | `giphy`, `tenor`, `animated-gif`, `loop-preview` | `GIF_VIDEO_RE` |
| CDN ephemeral tokens | `googlevideo.com/videoplayback?range=0-1000` | `isEphemeralMediaUrl()` |

---

## Related Skills

- [`tdd`](../tdd/SKILL.md) — Test-driven development for RED→GREEN workflow
- [`browser-use`](../../tools.md) — Browser automation for verifying real streams
