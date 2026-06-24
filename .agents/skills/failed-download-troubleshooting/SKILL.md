---
name: failed-download-troubleshooting
description: General-purpose workflow for diagnosing and fixing failed video downloads. Use when a download fails, the wrong URL was sent to backends, or a video plays in the browser but the extension can't download it.
references: tdd, browser-use
---

# Failed Download Troubleshooting

A systematic, general-purpose debugging workflow for failed video downloads. Designed to work for any site, regardless of the root cause.

---

## Core Principle

Every failed download has one of two root causes. But **check both sides** — the real issue is often a combination:

| Category | Symptom | What it means |
|----------|---------|---------------|
| **False Positive** | A non-video URL was detected as downloadable. The bad URL is what gets sent to backends. | The detection system incorrectly flagged something. Block the bad URL pattern. |
| **Incorrectly Blocked Real Stream** | The actual video plays in the browser but the extension never found its stream URL _or_ found it but blocked it. | A legit stream URL is being blocked by a filter that's too broad. Narrow the blocking pattern. |

**Both categories can coexist.** Fixing only one side (e.g., blocking the bad URL) while the real stream remains blocked leaves the user with no valid option. Always check both.

---

## Investigation Phases

### Phase 1: Gather Context

Before looking at any URLs, understand what changed and what exists:

1. **Check recent git changes** — What code was modified recently? Could a previous fix have introduced a regression?
   ```
   git log --oneline -20
   git diff HEAD~5
   ```

2. **Read the troubleshooting log** (`docs/guides/troubleshooting-log.md`) — Has this site or a similar pattern been fixed before?

3. **Read the relevant source files** — At minimum:
   - `src/shared/media_candidates.js` — The blocking regex patterns
   - `src/shared/video_filters.js` — The candidate filtering logic
   - `src/content/content.js` — Content script detection flow
   - `src/background/background.js` — Network interception handlers

4. **Check existing test fixtures** (`tests/fixtures/media_candidate_rules.json`) — What URL patterns are explicitly tested?

---

### Phase 2: Live Investigation (Browser)

Use the `browser-use` agent to investigate what actually happens on the site. This is essential because the page may load dynamic content that isn't visible from static analysis.

1. **Navigate to the failing page** and wait for full load (10+ seconds for ad-heavy / video sites)

2. **Identify video-related elements**:
   - Check for `<video>` elements in the DOM (their `src`, `currentSrc`)
   - Look for blob URLs (HLS.js / Shaka Player style)
   - Note the page title — it often contains the actual video title

3. **Capture network requests** for media streams:
   - Filter for `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.ts`, `.m4s`
   - Look for CDN subdomains (e.g., `video.example.com`, `cdn.example.com`, `stream.example.com`)
   - Note the full URL structure including query parameters and auth tokens

4. **Answer these questions**:
   - What is the actual video stream URL? (Usually a CDN URL with video extension)
   - Is the player using a blob URL? (means HLS.js / MSE — stream comes via network requests)
   - Does clicking the video produce additional network requests? (confirms the player works)
   - What Content-Type does the page itself return? (`text/html` = page, not a video)

---

### Phase 3: Trace Detection Flow

For EACH URL involved (both the bad one detected and the good one that should be detected), trace through the code:

1. **Content script detection paths** (`src/content/content.js`):
   - `scanVideoElements()` — Finds `<video>` elements and creates candidates
   - `scanPerformanceEntries()` — Scans resource load entries
   - `scanInlinePlayerScripts()` — Scans inline scripts for media URLs
   - `scanVisiblePlayerFrames()` — Detects iframe video players
   - `pageFallbackCandidateForVideo()` — Creates a "PAGE" candidate with the page URL as fallback for yt-dlp

2. **Network interception paths** (`src/background/background.js`):
   - `handleBeforeRequest()` — Catches requests before they're sent (type: xmlhttprequest, media, etc.)
   - `handleHeadersReceived()` — Catches responses with content-type headers

3. **For each detection path, ask**:
   - Would this path catch the bad URL? Why?
   - Would this path catch the real stream URL? Why not?
   - What source/format would each detection assign?
   - Would `isLikelyFullLengthVideoCandidate()` filter it out?

---

### Phase 4: Check Filter Status (Direct Testing)

Directly test the actual URLs against the blocking system to verify your understanding:

1. **Check block/allow status** for each URL:
   ```bash
   node -e "
   import('./src/shared/media_candidates.js').then(m => {
     const url = 'https://example.com/suspect-path';
     console.log('isBlockedMediaUrl:', m.isBlockedMediaUrl(url));
     console.log('isDownloadableMediaUrl:', m.isDownloadableMediaUrl(url));
     console.log('classifyMediaUrl:', m.classifyMediaUrl(url));
   });
   "
   ```

2. **Trace which regex blocks/allows** — Create a step-by-step trace of `isBlockedMediaUrl()`:
   ```bash
   node -e "
   import('./src/shared/media_candidates.js').then(m => {
     const text = 'https://example.com/suspect-path'.toLowerCase();
     const checks = [
       ['STATIC_PAGE_ASSET_RE', /\\/(?:stylesheet|theme-color|...)/i],
       ['STATIC_PLAYER_ASSET_RE', /\\.(?:hlsjs|js|css|map)(?:$|[?#])/i],
       ['SEGMENT_EXTENSION_RE', /\\.(ts|mp2t|m4s|cmfv|cmfa)(?:$|[?#])/i],
       ['VIDEO_HOSTING_SITES_RE', /(?:^|[\\/.])(?:flashx|thevideo|...)/i],
       // ... list each pattern from isBlockedMediaUrl in order
     ];
     for (const [name, re] of checks) {
       if (re.test(text)) console.log('BLOCKED by:', name);
     }
   });
   ```

3. **Key insight**: Trace BOTH URLs — the bad one (to confirm it's not blocked when it should be) AND the real stream (to check if it's incorrectly blocked). A real stream being blocked by an overbroad pattern is a common hidden bug.

4. **Common over-blocking patterns to watch for**:
   - `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` — Can incorrectly block legitimate `.m3u8`/`.mpd` manifests that contain numeric video IDs
   - `SEGMENT_NAME_RE` — Can match legitimate filenames that happen to contain "seg" or "chunk"
   - `STREAMING_PAGE_HOST_RE` / `VIDEO_HOSTING_SITES_RE` — Must check `!VIDEO_EXTENSION_RE.test(text)` to allow CDN streams through

---

### Phase 5: Apply TDD (Test-Driven Fixing)

Once you understand exactly which patterns need changing, follow TDD:

**RED — Write failing test(s):**

Add entries to `tests/fixtures/media_candidate_rules.json`:

```json
{
  "name": "description of the URL",
  "url": "https://actual-url-to-test",
  "contentType": "",
  "format": "EXPECTED_FORMAT",
  "blocked": true,
  "downloadable": false,
  "reusable": false
}
```

Always add fixtures for ALL affected URLs:
- The bad URL → expect `blocked: true`
- The real stream URL → expect `blocked: false`
- Key regression URLs → expect their existing behavior is preserved

Run the test to confirm it **fails** before fixing:
```
node tests/extension/shared/test_video_filters.js
```

**GREEN — Fix production code:**

Edit `src/shared/media_candidates.js` to:
1. Add new blocking pattern for the false positive
2. Fix any overbroad pattern that's blocking real streams (narrow the condition)

Run the test again to confirm it **passes**.

**REFACTOR — Verify no regressions:**

Run comprehensive checks:
```
node tests/extension/shared/test_video_filters.js
```

Also run direct verification of all existing patterns still work:
```bash
node -e "
import('./src/shared/media_candidates.js').then(m => {
  // Known-good URLs should still pass
  console.log('stream.m3u8:', m.isBlockedMediaUrl('https://cdn.example.com/stream.m3u8'));  // false
  
  // Known-bad URLs should still be blocked
  console.log('segment.ts:', m.isBlockedMediaUrl('https://cdn.example.com/seg-001.ts'));  // true
  console.log('ad.mp4:', m.isBlockedMediaUrl('https://ads.example.com/preroll.mp4'));  // true
  
  // Video hosting page URLs without extension should be blocked
  console.log('vidfast page:', m.isBlockedMediaUrl('https://vidfast.pro/some-video'));  // true
  
  // CDN streams from video hosting sites should NOT be blocked
  console.log('vidfast m3u8:', m.isBlockedMediaUrl('https://cdn.vidfast.pro/stream.m3u8'));  // false
});
```

---

## Decision Tree

```
User reports "download failed / wrong video"
│
├─ Phase 1: Gather context
│  └─ git log, troubleshooting log, source files, existing test fixtures
│
├─ Phase 2: Live browser investigation
│  └─ Navigate to site, identify video elements, capture stream URLs
│
├─ Phase 3: Trace detection flow
│  └─ For each URL, trace through content script + network interception paths
│
├─ Phase 4: Check filter status (direct testing)
│  ├─ is the bad URL incorrectly not blocked?  → need to add block pattern
│  ├─ is the real stream incorrectly blocked?  → need to narrow existing pattern
│  └─ BOTH? → fix both (the most common scenario)
│
└─ Phase 5: Apply TDD
   ├─ RED: Add test fixtures, confirm they fail
   ├─ GREEN: Fix media_candidates.js, confirm they pass
   └─ REFACTOR: Verify no regressions, check all existing patterns
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
| Video hosting page URLs | Page URLs from sites like flashx, vidoza, beeg without video extension | `VIDEO_HOSTING_SITES_RE` |
| Numbered media fragments | Long numeric IDs + `.mp4` extension in HLS/DASH context (can over-block manifests) | `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` |

## Common Over-Blocking Traps

These patterns often catch legitimate stream URLs. When fixing, always check if they're too broad:

| Trap | Why it over-blocks | How to narrow |
|------|-------------------|---------------|
| `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` | `.m3u8`/`.mpd` manifests with numeric video IDs trigger both conditions | Add `!HLS_RE.test(text) && !DASH_RE.test(text)` to exclude manifests |
| `SEGMENT_NAME_RE` | Legitimate filenames containing "seg", "chunk", "part" get blocked | Check that the match is actually a numeric segment pattern, not just a keyword |
| Domain-level host blocking | Subdomain CDN URLs (`video.example.com`) match the same domain regex as page URLs (`example.com`) | Always add `!VIDEO_EXTENSION_RE.test(text)` to allow CDN streams with `.m3u8`/`.mp4` extensions |

---

## Related Skills

- [`tdd`](../tdd/SKILL.md) — Test-driven development for RED→GREEN workflow
- [`browser-use`](../../tools.md) — Browser automation for live site investigation
- [`systematic-debugging`](../systematic-debugging/SKILL.md) — Root cause investigation before fixing
- [`docs/guides/troubleshooting-log.md`](../../../docs/guides/troubleshooting-log.md) — Record of past fixes with root causes and patterns
