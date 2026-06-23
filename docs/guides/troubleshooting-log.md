# Download Log Notes

Document errors, their root causes, fixes, and patterns to follow when troubleshooting failed downloads.

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
- ✅ **Browser automation** (browser-use agent) navigated to beeg.com, clicked a video, confirmed HLS streams load from `video.beeg.com` CDN with no console errors

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
