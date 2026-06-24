# Download Log Notes

Document errors, their root causes, fixes, and patterns to follow when troubleshooting failed downloads.

---

## beeg.com — Page URL Detected as Downloadable Video (Fragmented Stream Check Blocking HLS)

### Symptoms
- Navigating to `https://beeg.com/-0527563087766924` (or similar beeg video page)
- Extension shows the page URL as a downloadable option
- Download fails or downloads the wrong content
- The actual HLS stream from `video.beeg.com` CDN does not appear in the detected list
- yt-dlp gets the page URL instead of the direct HLS stream URL

### Root Cause (Double Bug)

**Bug 1 — beeg.com page URL not blocked:**
- `https://beeg.com/-0527563087766924` has no video file extension
- It was not blocked by any existing false-positive filter (`STATIC_PAGE_ASSET_RE`, `AD_RE`, etc.)
- The `pageFallbackCandidateForVideo` function in the content script created a downloadable "PAGE"-format candidate with the page URL
- This competed with (or appeared instead of) the actual HLS stream URL in the popup

**Bug 2 — video.beeg.com HLS stream incorrectly blocked as fragment:**
- The HLS manifest URL from `video.beeg.com` CDN ends in `.m3u8` but contains a long numeric video ID followed by `.mp4` (e.g., `/527563087766924.mp4.m3u8`)
- `FRAGMENTED_STREAM_CONTEXT_RE` matched `.m3u8` at the end of the URL
- `NUMBERED_MEDIA_FRAGMENT_RE` matched `/527563087766924.mp4`
- The combination blocked the legitimate HLS manifest as a "numbered media fragment"

### Fix
**File**: `src/shared/media_candidates.js`

1. **Added `beeg` to `VIDEO_HOSTING_SITES_RE`** (line originally ~23):
   - Added `beeg` to the site list and `com` to the TLD list
   - beeg.com page URLs without video extensions are now blocked
   - `video.beeg.com` HLS/CDN URLs with `.m3u8` extension still pass through (condition checks `!VIDEO_EXTENSION_RE.test(text)`)

2. **Added `!HLS_RE.test(text) && !DASH_RE.test(text)` to the fragment check** (line originally ~194):
   - The condition `FRAGMENTED_STREAM_CONTEXT_RE.test(text) && NUMBERED_MEDIA_FRAGMENT_RE.test(text)` previously blocked any URL that matched both patterns
   - Added exclusion for `.m3u8` and `.mpd` manifest URLs, which are not media fragments
   - Actual segment/fragment URLs (`.ts`, `.m4s`, `.cmfv`, etc.) are still caught by `SEGMENT_EXTENSION_RE`

**File**: `tests/fixtures/media_candidate_rules.json`
- Added test fixture: `beeg.com/-0527563087766924` → `blocked: true`
- Added test fixture: `video.beeg.com/.../527563087766924.mp4.m3u8` → `blocked: false`

### Verification
- ✅ `beeg.com/-0527563087766924` → blocked
- ✅ `video.beeg.com/.../527563087766924.mp4.m3u8` → not blocked (classified as M3U8)
- ✅ `cdn.example.com/hls/000012.mp4?token=abc` → still blocked (real fragment)
- ✅ `cdn.example.com/hls/segment-00001.ts` → still blocked (segment extension)
- ✅ `cdn.example.com/dash/chunk-42.m4s` → still blocked (segment extension)
- ✅ `cdn.example.com/movie.mp4` → not blocked (legitimate video)
- ✅ `cdn.example.com/stream.m3u8` → not blocked (legitimate manifest)
- ✅ `vidfast.pro/some-video` → still blocked (existing pattern)
- ✅ `flashx.pw/video/12345` → still blocked (existing pattern)
- ✅ All `node tests/extension/shared/test_video_filters.js` tests pass

### Pattern for Future Fixes
When a video hosting site's page URL is being detected as a downloadable video, but the actual stream comes from a CDN subdomain with video extensions:
1. Add the site domain to `VIDEO_HOSTING_SITES_RE` in `src/shared/media_candidates.js`
2. Verify CDN subdomain URLs (with `.m3u8`, `.mpd`, `.mp4` extensions) still pass through
3. Add test fixtures to `tests/fixtures/media_candidate_rules.json` for both blocked and allowed URLs
4. Run `node tests/extension/shared/test_video_filters.js` to verify

---

## beeg.com — CSS Property Name False Positives

### Symptoms
- Downloads initiated with URLs like `https://beeg.com/X-UA-Compatible` or `https://beeg.com/overflow-y-hidden`
- All 10 fallback backends exhausted (yt-dlp, N_m3u8DL-RE, Streamlink, gallery-dl)
- yt-dlp error: `ERROR: Unsupported URL: https://****.com/...`
- gallery-dl additionally crashed with `ModuleNotFoundError: No module named 'certifi'` (fixed separately)

### Root Cause
- beeg.com uses CSS-property-name-like strings (`X-UA-Compatible`, `overflow-y-hidden`, `stylesheet`, `theme-color`) as internal page routes / API paths
- These paths appear in script/performance data and were incorrectly classified as video URLs
- They bypassed the URL block filters and were sent to download backends

### Fix
**File**: `src/shared/media_candidates.js`
- Added `X-UA-Compatible` and `overflow-y-hidden` to `STATIC_PAGE_ASSET_RE` regex
- These join existing blocked patterns: `stylesheet`, `theme-color`, `browserconfig`

**File**: `tests/fixtures/media_candidate_rules.json`
- Added test fixtures expecting these URLs to be blocked (`blocked: true`)

### Verification
- ✅ `beeg.com/X-UA-Compatible` → blocked
- ✅ `beeg.com/overflow-y-hidden` → blocked
- ✅ `beeg.com/manifest.webm` → still blocked (existing)
- ✅ `video.beeg.com/hls/stream-123.m3u8` → still detectable as M3U8 (not blocked)

### Pattern for Future Fixes
When investigating failed downloads, follow this workflow (see also `.agents/skills/failed-download-troubleshooting/SKILL.md` for the full skill):

1. **Read the log** (`logs/downloads.jsonl`) — check the `url` field for suspicious paths
2. **Classify the URL** — run `classifyMediaUrl()` to see what format the URL would be
3. **Apply TDD** (skill: `tdd`):
   - RED: add test fixture entry expecting `blocked: true`
   - GREEN: update `STATIC_PAGE_ASSET_RE` or equivalent in `src/shared/media_candidates.js`
4. **Verify the fix doesn't break real streams** — use `browser-use` agent to navigate to the actual site and confirm real HLS/DASH streams are still detected
5. **Run tests** — `node tests/extension/test_video_filters.js` and `node tests/extension/test_cdp_video_integration.js`
6. **Check gallery-dl** — if it reports `ModuleNotFoundError: No module named 'certifi'`, run `python -m pip install certifi`

---

## gallery-dl — Missing certifi Module

### Symptoms
- gallery-dl (last fallback backend) crashes with `ModuleNotFoundError: No module named 'certifi'`
- Traceback shows import chain: `gallery-dl → requests → certifi`

### Fix
```
python -m pip install certifi
```
Installed `certifi` v2026.6.17. Verified: `gallery-dl --version` returns `1.32.3` without errors.

### Pattern
When gallery-dl fails in any download log, first check if `certifi` is installed. This is a common Python packaging issue.
