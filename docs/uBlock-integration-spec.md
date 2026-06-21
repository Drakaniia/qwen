# uBlock Origin Integration Specification

**Status:** Draft — Proposal for review  
**Target:** Qwin Video Downloader video detection & ad filtering  
**Approach:** Two-phase: (1) Filter lists as data sources, (2) Borrowed regex patterns

---

## Table of Contents

1. [Overview](#overview)
2. [Phase A — Regex Pattern Borrowing (Approach 2)](#phase-a--regex-pattern-borrowing-approach-2)
   - [A.1 AD_RE enhancements](#a1-ad_re-enhancements)
   - [A.2 CDN_HINT_RE enhancements](#a2-cdn_hint_re-enhancements)
   - [A.3 New streaming platform patterns](#a3-new-streaming-platform-patterns)
   - [A.4 STATIC_ASSET_* refinements](#a4-static_asset_-refinements)
   - [A.5 New video player SDK patterns](#a5-new-video-player-sdk-patterns)
   - [A.6 P2P / Chinese streaming patterns](#a6-p2p--chinese-streaming-patterns)
3. [Phase B — Filter List Data Sources (Approach 1)](#phase-b--filter-list-data-sources-approach-1)
   - [B.1 Filter list URLs & description](#b1-filter-list-urls--description)
   - [B.2 Architecture: filter list loader module](#b2-architecture-filter-list-loader-module)
   - [B.3 Filter syntax parser design](#b3-filter-syntax-parser-design)
   - [B.4 Storage and cache strategy](#b4-storage-and-cache-strategy)
   - [B.5 Exception pattern extraction](#b5-exception-pattern-extraction)
4. [Implementation Priority Matrix](#implementation-priority-matrix)
5. [Testing Strategy](#testing-strategy)
6. [Appendix A — Full list of uBO exception patterns relevant to video](#appendix-a--full-list-of-ubo-exception-patterns-relevant-to-video)
7. [Appendix B — Source filter list URLs](#appendix-b--source-filter-list-urls)
8. [Appendix C — Glossary of filter syntax](#appendix-c--glossary-of-filter-syntax)

---

## Overview

Qwin Video Downloader already uses regex-based URL classification in:

- `src/shared/media_candidates.js` — Core URL blocking/classification patterns
- `src/shared/video_filters.js` — Video quality detection and filtering
- `src/native-host/media_candidates.py` — Python mirror of the JS patterns

These patterns have been hand-curated and cover the most common cases. However, uBlock Origin (uBO) is the gold standard for URL-based content classification, with **10+ years of community-maintained filter lists** covering hundreds of thousands of ad servers, tracking domains, CDNs, and streaming platforms.

This spec documents two approaches:

- **Phase A (Approach 2):** Borrow specific regex patterns from uBO's source and filter lists to enhance Qwin's existing detection with minimal code changes.
- **Phase B (Approach 1):** Download and parse uBO's filter lists as an external data source at runtime, feeding domain patterns into Qwin's URL classification pipeline.

---

## Phase A — Regex Pattern Borrowing (Approach 2)

### A.1 AD_RE Enhancements

**Current pattern** (`src/shared/media_candidates.js`):

```js
const AD_RE =
  /(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|\/ads?\/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola)/i;
```

**Missing patterns discovered from uBO's filter lists** (source: `filters.txt`, `unbreak.txt`):

| Domain | Context from uBO | Priority |
|---|---|---|
| `adnxs` | AppNexus programmatic ad exchange | High |
| `clmbtech` | Ad tech platform (`||static.clmbtech.com^$script,important`) | High |
| `crwdcntrl` | Crowd Control ad platform | Medium |
| `chartbeat` | Real-time analytics (often video ad tracking) | Medium |
| `adobedtm` | Adobe Dynamic Tag Manager (privacy/blocked by EasyPrivacy) | High |
| `ensighten` | Tag manager platform (blocked by EasyPrivacy) | Medium |
| `fwmrm\.net` | FreeWheel ad decisioning framework (video ad framework) | High |
| `spotx(?:cdn)?\.(?:tv|com)` | SpotX video ad marketplace | Medium |
| `smartclip` | Smartclip ad delivery platform | Medium |
| `adaptv\.advertising` | Adap.tv video ad platform | Medium |
| `2mdn\.net` | Google/DoubleClick video ad serving | High |
| `youbora(?:nqs01)?\.com` | NPAW/Youbora analytics (often on video sites) | Medium |
| `popads\.net` | Popunder ad network | High |

**Proposed new AD_RE** `(src/shared/media_candidates.js)`:

```js
const AD_RE = /(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|\/ads?\/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola|adnxs|clmbtech|crwdcntrl|chartbeat|adobedtm|ensighten|fwmrm\.net|spotx(?:cdn)?\.(?:tv|com)|smartclip|adaptv\.advertising|2mdn\.net|youbora(?:nqs01)?\.com|popads\.net)/i;
```

---

### A.2 CDN_HINT_RE Enhancements

**Current pattern** (`src/shared/media_candidates.js`):

```js
const CDN_HINT_RE =
  /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey)/i;
```

**CDN patterns from uBO's unbreak lists** — these are **proven video-serving CDNs** that are essential for playback:

| Pattern | Source context | Type |
|---|---|---|
| `edgesuite` | `@@||analytics.edgesuite.net/html5/akamaihtml5-min.js` — Akamai HTML5 player | Akamai video framework |
| `msavideo` | `||msavideo-a.akamaihd.net^$media,redirect=noopmp3-0.1s,domain=msn.com` | MSN video |
| `hdliveextra` | `@@||hdliveextra-a.akamaihd.net^$domain=nbcsports.com` | NBC Sports streaming |
| `espncdn` | `@@||espncdn.com/redesign/*/js/espn-analytics.js$script,domain=espn.com` | ESPN CDN |
| `turner\.com` | `@@||cdn.turner.com/cnn/van/resources/*` | CNN/Turner video |
| `cbsistatic` / `cbsnews` | `@@||cbsistatic.com/*/comscore.streaming.$script,domain=cbsnews.com` | CBS video |
| `gotraffic` | `@@||cdn.gotraffic.net^$domain=bloomberg.*` | Bloomberg video |
| `litix\.io` | `||src.litix.io/core/*/mux.js$script,redirect=noopjs` | Mux video platform |
| `ooyala` | `||player.ooyala.com/*/analytics-plugin/$script,redirect=noopjs` | Ooyala player |
| `jwpcdn` | `||p.jwpcdn.com/*/vast.js$script,important` | JW Player CDN |
| `streamroot` | `||cdn.streamroot.io/dna-client/$script` | P2P video delivery |
| `msstatic` | `||msstatic.com/huya/*/p2plib.js$script` | Chinese streaming CDN |
| `douyucdn` | `||douyucdn.cn/front-publish/stream-sdk*$script,domain=douyu.com` | Douyu streaming |
| `qbrick` | `@@||play2.qbrick.com/framework/modules/analytics/analytics.min.js$script` | Qbrick platform |
| `embed-cdn` | `||v.embed-cdn.com/v8/player.js$script,domain=streamable.com` | Streamable |
| `flashx` / `vidoza` | `*$csp=worker-src 'none',domain=flashx.pw|vidoza.net` | Video streaming hosts |

**Proposed new CDN_HINT_RE** `(src/shared/media_candidates.js)`:

```js
const CDN_HINT_RE = /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey|edgesuite|msavideo|hdliveextra|espncdn|turner\.com|cbsistatic|cbsnews|gotraffic|litix\.io|ooyala|jwpcdn|streamroot|msstatic|douyucdn|qbrick|embed-cdn|flashx|vidoza)/i;
```

---

### A.3 New Streaming Platform Patterns

**Current** (`src/shared/media_candidates.js`):

```js
const STREAMING_PAGE_HOST_RE = /(?:^|[/.])vidfast\.pro(?:$|[/?#])/i;
const EMBED_PLAYER_HOST_RE = /(?:^|[/.])player\.hanime\.tv(?:$|[/?#])/i;
```

**Proposed additions:**

```js
// Video hosting sites whose page URLs are not real yt-dlp sources
const VIDEO_HOSTING_SITES_RE = /(?:^|[\/.])(?:flashx|thevideo|hdvid|vidoza|powvideo|vidtech|streamplay|fileone)\.(?:pw|tv|to|net|pro)(?:$|[\/?#])/i;

// P2P streaming platforms (Chinese streaming — douyu, huya, bilibili)
const P2P_STREAMING_HOSTS_RE = /(?:^|[\/.])(?:douyu|huya)\.(?:com|cn)(?:$|[\/?#])/i;

// Streaming platforms whose page URLs are not video sources
const LIVE_STREAMING_HOSTS_RE = /(?:^|[\/.])(?:twitch|trovo|dlive|kick)\.(?:tv|com)(?:$|[\/?#])/i;
```

**Note:** These are for blocking **page URLs** from being treated as direct video sources. Actual stream URLs from their CDNs should still pass through. The `VIDEO_EXTENSION_RE` check ensures CDN stream URLs with `.m3u8`, `.mpd`, `.ts` etc. are not blocked.

---

### A.4 STATIC_ASSET_* Refinements

**Current patterns** (`src/shared/media_candidates.js`):

```js
const STATIC_PLAYER_ASSET_RE = /\\.(?:hlsjs|js|mjs|cjs|css|map)(?:$|[?#])/i;
const STATIC_PAGE_ASSET_RE = /\\/(?:stylesheet|theme-color|browserconfig|X-UA-Compatible|overflow-y-hidden)(?:$|[?#])/i;
```

**Issues found:** The current `STATIC_PLAYER_ASSET_RE` is too aggressive — it blocks all `.js` URLs, which means video player JavaScript frameworks (like hls.js, dash.js, Shaka Player) are blocked even when they're the actual source of video detection.

**Refined approach:** Instead of blocking all `.js`, use domain-scoped patterns:

```js
// Block static assets only from known ad/analytics domains
// (not from video CDN or player domains)
const AD_STATIC_ASSET_RE = /(?:doubleclick|googlesyndication|googleads|adservice|adserver|adnxs|clmbtech|chartbeat|scorecardresearch)\.(?:net|com)\/.*\.(?:js|css)$/i;

// Block player SDK files only when they come from ad SDK paths
const AD_SDK_RE = /(?:\/vast\.js|\/ad-plugin\/|ad-manager|admanager)\/[^/]+\.js/i;

// Anti-adblock scripts to detect (info-level, not blocking)
const ANTIBLOCK_RE = /(?:fuckadblock|blockadblock|wp-adblock)/i;
```

---

### A.5 New Video Player SDK Patterns

uBO's unbreak list reveals that many legitimate video players load scripts that have "ads" in their name but are essential for playback. These should be **recognized as video-related** (not blocked):

```js
// Video player SDKs that are legitimate (not ads despite the name)
const VIDEO_PLAYER_SDK_RE = /\/js\/sdkloader\/(?:ima3|ima3_dai|ima3_debug)\.js/i;        // Google IMA (video ads framework, but needed for playback)
const VIDEO_ANALYTICS_RE = /(?:comscore\.streaming|mux\.js|mux\.min\.js)/i;                // Video-specific analytics
const VIDEO_FRAMEWORK_RE = /(?:akamaihtml5|ooyala|jwplayer|brightcove|kaltura|shaka)/i;  // Video player frameworks
```

Place these in `video_filters.js` (not in `media_candidates.js`'s block list) so they're classified as video-related rather than blocked.

---

### A.6 P2P / Chinese Streaming Patterns

From `resource-abuse.txt`, uBO blocks P2P sharing on Chinese streaming sites:

```js
// Chinese streaming P2P CDN URLs (block individual segment URLs, not the player)
const CHINESE_STREAMING_CDN_RE = /(?:douyucdn\.cn|msstatic\.com|huya\.com\/.*p2p)/i;
const CHINESE_STREAMING_P2P_RE = /\/front-publish\/stream-sdk-lib-master\//i;
```

Add these to `isBlockedMediaUrl` when they match segment/init URLs (small files, P2P chunks), but pass through the actual stream manifest URLs.

---

## Phase B — Filter List Data Sources (Approach 1)

### B.1 Filter List URLs & Description

uBlock Origin's filter lists are hosted on GitHub's `uBlockOrigin/uAssets` repository. The following are the most relevant to Qwin:

| List | URL | Size | Update | Relevance |
|---|---|---|---|---|
| **uBlock filters** | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt` | ~500 KB | ~weekly | Ad server domains, video ad patterns, anti-adblock scripts |
| **uBlock filters – Unbreak** | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt` | ~50 KB | ~monthly | **Most useful**: Exception patterns for video players, whitelist rules |
| **uBlock filters – Resource abuse** | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt` | ~20 KB | ~monthly | P2P streaming abuse, crypto miners on video sites |
| **uBlock filters – Privacy** | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt` | ~100 KB | ~weekly | Tracking domains (often overlap with video CDNs) |
| **EasyList** | `https://easylist.to/easylist/easylist.txt` | ~1 MB | daily | Comprehensive ad server domain list (largest and most active) |
| **EasyPrivacy** | `https://easylist.to/easylist/easyprivacy.txt` | ~500 KB | daily | Tracking/analytics domains |

**Recommendation:** Start with the **Unbreak** list only (~50 KB) since it has the highest signal-to-noise ratio for video-related patterns. Add **EasyList** later for broader ad domain coverage.

### B.2 Architecture: Filter List Loader Module

Create a new module at `src/shared/filter_list_loader.js` with the following API:

```js
// src/shared/filter_list_loader.js — Proposed API

/**
 * Filter List Loader for Qwin Video Downloader
 *
 * Downloads uBlock Origin filter lists and extracts domain patterns
 * relevant to video detection and ad filtering.
 *
 * Uses the following lifecycle:
 * 1. fetchFilterList(url) — Raw download
 * 2. parseFilterList(text) — Parse adblock filter syntax
 * 3. extractVideoRelevantRules(rules) — Filter to video-relevant subset
 * 4. cacheResults(rules) — Store in chrome.storage.local
 * 5. getActiveRules() — Load from cache for runtime use
 */

// Core functions:

/**
 * Download and cache a filter list from URL.
 * Handles HTTP errors, timeouts, and respects caching headers.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchFilterList(url) { /* ... */ }

/**
 * Parse raw Adblock/uBO filter syntax into structured rule objects.
 *
 * Handles:
 * - Comment lines (starting with !)
 * - Domain blocking patterns (||domain.com^)
 * - Exception rules (@@pattern)
 * - Filter options ($domain=, $media, $script, $third-party, etc.)
 * - Cosmetic filters (##)
 *
 * @param {string} text — Raw filter list content
 * @returns {Array<FilterRule>}
 */
function parseFilterList(text) { /* ... */ }

/**
 * Rule object shape:
 * @typedef {Object} FilterRule
 * @property {'block'|'exception'|'cosmetic'|'scriptlet'} type
 * @property {string} raw — Original rule text
 * @property {string|null} domain — Domain pattern (e.g. "doubleclick.net")
 * @property {string|null} path — Optional URL path pattern
 * @property {string|null} options — Filter options portion
 * @property {Set<string>} optionTags — Parsed option tags from $ syntax
 * @property {Set<string>|null} scopeDomains — Domain restriction ($domain=)
 * @property {RegExp|null} compiled — Compiled regex (for fast matching)
 */

/**
 * Extract only the rules relevant to video/media detection.
 * Filters rules that:
 * - Target $media requests (video/audio content type)
 * - Are exception rules (@@) on known video CDN domains
 * - Are blocking rules for ad domains commonly found on video sites
 * - Are domain-scoped to known streaming platforms
 *
 * @param {Array<FilterRule>} rules
 * @returns {Array<FilterRule>}
 */
function extractVideoRelevantRules(rules) { /* ... */ }

/**
 * Convert a compiled rule set into Qwin's existing pattern format.
 * Returns an object that can be merged into media_candidates.js patterns.
 *
 * @returns {Promise<{adDomains: string[], exceptionDomains: string[], cdnDomains: string[]}>}
 */
async function compileActivePatterns() { /* ... */ }

/**
 * Load cached rules from storage. Returns null if no cache exists
 * or cache is expired.
 * @param {string} listKey
 * @returns {Promise<Array<FilterRule>|null>}
 */
async function loadFromCache(listKey) { /* ... */ }

/**
 * Save parsed rules to chrome.storage.local with timestamp.
 * @param {string} listKey
 * @param {Array<FilterRule>} rules
 * @returns {Promise<void>}
 */
async function saveToCache(listKey, rules) { /* ... */ }

/**
 * Attempt to refresh all configured filter lists.
 * Returns success/failure for each list.
 * @returns {Promise<Object<string, boolean>>}
 */
async function refreshAllLists() { /* ... */ }

/**
 * Get the current set of active patterns for URL classification.
 * This is what Qwin's background script calls at startup.
 * @returns {Promise<{blockedDomains: string[], exceptionDomains: string[], videoCdnDomains: string[]}>}
 */
async function getActivePatterns() { /* ... */ }
```

**Integration with Qwin's existing code:**

```js
// In background.js — called during service worker initialization
import * as filterListLoader from "../shared/filter_list_loader.js";

async function initFilterIntegration() {
  const patterns = await filterListLoader.getActivePatterns();

  // Merge into the runtime ad/exception lists
  adBlockedDomains = new Set([...adBlockedDomains, ...patterns.blockedDomains]);
  videoExceptionDomains = new Set([...videoExceptionDomains, ...patterns.exceptionDomains]);

  // Schedule background refresh (every 5 days)
  setInterval(async () => {
    await filterListLoader.refreshAllLists();
    const updated = await filterListLoader.getActivePatterns();
    // Reload patterns
  }, 5 * 24 * 60 * 60 * 1000);
}
```

### B.3 Filter Syntax Parser Design

The Adblock/uBO filter syntax parser should handle:

**Comment lines:**
```
! This is a comment
! Title: uBlock filters
[Adblock Plus 3.8]
```

**Domain blocking patterns:**
```
||doubleclick.net^             → Block any request to doubleclick.net or subdomains
||ads.example.com/path         → Block requests matching this URL prefix
/pattern/regex/                → Regex-based blocking
```

**Exception rules:**
```
@@||cdn.video-cdn.com/player   → Allow (whitelist) this URL
@@||example.com^$script,domain=video.site.com  → Allow only on specific site
```

**Filter options:**
```
$media           → Only match media requests (video/audio)
$script          → Only match script requests
$xhr             → Only match XHR/fetch requests
$domain=site.com → Only apply on specified sites
$third-party     → Only match cross-origin requests
$important       → Override exception rules
```

**Domain-scoped rules:**
```
||adserver.com^$domain=twitch.tv|youtube.com  → Only block on these sites
```

**Cosmetic filters (not relevant for URL detection — skip):**
```
example.com##.ad-banner          → CSS hide
example.com##+js(set, var, val)  → Scriptlet injection (skip)
```

**Parser algorithm:**
```
1. For each line in filter list:
   a. Skip blank lines and comments (starting with !)
   b. Detect cosmetic filter (contains ##) → skip (not URL-relevant)
   c. Detect exception rule (starts with @@) → parse as exception
   d. Detect domain pattern (starts with ||) → parse as domain block
   e. Detect regex pattern (starts and ends with /) → store as regex
   f. Detect URL prefix pattern → store as prefix match
   g. Parse $options suffix if present
2. Extract $domain restriction if present
3. Compile into a fast-matching structure:
   - Trie for domain prefixes
   - Set for exact domain matches
   - Array for regex patterns
```

### B.4 Storage and Cache Strategy

**Storage location:** `chrome.storage.local` (survives service worker restarts)

**Cache schema:**
```js
const CACHE_SCHEMA = {
  "filter_cache:uBlockFilters": {
    fetchedAt: 1700000000000,      // Unix timestamp
    etag: "\"abc123\"",            // HTTP ETag for conditional requests
    rules: [                       // Parsed rule objects
      { type: "block", domain: "doubleclick.net", options: "$script", compiled: null },
      { type: "exception", domain: "cdn.example.com", options: "$media", compiled: null },
    ]
  },
  "filter_cache:unbreak": { /* same shape */ },
  "filter_cache:easylist": { /* same shape */ },
  "filter_compiled_patterns": {
    lastCompiled: 1700000000000,
    adDomains: ["doubleclick.net", "googlesyndication.com", ...],
    exceptionDomains: ["cdn.video-cdn.com", "akamaihd.net", ...],
    cdnDomains: ["fastly.net", "cloudfront.net", ...],
  }
};
```

**Cache invalidation:**
- Respect HTTP `ETag` / `Last-Modified` headers when fetching
- Default refresh intervals: 5 days for uBO lists, 1 day for EasyList
- Force refresh on extension update (check `chrome.runtime.onInstalled`)

**Memory strategy:**
- Raw filter lists: stored as parsed objects (not raw text) to minimize storage
- Compiled patterns: stored as arrays of strings (for fast Set lookup)
- Runtime: keep compiled patterns in a global `Set` for O(1) lookup during URL classification

### B.5 Exception Pattern Extraction

The Unbreak filter list (`unbreak.txt`) is the single most valuable data source for Qwin. It contains exception rules that **unbreak video players** when ad blockers are too aggressive.

**Key exception pattern categories:**

```
@@ Type: Player SDK Unbreak
----------------------------------------------------------
Pattern: @@||imasdk.googleapis.com/js/sdkloader/ima3.js$script,domain=...
Why:     Google IMA SDK is needed for video ad insertion/playback on many sites
Source:  Multiple entries in unbreak.txt (ign.com, sbs.com.au, etc.)

Pattern: @@||cdn.turner.com/cnn/van/resources/*/scripts/vendor/loggly.tracker.js
Why:     CNN video player requires this tracking script
Source:  unbreak.txt

Pattern: @@||akamaihd.net/player/*/akamai/amp/prebid/*$script,domain=static.foxnews.com
Why:     Fox News Akamai video player with prebid integration
Source:  unbreak.txt

Pattern: @@||analytics.edgesuite.net/html5/akamaihtml5-min.js$script,domain=sky.de
Why:     Sky Germany video player framework (not actually analytics)
Source:  unbreak.txt

Pattern: @@||v.fwmrm.net/ad/g/1$script,domain=abc.go.com
Why:     ABC video uses FreeWheel for ad decisioning (but it's essential)
Source:  unbreak.txt
```

```
@@ Type: Media/Streaming Unbreak
----------------------------------------------------------
Pattern: @@||streamplay.to^*manifest.mpd$xhr
Why:     Streamplay video hosting (MPD manifest — direct download source!)
Source:  unbreak.txt

Pattern: @@||streamplay.to^*.mp4$xhr
Why:     Streamplay direct MP4 download
Source:  unbreak.txt

Pattern: @@||hdliveextra-a.akamaihd.net^$domain=nbcsports.com
Why:     NBC Sports live stream CDN
Source:  unbreak.txt

Pattern: @@*$media,domain=camwhores.tv
Why:     Allow all media on this domain
Source:  unbreak.txt
```

```
@@ Type: Domains that look like trackers but are needed for video
----------------------------------------------------------
Pattern: @@||fusion.ddmcdn.com^$script,domain=discovery.com|foodnetwork.com|hgtv.com
Why:     Discovery/FoodNetwork require this for video
Source:  unbreak.txt

Pattern: @@||src.litix.io/core/*/mux.js$script,domain=destinationamerica.com
Why:     Destination America uses Mux video platform
Source:  unbreak.txt

Pattern: @@||cdn.gotraffic.net^$domain=bloomberg.*
Why:     Bloomberg video CDN
Source:  unbreak.txt
```

**How Qwin should use these exceptions:**

When a video URL is detected, Qwin's `isBlockedMediaUrl()` function should check against **two** lists:

1. **Block list** — Domains/patterns known to be ads (current `AD_RE` + downloaded filter patterns)
2. **Exception list** — Domains that were **previously blocked** but are now whitelisted because they're essential for video playback

The exception list takes priority — if a URL matches an exception pattern, it passes through regardless of block patterns.

---

## Implementation Priority Matrix

| # | Task | Approach | Effort | Impact | File(s) affected |
|---|---|---|---|---|---|
| 1 | Enhance `AD_RE` with missing ad domains | A | 1 day | High | `media_candidates.js`, `media_candidates.py` |
| 2 | Enhance `CDN_HINT_RE` with video CDNs | A | 1 day | High | `media_candidates.js`, `media_candidates.py` |
| 3 | Add exception domain handling | A | 2 days | High | `media_candidates.js`, `background.js` |
| 4 | Add streaming platform host patterns | A | 0.5 day | Medium | `media_candidates.js`, `video_filters.js` |
| 5 | Create filter list loader module | B | 4 days | Medium | New `filter_list_loader.js` |
| 6 | Implement adblock syntax parser | B | 3 days | Medium | `filter_list_loader.js` |
| 7 | Cache & refresh strategy | B | 2 days | Low | `filter_list_loader.js`, `background.js` |
| 8 | Exception pattern extraction & auto-whitelist | B | 2 days | Medium | `filter_list_loader.js`, `background.js` |
| 9 | P2P/Chinese streaming detection | A | 0.5 day | Low | `media_candidates.js` |
| 10 | Run existing test suite to validate no regressions | A+B | 1 day | Critical | All |

**Recommended order:** 1 → 3 → 2 → 4 → 9 → 10 (Phase A first), then 5 → 6 → 7 → 8 → 10 (Phase B)

---

## Testing Strategy

### Unit Tests

Create a new test file `tests/extension/test_filter_integration.js`:

```js
// Test cases for uBlock filter integration

import * as mediaCandidates from "../../src/shared/media_candidates.js";

describe("AD_RE enhancements", () => {
  test("blocks known ad domain: adnxs.com", () => {
    expect(mediaCandidates.isBlockedMediaUrl("https://secure.adnxs.com/video/123")).toBe(true);
  });
  test("blocks fwmrm.net ad framework", () => {
    expect(mediaCandidates.isBlockedMediaUrl("https://v.fwmrm.net/ad/g/1?")).toBe(true);
  });
  test("blocks popads.net", () => {
    expect(mediaCandidates.isBlockedMediaUrl("https://popads.net/pop.js")).toBe(true);
  });
});

describe("CDN_HINT_RE enhancements", () => {
  test("detects espncdn.com as video CDN", () => {
    expect(mediaCandidates.isLikelyVideoRequest("https://espncdn.com/redesign/video/player.js")).toBe(true);
  });
  test("detects gotraffic.net as video CDN", () => {
    expect(mediaCandidates.isLikelyVideoRequest("https://cdn.gotraffic.net/video/stream.m3u8")).toBe(true);
  });
});

describe("Exception pattern integration", () => {
  test("whitelisted domain bypasses block", () => {
    // If akamaihd.net is in both AD_RE and exceptions, exceptions win
    expect(mediaCandidates.isBlockedMediaUrlWithExceptions(
      "https://akamaihd.net/player/akamai/amp/prebid/js",
      new Set(["akamaihd.net"])
    )).toBe(false); // Whitelisted
  });
});

describe("Filter list parser", () => {
  test("parses domain blocking rule", () => {
    const rules = parseFilterList("||doubleclick.net^");
    expect(rules[0]).toEqual({
      type: "block",
      domain: "doubleclick.net",
      path: null,
      options: null,
      raw: "||doubleclick.net^"
    });
  });
  test("parses exception rule", () => {
    const rules = parseFilterList("@@||cdn.example.com^$media");
    expect(rules[0].type).toBe("exception");
    expect(rules[0].domain).toBe("cdn.example.com");
  });
  test("parses domain-scoped rule", () => {
    const rules = parseFilterList("||adserver.com^$domain=twitch.tv|youtube.com");
    expect(rules[0].scopeDomains).toEqual(new Set(["twitch.tv", "youtube.com"]));
  });
  test("ignores cosmetic filters", () => {
    const rules = parseFilterList("example.com##.ad-banner");
    expect(rules.length).toBe(0); // Cosmetic filters are not URL-relevant
  });
  test("ignores empty and comment lines", () => {
    const rules = parseFilterList("\n! comment\n||example.com^\n");
    expect(rules.length).toBe(1);
    expect(rules[0].domain).toBe("example.com");
  });
});
```

### Integration Tests

- **Q: Does loading a filter list slow down extension startup?**  
  A: Only on first load (async download). Cached lists load from `chrome.storage.local` synchronously at startup.

- **Q: Do any existing ad-blocking patterns change behavior?**  
  A: Run the full test suite (`npm run test:extension`) before and after to catch regressions.

- **Q: Are there false positives from expanding AD_RE?**  
  A: Yes — domains like `spotxcdn.com` and `smartclip.net` serve genuine video content on some sites. This is why the exception list is critical.

### Manual Verification

1. Visit sites known to have video content previously blocked by false positives (e.g., sky.de, cnn.com, espn.com, bloomberg.com)
2. Verify video detection in Qwin popup
3. Verify that ad URLs are still blocked correctly
4. Check logs (`logs/downloads.jsonl`) to confirm correct URL classification

---

## Appendix A — Full List of uBO Exception Patterns Relevant to Video

Extracted from `unbreak.txt` (source: `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt`).

### Video Player Unbreak (most relevant to Qwin)

```
@@||akamaihd.net/player/*/akamai/amp/prebid/*$script,domain=static.foxnews.com
@@||hdliveextra-a.akamaihd.net^$domain=nbcsports.com
@@||mps.nbcuni.com^$script,domain=csnme.com
@@||data.cnn.com/jsonp/cfg/*/videoconfig/cnn/desktop/domesticsectionconfig.json$script,domain=cnn.com
@@||cnn.com/.element/apps/cvp/3.0/cfg/spider/cnn/expansion/ad_policy.xml$xhr,domain=cnn.com
@@||z.cdn.turner.com/analytics/cnnexpan/jsmd.min.js$script,domain=cnn.com
@@||cdn.cnn.com/analytics/cnn_arabic/jsmd.min.js$script,1p
@@||mssl.fwmrm.net/libs/*$script,domain=go.cnn.com
@@||analytics.edgesuite.net/html5/akamaihtml5-min.js$script,domain=sky.de
@@||analytics.edgekey.net/html5/akamaihtml5-min.js$script,domain=sky.de
@@||assets.adobedtm.com^$script,domain=sky.de
@@||d29xw9s9x32j3w.cloudfront.net/players/library/*$domain=seattlepi.com|sfgate.com
@@||googletagservices.com/tag/js/gpt.js$script,domain=blastingnews.com
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$domain=it.ign.com
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$script,domain=sbs.com.au
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$script,domain=seattlepi.com|sfgate.com
@@||imasdk.googleapis.com/js/sdkloader/ima3_dai.js$script,domain=cbsnews.com
@@||imasdk.googleapis.com/js/sdkloader/ima3_dai.js$script,domain=click2houston.com|clickondetroit.com|...
@@||cdn.ampproject.org/*/amp-geo-$script,domain=engadget.com|koat.com|...
@@||sonycrackle.com/vendor/AdManager.js$script,1p
@@||fwlive.sonycrackle.com/ad/*$script,1p
@@||imrworldwide.com/novms/*/ggcm*.js$script,domain=sonycrackle.com
@@||fusion.ddmcdn.com^$script,domain=discovery.com|foodnetwork.com|hgtv.com|...
@@||v.fwmrm.net/ad/$script,xhr,domain=destinationamerica.com
@@||src.litix.io/core/*/mux.js$script,domain=destinationamerica.com
@@||static.bbc.co.uk/radio/player/*/script/logger.js$script,domain=bbc.co.uk
@@||play2.qbrick.com/framework/modules/analytics/analytics.min.js$script
@@||cbsistatic.com/*/comscore.streaming.$script,domain=cbsnews.com
@@||streamplay.to^*manifest.mpd$xhr
@@||streamplay.to^*.mp4$xhr
@@||streamplay.to^*.m4s$xhr
@@||openx.tv/embed/$domain=m4ufree.com
@@||cdn.gotraffic.net^$domain=bloomberg.*
@@||js.spotx.tv/directsdk/$script,domain=bloomberg.*
@@||spotxcdn.com/integration/directsdk/$script,domain=bloomberg.*
@@*$media,domain=camwhores.tv
@@||static.iqiyi.com/js/player_v1/sdk/*$script,1p
@@||cdn.ziffstatic.com/pg/ign.$script,domain=ign.com
@@||espncdn.com/redesign/*/js/espn-analytics.js$script,domain=espn.com
@@||registerdisney.go.com/*/responder/responder.js$script,domain=espn.com
@@||tealium.cbsnews.com/site/prod/utag.js^$1p
@@||mpsnare.iesnare.com/snare.js$script,domain=costco.com
```

### Ad SDKs essential for playback

```
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$script,domain=ign.com
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$script,domain=sbs.com.au
@@||imasdk.googleapis.com/js/sdkloader/ima3.js$domain=it.ign.com
@@||imasdk.googleapis.com/js/sdkloader/ima3_dai.js$script,domain=cbsnews.com
||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect=google-ima.js,domain=espn.com
||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect=google-ima.js,domain=iheartradio.ca
→ Redirect rule: blocks the real IMA SDK but replaces it with a neutered version
→ Important: the neutered version allows video playback without ads
```

---

## Appendix B — Source Filter List URLs

All URLs below are publicly accessible raw content from GitHub:

| List | Raw URL |
|---|---|
| uBlock filters | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt` |
| uBlock Unbreak | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt` |
| uBlock Resource abuse | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt` |
| uBlock Privacy | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt` |
| uBlock Annoyances | `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt` |
| EasyList | `https://easylist.to/easylist/easylist.txt` |
| EasyPrivacy | `https://easylist.to/easylist/easyprivacy.txt` |

**Licensing:** These files are distributed under the following licenses:
- uBlock Origin lists (uAssets): GPLv3
- EasyList / EasyPrivacy: `https://easylist.to/pages/licence.html` (Creative Commons Attribution-ShareAlike 3.0)

Qwin's use of these patterns is **transformative** — we're not redistributing the lists, we're extracting **specific domain names and regex patterns** for the purpose of video URL classification, which is a completely different application than ad blocking.

---

## Appendix C — Glossary of Filter Syntax

| Syntax | Meaning | Example |
|---|---|---|
| `||domain.com^` | Match domain at start of URL | `||doubleclick.net^` matches `https://doubleclick.net/ad` |
| `@@` | Exception rule (whitelist) | `@@||cdn.example.com^` |
| `$media` | Match media requests (video/audio) | `||adserver.com/video$media` |
| `$script` | Match script requests | `||analytics.com/track.js$script` |
| `$xhr` | Match XHR/fetch requests | `||api.adserver.com$xhr` |
| `$domain=` | Restrict rule to specific sites | `$domain=twitch.tv\|youtube.com` |
| `$third-party` | Only match cross-origin requests | `||tracker.com^$third-party` |
| `$important` | Override exception rules | `||adserver.com^$important` |
| `$redirect=` | Replace blocked resource with surrogate | `$redirect=noopjs` |
| `$badfilter` | Remove a previously defined filter | `||example.com^$badfilter` |
| `##` | CSS cosmetic filter (hide element) | `example.com##.ad-banner` |
| `##+js()` | Scriptlet injection | `##+js(set, var, value)` |
| `!#if` / `!#endif` | Conditional filter (browser-specific) | `!#if env_chromium` |
| `!` | Comment line | `! This list contains...` |

---

## Appendix D — Qwin Files Requiring Changes

| File | Changes needed |
|---|---|
| `src/shared/media_candidates.js` | Update `AD_RE`, `CDN_HINT_RE`, add new `*_RE` constants, update `isBlockedMediaUrl()` for exceptions |
| `src/shared/video_filters.js` | Add video player SDK patterns, update `isLikelyFullLengthVideoCandidate()` for new domains |
| `src/native-host/media_candidates.py` | Mirror JS pattern changes for the Python native host |
| `src/background/background.js` | Add filter list initialization at startup, schedule refresh |
| `src/shared/filter_list_loader.js` | **New file**: filter list download, parse, cache, compile |
| `tests/extension/test_filter_integration.js` | **New test file**: all pattern matching tests |
| `tests/native-host/test_media_candidate_rules.py` | Python-side test updates |

---

*End of specification document. Last updated: June 21, 2026.*
