# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 of the universal video capture pipeline — Cloudflare bypass enhancement, Service Worker media capture, CDP browser tunnel download, and cookie/header injection into download backends.

**Architecture:** Four independent subsystems wired into the existing pipeline. (1) Cookie extraction via CDP `Network.getAllCookies()` feeds session data into all probe backends. (2) Enhanced Cloudflare detection adds Turnstile detection, TLS fingerprint rotation, and cf_clearance cookie extraction. (3) Service Worker capture registers an ephemeral SW on the page that intercepts media responses and relays them to the background script. (4) CDP tunnel download injects `fetch()` calls via `Runtime.evaluate` when all other backends fail. The existing `download_orchestration.js` layer fallback logic is extended to try these new pathways in order: probes → SW segments → CDP tunnel → browser download.

**Tech Stack:** JS (Manifest V3 ES modules, esbuild bundling), Python 3.11+ (native host), Chrome Extension APIs (chrome.debugger, chrome.tabs, runtime messaging).

## Global Constraints

- JS: 2-space indent, trailing commas, double quotes, 120 char width.
- Python: 4-space indent, ruff (E/F/W/I), 120 char width, first-party imports listed in ruff.toml.
- No global npm packages. Use `npm run setup` for dependency installation.
- Rebuild with `npm run build` (or `npm run build:chromium`) after any `src/` change.
- Tests: Python unittest for native host (`tests/native-host/`), Node.js for extension (`tests/extension/`).
- Content scripts are raw ES modules loaded via importScripts — no bundling.
- Background scripts are esbuild-bundled into `dist/bundled/src/background/background.bundle.js`.
- Message sizes limited to 4MB via chrome.runtime messaging (chunk larger payloads).
- Service Worker scope restricted to page path — never override existing SW.

---
### Task 0: Shared Media Protocols Module

**Files:**
- Create: `src/shared/media_protocols.js` — shared regex patterns for protocol detection
- Create: `tests/extension/shared/test_media_protocols.js`

**Interfaces:**
- Produces: `media_protocols.js` exports:
  - `MEDIA_CONTENT_TYPE_RE: RegExp` — matches video/*, audio/*, application/x-mpegURL, application/dash+xml
  - `CMS_PATTERNS: Array<{pattern: RegExp, name: string}>` — known CMS URL patterns (jwplayer, videojs, shaka, etc.)
  - `TRANSFER_MODE_RE: RegExp` — matches `transferMode: "stream"` patterns in fetch handlers
  - `WEBSOCKET_MEDIA_RE: RegExp` — detects WebSocket URLs carrying media data
  - `SEGMENT_URL_RE: RegExp` — matches segment-level URLs (.ts, .m4s, .cmfv, /segment-N/)
  - `MANIFEST_URL_RE: RegExp` — matches manifest URLs (.m3u8, .mpd)
  - `SIGNED_URL_RE: RegExp` — detects signed/token-authenticated URL patterns
  - `classifyUrl(url: string): {type: string, format: string, cms?: string}` — classify a URL
  - `hasMediaContentType(contentType: string): boolean` — check if Content-Type is media

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extension/shared/test_media_protocols.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const mp = await import("../../../src/shared/media_protocols.js");

  // Test MEDIA_CONTENT_TYPE_RE
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("video/mp4"), "Must match video/mp4");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("audio/mp4"), "Must match audio/mp4");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("application/x-mpegURL"), "Must match HLS");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("application/dash+xml"), "Must match DASH");
  assert.ok(!mp.MEDIA_CONTENT_TYPE_RE.test("text/html"), "Must NOT match text/html");

  // Test classifyUrl
  assert.equal(mp.classifyUrl("https://cdn.example.com/video.mp4").type, "direct");
  assert.equal(mp.classifyUrl("https://cdn.example.com/master.m3u8").type, "manifest");
  assert.equal(mp.classifyUrl("https://cdn.example.com/seg-001.ts").type, "segment");
  assert.equal(mp.classifyUrl("https://www.youtube.com/watch?v=abc").type, "page");

  // Test hasMediaContentType
  assert.ok(mp.hasMediaContentType("video/mp4"));
  assert.ok(mp.hasMediaContentType("application/x-mpegURL; charset=utf-8"));
  assert.ok(!mp.hasMediaContentType("text/html"));

  // Test CMS pattern detection
  const jwUrl = "https://content.jwplatform.com/videos/abc123.mp4";
  assert.equal(mp.classifyUrl(jwUrl).cms, "jwplayer");

  // Test SEGMENT_URL_RE
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/video.m4s"));
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/segment-123.ts"));
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/file.cmfv"));
  assert.ok(!mp.SEGMENT_URL_RE.test("https://cdn.example.com/master.m3u8"));

  // Test SIGNED_URL_RE
  assert.ok(mp.SIGNED_URL_RE.test("https://cdn.example.com/video.mp4?token=abc&expires=1700000000"));
  assert.ok(!mp.SIGNED_URL_RE.test("https://cdn.example.com/video.mp4"));

  // Test TRANSFER_MODE_RE
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode: 'stream'"));
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode: \"stream\""));

  console.log("✓ All media_protocols tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/extension/shared/test_media_protocols.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/shared/media_protocols.js
"use strict";

/**
 * Shared Media Protocol Detection Patterns
 *
 * Central repository of URL patterns, Content-Type checks, and CMS
 * detection regexes shared across content scripts, background scripts,
 * and native host. This avoids duplicating detection logic across
 * multiple modules.
 *
 * Used by:
 *   - Layer 0 (Detection): content script DOM scanning
 *   - Layer 3 (SW Capture): SW fetch event filtering
 *   - Layer 4 (MSE Demux): segment classification
 *   - Layer 6 (Tunnel): URL type routing
 */

// ─── Media Content Types ───────────────────────────────────────────────────

/** Match any media-related content type. */
const MEDIA_CONTENT_TYPE_RE = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;

/** Check if a Content-Type header value indicates media content. */
function hasMediaContentType(contentType) {
  if (!contentType || typeof contentType !== "string") return false;
  return MEDIA_CONTENT_TYPE_RE.test(contentType.trim());
}

// ─── URL Patterns ─────────────────────────────────────────────────────────

/** Match segment-level URLs (.ts, .m4s, .cmfv, .cmfa). */
const SEGMENT_URL_RE = /\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\?|$)/i;

/** Match manifest URLs (.m3u8, .mpd). */
const MANIFEST_URL_RE = /\.(m3u8|mpd)(\?|$)/i;

/** Match direct media file URLs (mp4, webm, avi, mkv). */
const DIRECT_MEDIA_RE = /\.(mp4|webm|avi|mkv|mov|wmv|flv)(\?|$)/i;

/** Detect signed/token-authenticated URLs (expiry params). */
const SIGNED_URL_RE = /[?&](?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id|X-Amz-Expires|AWSAccessKeyId)=/i;

/** Detect transferMode: "stream" patterns in fetch intercept code. */
const TRANSFER_MODE_RE = /transferMode\s*[:=]\s*['"]stream['"]/i;

/** Detect WebSocket URLs. */
const WEBSOCKET_MEDIA_RE = /^wss?:\/\//i;

/** Detect fetch/XHR patterns carrying media data. */
const FETCH_MEDIA_RE = /(?:fetch|XMLHttpRequest)\([^)]*\.(?:mp4|m3u8|mpd|ts|m4s)/i;

// ─── CMS Detection Patterns ───────────────────────────────────────────────

const CMS_PATTERNS = [
  { pattern: /jwp(?:layer)?\.com|jwplatform\.com/i, name: "jwplayer" },
  { pattern: /videojs\.com|video-js\.min\.js/i, name: "videojs" },
  { pattern: /shaka-player|shaka\.compiled/i, name: "shaka" },
  { pattern: /flowplayer\.org|flowplayer\.min\.js/i, name: "flowplayer" },
  { pattern: /hls\.js|hls\.min\.js/i, name: "hlsjs" },
  { pattern: /dashjs|dash\.all\.min\.js/i, name: "dashjs" },
  { pattern: /bitmovin\.com|bitdash/i, name: "bitmovin" },
  { pattern: /plyr\.io|plyr\.min\.js/i, name: "plyr" },
  { pattern: /clappr\.io|clappr\.min\.js/i, name: "clappr" },
  { pattern: /theoplayer|theo\.player/i, name: "theoplayer" },
  { pattern: /cdn\.amazonaws\.com\/IVS|ivs\.rocks/i, name: "aws-ivs" },
  { pattern: /cloudflare\.com\/stream|videodelivery\.net/i, name: "cloudflare-stream" },
];

// ─── URL Classification ───────────────────────────────────────────────────

/**
 * Classify a URL to determine its type, format, and CMS origin.
 *
 * @param {string} url - The URL to classify.
 * @returns {{type: string, format: string, cms: string|null}}
 */
function classifyUrl(url) {
  if (!url || typeof url !== "string") {
    return { type: "unknown", format: "", cms: null };
  }

  // Format extraction
  let format = "";
  const extMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  if (extMatch) format = extMatch[1].toLowerCase();

  // CMS detection
  let cms = null;
  for (const cp of CMS_PATTERNS) {
    if (cp.pattern.test(url)) {
      cms = cp.name;
      break;
    }
  }

  // Type classification
  let type = "unknown";
  if (WEBSOCKET_MEDIA_RE.test(url)) {
    type = "websocket";
  } else if (MANIFEST_URL_RE.test(url)) {
    type = "manifest";
  } else if (SEGMENT_URL_RE.test(url)) {
    type = "segment";
  } else if (DIRECT_MEDIA_RE.test(url)) {
    type = "direct";
  } else if (url.startsWith("blob:")) {
    type = "blob";
  } else if (url.startsWith("data:")) {
    type = "data";
  } else {
    type = "page";
  }

  return { type, format, cms };
}

export {
  MEDIA_CONTENT_TYPE_RE,
  SEGMENT_URL_RE,
  MANIFEST_URL_RE,
  DIRECT_MEDIA_RE,
  SIGNED_URL_RE,
  TRANSFER_MODE_RE,
  WEBSOCKET_MEDIA_RE,
  FETCH_MEDIA_RE,
  CMS_PATTERNS,
  hasMediaContentType,
  classifyUrl,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/extension/shared/test_media_protocols.js`
Expected: PASS with "All media_protocols tests passed"

- [ ] **Step 5: Commit**

```bash
git add src/shared/media_protocols.js tests/extension/shared/test_media_protocols.js
git commit -m "feat(shared): add shared media protocol detection module for Layer 0"
```

---
### Task 1: Cookie Extraction via CDP

**Files:**
- Create: `src/background/cookie_extraction.js`
- Create: `tests/extension/background/test_cookie_extraction.js`
- Modify: `scripts/build-bundles.js` — register new background module for esbuild

**Interfaces:**
- Produces: `cookie_extraction.js` exports:
  - `extractCookies(tabId: number): Promise<Array<{name, value, domain, path, secure, httpOnly}>>`
  - `extractHeaders(tabId: number): Promise<Array<{name, value}>>`
  - `extractLocalStorage(tabId: number): Promise<Record<string, string>>`
  - `cookiesToCookieString(cookies: Array): string` — formats for `Cookie:` header
  - `cleanup()` — disconnect all CDP sessions

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extension/background/test_cookie_extraction.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  // Test cookiesToCookieString formatting
  const { cookiesToCookieString } = await import("../../../src/background/cookie_extraction.js");

  const cookies = [
    { name: "session", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    { name: "pref", value: "lang=en", domain: ".example.com", path: "/", secure: false, httpOnly: false },
  ];
  const cookieStr = cookiesToCookieString(cookies);
  assert.equal(cookieStr, "session=abc123; pref=lang=en", "must format as semicolon-separated name=value pairs");

  // Test with empty array
  assert.equal(cookiesToCookieString([]), "", "empty cookies should return empty string");

  // Test with null/undefined
  assert.equal(cookiesToCookieString(null), "", "null should return empty string");
  assert.equal(cookiesToCookieString(undefined), "", "undefined should return empty string");

  console.log("✓ All cookie_extraction tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:chromium && node tests/extension/background/test_cookie_extraction.js`
Expected: FAIL with import error — module doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/background/cookie_extraction.js
"use strict";

/**
 * Cookie Extraction Module
 *
 * Uses Chrome DevTools Protocol (via chrome.debugger) to extract cookies,
 * request headers, and localStorage tokens from a browser tab. These are
 * then injected into download backends to authenticate requests through
 * Cloudflare, signed-URL CDNs, and other session-gated endpoints.
 */

// ─── Active CDP sessions ───────────────────────────────────────────────

/** @type {Map<number, boolean>} */
const activeSessions = new Map();

// ─── CDP helpers ───────────────────────────────────────────────────────

/**
 * Attach the debugger to a tab if not already attached.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || "Failed to attach debugger" });
          return;
        }
        activeSessions.set(tabId, true);
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Detach the debugger from a tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function detach(tabId) {
  if (!activeSessions.has(tabId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        activeSessions.delete(tabId);
        resolve();
      });
    } catch (_error) {
      activeSessions.delete(tabId);
      resolve();
    }
  });
}

/**
 * Send a CDP command.
 * @param {number} tabId
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    if (!activeSessions.has(tabId)) {
      resolve({ ok: false, error: "Debugger not attached to this tab." });
      return;
    }
    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || "CDP command failed" });
          return;
        }
        resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Extract all cookies for all domains from the tab.
 * @param {number} tabId
 * @returns {Promise<Array<{name: string, value: string, domain: string, path: string, secure: boolean, httpOnly: boolean}>>}
 */
async function extractCookies(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    console.warn("[cookie-extraction] Could not attach debugger:", attachResult.error);
    return [];
  }

  const cmdResult = await sendCommand(tabId, "Network.getAllCookies");
  if (!cmdResult.ok || !cmdResult.result) {
    return [];
  }

  const cookies = (cmdResult.result.cookies || []).map((c) => ({
    name: c.name || "",
    value: c.value || "",
    domain: c.domain || "",
    path: c.path || "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
  }));

  // Don't detach — caller may call extractHeaders or extractLocalStorage afterward.
  // Caller must call cleanup() when done.
  return cookies;
}

/**
 * Extract HTTP headers from the tab's active frame via Runtime.evaluate.
 * Grabs document.referrer and any meta-tag-sourced headers.
 * @param {number} tabId
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
async function extractHeaders(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return [];
  }

  const script = `(function() {
    var headers = [];
    try {
      var ref = document.referrer;
      if (ref) headers.push({ name: "Referer", value: ref });
    } catch(e) {}
    try {
      var ua = navigator.userAgent;
      if (ua) headers.push({ name: "User-Agent", value: ua });
    } catch(e) {}
    return headers;
  })()`;

  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: 5000,
  });

  if (!evalResult.ok || !evalResult.result || !evalResult.result.result || !evalResult.result.result.value) {
    return [];
  }
  return evalResult.result.result.value;
}

/**
 * Extract localStorage and IndexedDB tokens from the tab.
 * Some sites store API tokens in localStorage rather than cookies.
 * @param {number} tabId
 * @returns {Promise<Record<string, string>>}
 */
async function extractLocalStorage(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return {};
  }

  const script = `(function() {
    var result = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key) || "";
      }
    } catch(e) {}
    return result;
  })()`;

  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: 5000,
  });

  if (!evalResult.ok || !evalResult.result || !evalResult.result.result || !evalResult.result.result.value) {
    return {};
  }
  return evalResult.result.result.value;
}

/**
 * Format an array of cookie objects into a semicolon-separated Cookie header string.
 * @param {Array|null|undefined} cookies
 * @returns {string}
 */
function cookiesToCookieString(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return "";
  }
  return cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => `${encodeURIComponent(c.name)}=${encodeURIComponent(c.value)}`)
    .join("; ");
}

/**
 * Clean up all active CDP sessions.
 */
async function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    await detach(tabId);
  }
}

export { extractCookies, extractHeaders, extractLocalStorage, cookiesToCookieString, cleanup };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_cookie_extraction.js`
Expected: PASS with "All cookie_extraction tests passed"

- [ ] **Step 5: Register module in esbuild bundle config**

Read `scripts/build-bundles.js` to find the background entry point list and add `cookie_extraction.js`.

- [ ] **Step 6: Commit**

```bash
git add src/background/cookie_extraction.js tests/extension/background/test_cookie_extraction.js scripts/build-bundles.js
git commit -m "feat(background): add CDP-based cookie extraction module"
```

---
### Task 2: Cookie Injection into Probe Backends + Download Manager

**Files:**
- Modify: `src/native_host/probe_backends.py` — accept and use `cookie` parameter
- Modify: `src/native_host/download_manager.py` — extract cookies from message, pass to probes
- Modify: `src/native_host/yt_dlp_command.py` — add `--add-header "Cookie:..."` when cookies provided
- Modify: `src/native_host/browser_context.py` — ensure cookie file writing works
- Modify: `src/background/download_orchestration.js` — call `extractCookies` before native download

**Interfaces:**
- Consumes: `cookie_extraction.js` → `extractCookies(tabId)`, `cookiesToCookieString()`
- Produces: Modified download flow sends `cookieHeader` field in native message; probe backends use it

- [ ] **Step 1: Add cookie support to yt_dlp_command.py**

```python
# In build_yt_dlp_command(), after the append_browser_context_options call:
# If cookies_file is provided AND we have a cookieHeader string,
# also write a cookies.txt file and pass it via --cookies.

# In build_yt_dlp_command():
# Add this parameter: cookie_header: str | None = None
# And logic to write cookies.txt from the header string.
```

Modification: In `build_yt_dlp_command`, add `cookie_header` param. If provided, convert to Netscape-format cookie file and pass `--cookies` to yt-dlp.

- [ ] **Step 2: Add cookie support to probe_backends.py**

In `probe_curl_cffi()`, add optional `cookie_header` parameter. When provided, set the `Cookie` header in the request headers dict.

- [ ] **Step 3: Add cookie extraction to download_orchestration.js**

In `startNativeDownloadFromVideo()`, between the setup and `port.postMessage()`, call `extractCookies(tabId)` to get cookies and add them to the native message payload as `cookieHeader`:

```javascript
// After requestHeaders extraction, add cookie extraction:
if (tabId && deps.extractCookies) {
  try {
    const cookies = await deps.extractCookies(tabId);
    const cookieStr = deps.cookiesToCookieString(cookies);
    if (cookieStr) {
      message.cookieHeader = cookieStr;
    }
  } catch (_e) {
    // Cookie extraction is best-effort
  }
}
```

- [ ] **Step 4: Pass cookieHeader through download_manager.py to probe backends**

In `run_download()`, extract `cookieHeader` from the message and pass it to `_build_probe_configs()` and `build_yt_dlp_command()`.

- [ ] **Step 5: Write integration test**

```python
# tests/native-host/test_cookie_injection.py
"""Tests for cookie/header injection into download backends."""
```

- [ ] **Step 6: Commit**

```bash
git add src/background/download_orchestration.js src/native_host/probe_backends.py src/native_host/download_manager.py src/native_host/yt_dlp_command.py
git commit -m "feat(native): inject browser cookies into probe backends and yt-dlp"
```

---
### Task 3: Enhanced Cloudflare Detection + TLS Fingerprint Rotation

**Files:**
- Modify: `src/native_host/probe_backends.py` — add Turnstile detection, multi-fingerprint rotation
- Modify: `src/native_host/progress_parser.py` — enhance CF detection patterns
- Modify: `src/native_host/curl_cffi_adapter.py` — add Chrome version rotation on retry
- Modify: `src/background/cdp_tunnel_download.js` — add `extractCfClearanceCookie()` (already done in Task 6)
- Modify: `src/background/download_orchestration.js` — wire Cloudflare solver flow into fallback chain
- Create: `src/background/cloudflare_solver.js` — interactive browser-solver flow (new)
- Create: `tests/extension/background/test_cloudflare_solver.js`
- Modify: `tests/native-host/test_cloudflare_detection.py` — add Turnstile + rotation + solver tests

**Interfaces:**
- Produces: Enhanced detection functions with no signature changes
- `_is_cloudflare_response_body()` now also detects Turnstile widget HTML
- `probe_curl_cffi()` accepts optional `chrome_versions` array for rotation on 403
- NEW `cloudflare_solver.js` exports:
  - `detectAndSolveCloudflare(tabId, url): Promise<{solved: boolean, cfClearance?: string}>` — full solver flow
  - `openCloudflarePage(tabId, url): Promise<{ok: boolean}>` — navigate to CF page in tab
  - `waitForChallengeComplete(tabId, timeout: number): Promise<{solved: boolean}>` — poll for cf_clearance cookie
  - `extractCFClearance(tabId): Promise<string|null>` — extract cf_clearance after solve

- [ ] **Step 1: Add Turnstile detection to probe_backends.py**

Modify `_is_cloudflare_response_body()` in `probe_backends.py`:

```python
def _is_cloudflare_response_body(raw_output: str) -> bool:
    if not raw_output or len(raw_output) < 100:
        return False
    text = raw_output[:2000].lower()
    # Existing patterns
    if "cloudflare" in text and "attention required" in text:
        return True
    if "cf-chl" in text or "challenge-platform" in text or "cf-turnstile" in text:
        return True
    # New: Turnstile widget
    if 'data-turnstile' in text and ('challenge' in text or 'verify' in text):
        return True
    # New: generic JS challenge page (no video content, HTML boilerplate)
    if "just a moment" in text and ("cloudflare" in text or "cf-ray" in text):
        return True
    return False
```

- [ ] **Step 2: Write failing test for Turnstile detection**

```python
# In tests/native-host/test_cloudflare_detection.py
def test_is_cloudflare_challenge_turnstile(self):
    """Cloudflare Turnstile widget HTML should be detected."""
    html = b'<html><head><script src="/cdn-cgi/challenge-platform/scripts/turnstile.js"></script><div data-turnstile data-sitekey="1x00000000000000000000AA"><div id="challenge">Please verify you are human</div></div></html>'
    self.assertTrue(is_cloudflare_challenge(html))

def test_is_cloudflare_challenge_just_a_moment(self):
    """'Just a moment' Cloudflare challenge page should be detected."""
    html = b"<html><head><title>Just a moment...</title><style>body{background:#f0f0f0}</style></head><body><h1>Just a moment...</h1><p>Checking your browser before accessing the site. This is protected by Cloudflare.</p><p>cf-ray: abc123</p></body></html>"
    # Ensure it's long enough
    html += b" " * 100
    self.assertTrue(is_cloudflare_challenge(html))
```

- [ ] **Step 3: Add Turnstile + generic detection to is_cloudflare_challenge in progress_parser.py**

- [ ] **Step 4: Add TLS fingerprint rotation to probe_backends.py**

Modify `probe_curl_cffi()` to accept an optional `chrome_versions` list. When a 403 is received, retry with each version before giving up:

```python
def probe_curl_cffi(url, cancel_event, headers=None, chrome_version=None, chrome_versions=None):
    # ... existing logic ...
    if chrome_versions and resp.status_code == 403:
        # Try alternate Chrome versions before giving up
        for alt_version in chrome_versions:
            if alt_version == chrome_version:
                continue
            # ... retry with alt_version ...
    # ...
```

- [ ] **Step 5: Add chrome_versions list to probe config in download_manager.py**

```python
# In _build_probe_configs():
# Add a list of Chrome versions to rotate through:
chrome_versions = ["131", "127", "124", "120", "chrome"]
```

- [ ] **Step 7: Add Cloudflare interactive solver flow (cloudflare_solver.js)**

Create `src/background/cloudflare_solver.js` — implements spec §5.3 browser-solver flow:

```javascript
// src/background/cloudflare_solver.js
"use strict";

/**
 * Cloudflare Interactive Solver
 *
 * Implements spec §5.3: when Turnstile/CAPTCHA is detected, navigate
 * the current tab to the CF-protected URL, wait for the user to manually
 * solve the challenge, extract the cf_clearance cookie, and inject it
 * into download backends.
 */

import * as cookieExtraction from "./cookie_extraction.js";

const CHECK_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes for user to solve
const CF_CLEARANCE_COOKIE = "cf_clearance";

/**
 * Full solver flow: navigate tab to URL, wait for user to solve,
 * extract cf_clearance cookie.
 *
 * @param {number} tabId
 * @param {string} url - The Cloudflare-protected URL to navigate to.
 * @param {Object} [options]
 * @param {number} [options.timeout=120000]
 * @returns {Promise<{solved: boolean, cfClearance?: string, error?: string}>}
 */
async function detectAndSolveCloudflare(tabId, url, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  // Step 1: Check if already solved (cf_clearance exists)
  let cfClearance = await extractCFClearance(tabId);
  if (cfClearance) {
    return { solved: true, cfClearance };
  }

  // Step 2: Navigate tab to the CF-protected URL to trigger challenge
  const navResult = await openCloudflarePage(tabId, url);
  if (!navResult.ok) {
    return { solved: false, error: `Could not navigate to ${url}` };
  }

  // Step 3: Wait for user to solve the challenge
  const waitResult = await waitForChallengeComplete(tabId, timeout);
  if (!waitResult.solved) {
    return { solved: false, error: "User did not complete the Cloudflare challenge within the timeout." };
  }

  // Step 4: Extract the cf_clearance cookie
  cfClearance = await extractCFClearance(tabId);
  if (!cfClearance) {
    return { solved: false, error: "Challenge appeared solved but cf_clearance cookie not found." };
  }

  return { solved: true, cfClearance };
}

/**
 * Navigate the tab to a Cloudflare-protected URL.
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<{ok: boolean}>}
 */
async function openCloudflarePage(tabId, url) {
  try {
    const api = typeof browser !== "undefined" ? browser : chrome;
    await api.tabs.update(tabId, { url });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * Poll for the cf_clearance cookie to appear, indicating the user solved
 * the Cloudflare challenge.
 *
 * @param {number} tabId
 * @param {number} timeoutMs - Max time to wait in ms.
 * @returns {Promise<{solved: boolean}>}
 */
async function waitForChallengeComplete(tabId, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const cfClearance = await extractCFClearance(tabId);
    if (cfClearance) {
      // Also verify the page is no longer showing a challenge
      const isChallenged = await isPageShowingChallenge(tabId);
      if (!isChallenged) {
        return { solved: true };
      }
    }
    await sleep(CHECK_INTERVAL_MS);
  }

  return { solved: false };
}

/**
 * Check if the page is still showing a Cloudflare challenge.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isPageShowingChallenge(tabId) {
  try {
    const api = typeof browser !== "undefined" ? browser : chrome;
    const result = await api.tabs.sendMessage(tabId, {
      type: "qwinCheckCloudflareChallenge",
    }).catch(() => null);
    if (result && result.hasChallenge === false) {
      return false;
    }
    // Fallback: check page title via CDP
    return true; // Assume still challenged if we can't verify
  } catch (_e) {
    return true;
  }
}

/**
 * Extract cf_clearance cookie from the tab.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function extractCFClearance(tabId) {
  try {
    const cookies = await cookieExtraction.extractCookies(tabId);
    const cf = cookies.find((c) => c.name === CF_CLEARANCE_COOKIE);
    return cf ? cf.value : null;
  } catch (_e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  detectAndSolveCloudflare,
  openCloudflarePage,
  waitForChallengeComplete,
  extractCFClearance,
};
```

- [ ] **Step 8: Write Cloudflare solver test**

```javascript
// tests/extension/background/test_cloudflare_solver.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const solver = await import("../../../src/background/cloudflare_solver.js");

  // Verify module exports
  assert.equal(typeof solver.detectAndSolveCloudflare, "function");
  assert.equal(typeof solver.openCloudflarePage, "function");
  assert.equal(typeof solver.waitForChallengeComplete, "function");
  assert.equal(typeof solver.extractCFClearance, "function");

  // Test that extractCFClearance gracefully handles missing cookies
  // (returns null without throwing)
  const result = await solver.extractCFClearance(9999); // bogus tab ID
  assert.equal(result, null, "Should return null for invalid tab without throwing");

  console.log("✓ All Cloudflare solver tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 8.5: Register cloudflare_solver.js in esbuild config**

Add `cloudflare_solver.js` to the background entry points in `scripts/build-bundles.js`.

- [ ] **Step 9: Run all Cloudflare tests**

Run: `python -m pytest tests/native-host/test_cloudflare_detection.py -v && npm run build:chromium && node tests/extension/background/test_cloudflare_solver.js`
Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/background/cloudflare_solver.js src/native_host/probe_backends.py src/native_host/progress_parser.py src/native_host/download_manager.py tests/native-host/test_cloudflare_detection.py tests/extension/background/test_cloudflare_solver.js scripts/build-bundles.js
git commit -m "feat(background): add Cloudflare interactive solver flow with user challenge resolution and cf_clearance extraction"
```

---
### Task 4: Service Worker Capture — Core Logic

**Files:**
- Create: `src/content/service_worker_capture.js` — SW registration + media response capture (spec §4.4)
- Create: `src/content/fetch_intercept.js` — fetch/XHR response stream capture for non-SW contexts (spec §4.1)
- Create: `tests/extension/content/test_service_worker_capture.js`

**Interfaces:**
- Produces: `service_worker_capture.js` exports:
  - `initMediaCaptureSW(): Promise<boolean>` — register SW, returns true if successful
  - `stopMediaCaptureSW(): Promise<void>` — unregister SW
  - `getCapturedResponses(): Array<Object>` — currently captured media responses
  - `clearCapturedResponses(): void`
  - `isSWActive(): boolean`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extension/content/test_service_worker_capture.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  // Import the module (functions are exported but work in non-SW contexts for testing)
  const swModule = await import("../../../src/content/service_worker_capture.js");

  // Test generateCaptureSWCode returns valid JS
  const swCode = swModule.generateCaptureSWCode();
  assert.ok(swCode, "generateCaptureSWCode must return a string");
  assert.ok(swCode.length > 100, "SW code must be substantial");
  assert.ok(swCode.includes("self.addEventListener"), "SW code must register a fetch listener");
  assert.ok(swCode.includes("MEDIA_TYPES"), "SW code must define MEDIA_TYPES regex");
  assert.ok(swCode.includes("postMessage"), "SW code must postMessage captured data");

  // Test MEDIA_TYPES pattern matches known media types
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("video/mp4"), "Must match video/mp4");
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("application/x-mpegURL"), "Must match HLS");
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("application/dash+xml"), "Must match DASH");
  assert.ok(!swModule.MEDIA_TYPE_REGEX || !swModule.MEDIA_TYPE_REGEX.test("text/html"), "Must NOT match text/html");

  // Test looksLikeSegment
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/seg-001.ts"), "Must detect .ts segments");
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/video.m4s"), "Must detect .m4s segments");
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/segment_123"), "Must detect segment in path");
  assert.ok(!swModule.looksLikeSegment("https://cdn.example.com/master.m3u8"), "Must NOT match manifests");

  // Test bufferToBase64
  const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
  const b64 = swModule.bufferToBase64(buffer);
  assert.equal(b64, "SGVsbG8=", "Must correctly encode ArrayBuffer to base64");

  console.log("✓ All service_worker_capture tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/extension/content/test_service_worker_capture.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/content/service_worker_capture.js
"use strict";

/**
 * Service Worker Media Capture Module
 *
 * Registers an ephemeral Service Worker on the page that intercepts ALL
 * network requests and captures response bodies for media content types.
 *
 * This catches:
 * - Fetches to M3U8/MPD manifests
 * - Segment fetches (TS, M4S, CMFA, CMFV)
 * - Direct MP4/WebM requests
 * - Range requests (HTTP 206 Partial Content)
 *
 * Architecture:
 *   Content Script → SW capture (in-page) → postMessage → Content Script
 *   → runtime.sendMessage → Background → Native Host
 *
 * Limitations:
 * - SW scope is limited to the page origin — cannot intercept cross-origin CDN
 *   requests directly (no CORS access to opaque responses).
 * - For cross-origin CDNs, falls back to CDP Network.enable as backup.
 * - Max 500MB per response capture, 2GB total per session.
 */

// ─── Constants ──────────────────────────────────────────────────────────

/** Regex that matches media Content-Type values we want to capture. */
const MEDIA_TYPE_REGEX = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;

/** Regex that matches segment URLs (not manifests). */
function looksLikeSegment(url) {
  return /\.(ts|m4s|cmfv|cmfa)(\?|$)/i.test(url) ||
         /\/seg(ment)?[-_]?\d+/i.test(url);
}

/** Regex that matches manifest URLs we want to capture separately. */
function looksLikeManifest(url) {
  return /\.(m3u8|mpd)(\?|$)/i.test(url);
}

/**
 * Convert an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generate the Service Worker code (runs in SW context) as a string.
 * This is injected as a blob URL to avoid needing a separate file.
 * @returns {string}
 */
function generateCaptureSWCode() {
  return `
    const MEDIA_TYPES = /^(video\\/|audio\\/|application\\/(x-mpegURL|vnd\\.apple\\.mpegURL|dash\\+xml)|text\\/vtt)/i;
    const SEGMENT_RE = /\\.(ts|m4s|cmfv|cmfa)(\\?|$)/i;
    let capturedCount = 0;
    const MAX_CAPTURES = 5000;
    const MAX_BYTES_PER_RESPONSE = 500 * 1024 * 1024; // 500MB
    let totalBytes = 0;
    const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

    self.addEventListener('fetch', (event) => {
      const url = event.request.url;
      // Skip non-HTTP(S) requests
      if (!url.startsWith('http')) return;

      // Pass through — we'll clone and inspect the response
      event.respondWith(handleFetch(event));
    });

    async function handleFetch(event) {
      try {
        const response = await fetch(event.request);
        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        // Check if this is media content
        if (MEDIA_TYPES.test(contentType) || looksLikeSegment(event.request.url) || looksLikeManifest(event.request.url)) {
          if (capturedCount < MAX_CAPTURES && totalBytes < MAX_TOTAL_BYTES) {
            const cloned = response.clone();
            const body = await cloned.arrayBuffer();

            if (body.byteLength <= MAX_BYTES_PER_RESPONSE && body.byteLength > 0) {
              capturedCount++;
              totalBytes += body.byteLength;

              const clientId = event.resultingClientId || event.clientId;
              if (clientId) {
                const client = await self.clients.get(clientId);
                if (client) {
                  client.postMessage({
                    type: 'qwinMediaResponse',
                    url: event.request.url,
                    contentType: contentType,
                    bodyLength: body.byteLength,
                    bodyB64: bufferToBase64(body),
                    status: response.status,
                    headers: JSON.stringify([...response.headers.entries()]),
                    isManifest: looksLikeManifest(event.request.url),
                    isSegment: looksLikeSegment(event.request.url),
                    capturedAt: Date.now(),
                  });
                }
              }
            }
          }
        }
        return response;
      } catch (e) {
        return fetch(event.request);
      }
    }

    function looksLikeSegment(url) {
      return SEGMENT_RE.test(url) || /\\/seg(ment)?[-_]?\\d+/i.test(url);
    }

    function looksLikeManifest(url) {
      return /\\.(m3u8|mpd)(\\?|$)/i.test(url);
    }

    function bufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
  `;
}

// ─── State ──────────────────────────────────────────────────────────────

/** @type {Array<{url: string, contentType: string, bodyLength: number, bodyB64: string, status: number, headers: string, isManifest: boolean, isSegment: boolean, capturedAt: number}>} */
const capturedResponses = [];

let swRegistration = null;
let swActive = false;
let messageHandler = null;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the media capture Service Worker on the current page.
 * @returns {Promise<boolean>} True if SW was registered successfully.
 */
async function initMediaCaptureSW() {
  if (swActive) {
    return true;
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  // Don't override an existing controlling SW
  if (navigator.serviceWorker.controller) {
    console.warn("[qwin] Page already has a Service Worker — not registering capture SW");
    return false;
  }

  try {
    const swCode = generateCaptureSWCode();
    const swBlob = new Blob([swCode], { type: "application/javascript" });
    const swURL = URL.createObjectURL(swBlob);

    const registration = await navigator.serviceWorker.register(swURL, {
      scope: window.location.pathname,
    });

    swRegistration = registration;
    swActive = true;

    // Set up message handler for incoming SW data
    setupMessageChannel();
    return true;
  } catch (e) {
    console.warn("[qwin] SW capture registration failed:", e);
    return false;
  }
}

/**
 * Set up the message channel to receive captured responses from the SW.
 */
function setupMessageChannel() {
  if (messageHandler) {
    navigator.serviceWorker.removeEventListener("message", messageHandler);
  }

  messageHandler = (event) => {
    if (event.data && event.data.type === "qwinMediaResponse") {
      capturedResponses.push({
        url: event.data.url,
        contentType: event.data.contentType,
        bodyLength: event.data.bodyLength,
        bodyB64: event.data.bodyB64,
        status: event.data.status,
        headers: event.data.headers,
        isManifest: event.data.isManifest,
        isSegment: event.data.isSegment,
        capturedAt: event.data.capturedAt,
      });

      // Forward to background script
      try {
        const api = typeof browser !== "undefined" ? browser : chrome;
        api.runtime.sendMessage({
          type: "swCapturedMediaResponse",
          data: event.data,
        }).catch(() => {});
      } catch (_e) {
        // Extension context may be unavailable
      }
    }
  };

  navigator.serviceWorker.addEventListener("message", messageHandler);
}

/**
 * Stop the media capture SW and clean up.
 * @returns {Promise<void>}
 */
async function stopMediaCaptureSW() {
  if (messageHandler) {
    try {
      navigator.serviceWorker.removeEventListener("message", messageHandler);
    } catch (_e) {}
    messageHandler = null;
  }

  if (swRegistration) {
    try {
      await swRegistration.unregister();
    } catch (_e) {}
    swRegistration = null;
  }

  swActive = false;
}

/**
 * Get all currently captured media responses.
 * @returns {Array<Object>}
 */
function getCapturedResponses() {
  return [...capturedResponses];
}

/**
 * Clear all captured responses from memory.
 */
function clearCapturedResponses() {
  capturedResponses.length = 0;
}

/**
 * Check if the capture SW is currently active.
 * @returns {boolean}
 */
function isSWActive() {
  return swActive;
}

export {
  initMediaCaptureSW,
  stopMediaCaptureSW,
  getCapturedResponses,
  clearCapturedResponses,
  isSWActive,
  // Exported for testing
  generateCaptureSWCode,
  MEDIA_TYPE_REGEX,
  looksLikeSegment,
  bufferToBase64,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/extension/content/test_service_worker_capture.js`
Expected: PASS with "All service_worker_capture tests passed"

- [ ] **Step 5: Commit**

```bash
git add src/content/service_worker_capture.js tests/extension/content/test_service_worker_capture.js
git commit -m "feat(content): add Service Worker media capture module"
```

---
### Task 5: SW Capture Integration — Content Script + Background Relay

**Files:**
- Modify: `src/content/content.js` — init SW capture during `start()`, init fetch_intercept
- Create: `src/background/sw_relay.js` — receive SW messages, forward to native host
- Create: `tests/extension/background/test_sw_relay.js`
- Modify: `src/native_host/host_dispatch.py` — handle `swSegmentBatch` message type
- Modify: `src/native_host/download_manager.py` — store SW segments for assembly
- Modify: `src/native_host/media_resolver.py` — enhanced page scanning with SW-extracted data (spec §11 existing files)

**Interfaces:**
- Consumes: `service_worker_capture.js` → `initMediaCaptureSW()`, `stopMediaCaptureSW()`
- Produces: `sw_relay.js` exports:
  - `init(): void` — register runtime message listener for SW data
  - `getPendingSegments(): Array` — segments waiting for native host processing
  - `flushSegments(jobId: string): void` — send to native host
- Modified `host_dispatch.py` handles `"swSegmentBatch"` message type

- [ ] **Step 1: Initialize SW capture in content.js**

Add to `start()` in `src/content/content.js`:

```javascript
// Initialize Service Worker media capture (best-effort)
import * as serviceWorkerCapture from "./service_worker_capture.js";

// Inside start(), after p2pDetection.init():
serviceWorkerCapture.initMediaCaptureSW().then((active) => {
  if (active) {
    console.log("[qwin] Service Worker media capture active");
  }
});
```

- [ ] **Step 2: Create sw_relay.js background module**

```javascript
// src/background/sw_relay.js
"use strict";

/**
 * SW Capture Relay Module
 *
 * Receives media responses captured by the Service Worker (via content script
 * runtime messages) and batches them for forwarding to the native host.
 * The native host receives the segments when a download is requested.
 */

/** @type {Array<{url: string, contentType: string, bodyB64: string, bodyLength: number, status: number, isManifest: boolean, isSegment: boolean, capturedAt: number}>} */
const pendingSegments = [];

/** @type {boolean} */
let initialized = false;

/**
 * Initialize the relay — register runtime message listener for SW data.
 */
function init() {
  if (initialized) return;
  initialized = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  api.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== "swCapturedMediaResponse") return false;

    const data = message.data;
    if (!data || !data.bodyB64) return false;

    // Store segment
    pendingSegments.push({
      url: data.url,
      contentType: data.contentType,
      bodyB64: data.bodyB64,
      bodyLength: data.bodyLength,
      status: data.status,
      isManifest: data.isManifest,
      isSegment: data.isSegment,
      capturedAt: data.capturedAt || Date.now(),
      tabId: sender.tab?.id,
    });

    // Trim if too many
    if (pendingSegments.length > 10000) {
      pendingSegments.splice(0, pendingSegments.length - 10000);
    }

    return false;
  });
}

/**
 * Get all pending segments for a given tab.
 * @param {number} tabId
 * @returns {Array}
 */
function getTabSegments(tabId) {
  return pendingSegments.filter((s) => s.tabId === tabId || !tabId);
}

/**
 * Get all pending segments (across all tabs).
 * @returns {Array}
 */
function getAllSegments() {
  return [...pendingSegments];
}

/**
 * Clear segments for a given job/tab.
 * @param {number} [tabId]
 */
function clearSegments(tabId) {
  if (tabId) {
    const ids = new Set();
    for (let i = pendingSegments.length - 1; i >= 0; i--) {
      if (pendingSegments[i].tabId === tabId) {
        pendingSegments.splice(i, 1);
      }
    }
  } else {
    pendingSegments.length = 0;
  }
}

export { init, getTabSegments, getAllSegments, clearSegments };
```

- [ ] **Step 3: Write relay test**

```javascript
// tests/extension/background/test_sw_relay.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const swRelay = await import("../../../src/background/sw_relay.js");

  // Verify initial state
  assert.equal(swRelay.getAllSegments().length, 0, "initial state should be empty");

  // Simulate receiving segments
  // (Cannot easily simulate runtime messages in Node test, but can test the data structure)
  const allSegments = swRelay.getAllSegments();
  assert.ok(Array.isArray(allSegments), "getAllSegments should return an array");

  // Test clearSegments
  swRelay.clearSegments();
  assert.equal(swRelay.getAllSegments().length, 0, "after clear, segments should be empty");

  console.log("✓ All sw_relay tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 4: Add swSegmentBatch message type to host_dispatch.py**

```python
# In host_dispatch.py handle_message(), add:
case "swSegmentBatch":
    # Receive batch of SW-captured segments for a download job
    deps.send_native_message({
        "type": "swSegmentBatchAck",
        "id": deps.request_id(message),
        "ok": True,
        "received": len(message.get("segments", [])),
    })
```

Also add `swSegmentBatch` function to host.py:

```python
# In host.py:
def run_sw_segment_batch(message):
    """Receive a batch of SW-captured segments and store for the job."""
    job_id = message.get("jobId", "")
    segments = message.get("segments", [])
    # Store segments in memory for the job
    if not hasattr(run_sw_segment_batch, "_segment_store"):
        run_sw_segment_batch._segment_store = {}
    if job_id not in run_sw_segment_batch._segment_store:
        run_sw_segment_batch._segment_store[job_id] = []
    run_sw_segment_batch._segment_store[job_id].extend(segments)
    return {
        "type": "swSegmentBatchAck",
        "id": message.get("id", ""),
        "ok": True,
        "received": len(segments),
        "total": len(run_sw_segment_batch._segment_store[job_id]),
    }
```

- [ ] **Step 5: Implement media_resolver.py enhanced scanning with SW-extracted data (spec §11)**

Modify `src/native_host/media_resolver.py` to accept SW-captured data when available. Add a new function `enhance_with_sw_data()` that merges SW-extracted media candidates with page-scanned candidates, prioritizing SW data (which has actual response bodies) over CDP extraction (which only has metadata):

```python
# In media_resolver.py, add:

def enhance_with_sw_data(candidates: list[dict], sw_segments: list[dict]) -> list[dict]:
    """Merge SW-captured media response data into media candidates list.
    
    When the Service Worker captures a media response, it has the actual
    body and Content-Type. This function enriches the media candidates
    with SW data, or adds new candidates for URLs the page scanner missed.
    """
    sw_urls = {s.get("url", "") for s in sw_segments if s.get("url")}
    seen_urls = {c.get("url", "") for c in candidates}
    
    enriched = list(candidates)
    for seg in sw_segments:
        url = seg.get("url", "")
        if url in sw_urls and url not in seen_urls:
            enriched.append({
                "url": url,
                "format": _detect_format_from_url(url),
                "mimeType": seg.get("contentType", ""),
                "source": "sw-capture",
                "bodyLength": seg.get("bodyLength", 0),
                "bodyB64": seg.get("bodyB64", ""),
            })
            seen_urls.add(url)
    
    return enriched

def _detect_format_from_url(url: str) -> str:
    from shared.media_protocols import MANIFEST_URL_RE, SEGMENT_URL_RE, DIRECT_MEDIA_RE
    if MANIFEST_URL_RE.search(url):
        return "manifest"
    elif SEGMENT_URL_RE.search(url):
        return "segment"
    elif DIRECT_MEDIA_RE.search(url):
        return "direct"
    return "unknown"
```

- [ ] **Step 5.5: Write media_resolver SW enhancement test**

```python
def test_enhance_with_sw_data_merges_new_urls(self):
    """SW data with URLs not in candidates list should be added."""
    candidates = [{"url": "https://example.com/video.mp4", "format": "direct"}]
    sw_segments = [
        {"url": "https://example.com/video.mp4", "contentType": "video/mp4", "bodyLength": 1000},  # duplicate
        {"url": "https://example.com/seg1.ts", "contentType": "video/mp2t", "bodyLength": 500},     # new
    ]
    result = enhance_with_sw_data(candidates, sw_segments)
    self.assertEqual(len(result), 2, "Should have original + 1 new entry")
    self.assertTrue(any("seg1.ts" in c["url"] for c in result), "Seg1 should be added")

def test_enhance_with_sw_data_empty_candidates(self):
    """With empty candidates, all SW data becomes candidates."""
    result = enhance_with_sw_data([], [
        {"url": "https://example.com/master.m3u8", "contentType": "application/x-mpegURL"}
    ])
    self.assertEqual(len(result), 1)
    self.assertEqual(result[0]["source"], "sw-capture")
```

- [ ] **Step 6: Commit**

```bash
git add src/content/content.js src/background/sw_relay.js tests/extension/background/test_sw_relay.js src/native_host/host_dispatch.py src/native_host/host.py src/native_host/media_resolver.py
git commit -m "feat(background): integrate SW capture with content script and native host relay, enhanced media_resolver with SW data"
```

---
### Task 6: CDP Tunnel Download

**Files:**
- Create: `src/background/cdp_tunnel_download.js`
- Create: `tests/extension/background/test_cdp_tunnel.js`

**Interfaces:**
- Produces: `cdp_tunnel_download.js` exports:
  - `tunnelSegmentDownload(tabId, url, requestHeaders?): Promise<{ok, data?, error?}>`
  - `tunnelManifestDownload(tabId, url): Promise<{ok, manifestContent?, error?}>`
  - `extractCfClearanceCookie(tabId): Promise<string|null>`
  - `cleanup()` — detach all CDP sessions

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extension/background/test_cdp_tunnel.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const tunnel = await import("../../../src/background/cdp_tunnel_download.js");

  // Test that module exports expected functions
  assert.equal(typeof tunnel.tunnelSegmentDownload, "function", "tunnelSegmentDownload must be a function");
  assert.equal(typeof tunnel.cleanup, "function", "cleanup must be a function");

  // Test buildFetchScript generates valid JS
  const url = "https://cdn.example.com/video/seg-001.m4s";
  const script = tunnel.buildFetchScript(url);
  assert.ok(script, "buildFetchScript must return a string");
  assert.ok(script.includes(url), "buildFetchScript must include the URL");
  assert.ok(script.includes("fetch("), "buildFetchScript must contain a fetch call");
  assert.ok(script.includes("arrayBuffer"), "buildFetchScript must convert to arrayBuffer");

  // Test with headers
  const headers = { Referer: "https://example.com", "User-Agent": "Mozilla/5.0" };
  const scriptWithHeaders = tunnel.buildFetchScript(url, headers);
  assert.ok(scriptWithHeaders.includes("Referer"), "buildFetchScript must include custom headers");

  // Test buildManifestFetchScript
  const manifestScript = tunnel.buildManifestFetchScript("https://cdn.example.com/hls/master.m3u8");
  assert.ok(manifestScript, "buildManifestFetchScript must return a string");
  assert.ok(manifestScript.includes("text"), "manifest fetch should return text, not arrayBuffer");

  console.log("✓ All cdp_tunnel tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:chromium && node tests/extension/background/test_cdp_tunnel.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/background/cdp_tunnel_download.js
"use strict";

/**
 * CDP Tunnel Download Module
 *
 * When all other download methods fail (Cloudflare blocks, DRM, broken
 * CDNs), this module tunnels download requests through the browser's
 * authenticated network stack via CDP-injected fetch() calls.
 *
 * Strategy:
 * 1. Attach chrome.debugger to the tab
 * 2. Inject a fetch() call via Runtime.evaluate that returns the response
 * 3. Convert the ArrayBuffer response to base64 and return it
 * 4. Assemble segments in the background
 *
 * Limitations:
 * - Each fetch consumes tab resources — limit to 4 concurrent tunnels
 * - Large responses (>100MB) should be streamed, not loaded entirely in memory
 * - The tab must remain open during the entire tunnel download
 */

// ─── Active CDP sessions ───────────────────────────────────────────────

/** @type {Map<number, boolean>} */
const activeSessions = new Map();

// ─── CDP helpers ───────────────────────────────────────────────────────

function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }
  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || "Failed to attach debugger" });
          return;
        }
        activeSessions.set(tabId, true);
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

function detach(tabId) {
  if (!activeSessions.has(tabId)) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        activeSessions.delete(tabId);
        resolve();
      });
    } catch (_e) {
      activeSessions.delete(tabId);
      resolve();
    }
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    if (!activeSessions.has(tabId)) {
      resolve({ ok: false, error: "Debugger not attached" });
      return;
    }
    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

// ─── Script Building ──────────────────────────────────────────────────

/**
 * Build a fetch expression that downloads a segment and returns base64 data.
 * @param {string} url
 * @param {Object} [headers]
 * @returns {string}
 */
function buildFetchScript(url, headers) {
  const headerStr = JSON.stringify(headers || {});
  return `(async function(){
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "GET",
        credentials: "include",
        headers: ${headerStr}
      });
      if (!r.ok) return {ok:false,status:r.status,statusText:r.statusText};
      const b = await r.arrayBuffer();
      const bytes = new Uint8Array(b);
      let bin = "";
      for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      const contentType = r.headers.get("content-type") || "";
      return {ok:true,data:btoa(bin),byteLength:b.byteLength,contentType:contentType};
    } catch(e) {
      return {ok:false,error:e.message};
    }
  })()`;
}

/**
 * Build a fetch expression that downloads a manifest and returns text.
 * @param {string} url
 * @param {Object} [headers]
 * @returns {string}
 */
function buildManifestFetchScript(url, headers) {
  const headerStr = JSON.stringify(headers || {});
  return `(async function(){
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "GET",
        credentials: "include",
        headers: ${headerStr}
      });
      if (!r.ok) return {ok:false,status:r.status,statusText:r.statusText};
      const text = await r.text();
      return {ok:true,data:text,contentType:r.headers.get("content-type")||""};
    } catch(e) {
      return {ok:false,error:e.message};
    }
  })()`;
}

// ─── Tunnel Download ───────────────────────────────────────────────────

/**
 * Download a single segment through the browser tunnel.
 * @param {number} tabId
 * @param {string} url
 * @param {Object} [requestHeaders]
 * @param {Object} [options]
 * @param {number} [options.timeout=30000]
 * @returns {Promise<{ok: boolean, data?: string, byteLength?: number, contentType?: string, status?: number, error?: string}>}
 */
async function tunnelSegmentDownload(tabId, url, requestHeaders, options = {}) {
  const timeout = options.timeout || 30000;

  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, error: `Could not attach debugger: ${attachResult.error}` };
  }

  const script = buildFetchScript(url, requestHeaders);
  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeout,
  });

  if (!evalResult.ok) {
    return { ok: false, error: evalResult.error || "Runtime.evaluate failed" };
  }

  const result = evalResult.result?.result?.value;
  if (!result) {
    return { ok: false, error: "No result from fetch evaluation" };
  }

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error || `HTTP ${result.status || "error"}` };
  }

  return {
    ok: true,
    data: result.data,
    byteLength: result.byteLength,
    contentType: result.contentType,
  };
}

/**
 * Download a manifest (M3U8/MPD) through the browser tunnel.
 * @param {number} tabId
 * @param {string} url
 * @param {Object} [requestHeaders]
 * @returns {Promise<{ok: boolean, data?: string, contentType?: string, error?: string}>}
 */
async function tunnelManifestDownload(tabId, url, requestHeaders) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, error: `Could not attach debugger: ${attachResult.error}` };
  }

  const script = buildManifestFetchScript(url, requestHeaders);
  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: true,
    timeout: 15000,
  });

  if (!evalResult.ok) {
    return { ok: false, error: evalResult.error };
  }

  const result = evalResult.result?.result?.value;
  if (!result || !result.ok) {
    return { ok: false, error: result?.error || "Manifest fetch failed" };
  }

  return {
    ok: true,
    data: result.data,
    contentType: result.contentType,
  };
}

/**
 * Extract cf_clearance cookie from the tab (for Cloudflare bypass).
 * @param {number} tabId
 * @returns {Promise<string|null>} The cf_clearance cookie value, or null.
 */
async function extractCfClearanceCookie(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) return null;

  const cmdResult = await sendCommand(tabId, "Network.getAllCookies");
  if (!cmdResult.ok || !cmdResult.result) return null;

  const cookies = cmdResult.result.cookies || [];
  const cfClearance = cookies.find((c) => c.name === "cf_clearance");
  return cfClearance ? cfClearance.value : null;
}

/**
 * Clean up all active CDP sessions.
 */
async function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    await detach(tabId);
  }
}

export {
  tunnelSegmentDownload,
  tunnelManifestDownload,
  extractCfClearanceCookie,
  cleanup,
  // Exported for testing
  buildFetchScript,
  buildManifestFetchScript,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_cdp_tunnel.js`
Expected: PASS with "All cdp_tunnel tests passed"

- [ ] **Step 5: Commit**

```bash
git add src/background/cdp_tunnel_download.js tests/extension/background/test_cdp_tunnel.js
git commit -m "feat(background): add CDP tunnel download module for Cloudflare-bypassed downloads"
```

---
### Task 7: Integrate CDP Tunnel into Download Orchestration

**Files:**
- Modify: `src/background/download_orchestration.js` — add CDP tunnel as final fallback layer
- Modify: `src/background/download_helpers.js` — add tunnel-related helpers

**Interfaces:**
- Consumes: `cdp_tunnel_download.js` → `tunnelSegmentDownload()`, `tunnelManifestDownload()`
- Produces: Extended fallback chain in `startNativeDownloadFromVideo()` → when all native methods fail and browser download is not applicable, try CDP tunnel

- [ ] **Step 1: Add CDP tunnel fallback to download_orchestration.js**

In `startNativeDownloadFromVideo()`, after the native host `port.onMessage` error handler tries all fallback videos, add a check: if the video is segmented (HLS/DASH) and the format is not browser-downloadable, try CDP tunnel for each segment.

```javascript
// In the error handler, after all fallback videos are exhausted:
// Check if CDP tunnel should be attempted
if (isSegmentedDownloadJob(video) && tabId) {
  deps.updateDownload(jobId, {
    status: "connecting",
    error: "",
    message: "All native sources failed; trying CDP tunnel through browser...",
    ...artifactPatch,
  });
  try {
    const tunnelResult = await deps.tunnelDownload(jobId, tabId, video, attemptedUrls);
    if (tunnelResult && tunnelResult.ok) {
      return;
    }
  } catch (_tunnelError) {
    // Tunnel failed — fall through to final error
  }
}
```

- [ ] **Step 2: Register CDP tunnel in deps**

Add to the deps passed to `create()` in download_orchestration.js:

```javascript
import * as cdpTunnel from "./cdp_tunnel_download.js";
```

And add a `tunnelDownload` method to the object returned by `create()`.

- [ ] **Step 3: Commit**

```bash
git add src/background/download_orchestration.js src/background/download_helpers.js
git commit -m "feat(background): integrate CDP tunnel as final download fallback layer"
```

---
### Task 8: New Message Types in Host Dispatch + Integration

**Files:**
- Modify: `src/native_host/host_dispatch.py` — add `swSegmentBatch`, `tunnelDownloadRequest` handlers
- Modify: `src/native_host/host.py` — expose new dispatch functions

- [ ] **Step 1: Add swSegmentBatch handler to host_dispatch.py**

```python
case "swSegmentBatch":
    result = deps.run_sw_segment_batch(message)
    deps.send_native_message(result)
```

- [ ] **Step 2: Add tunnelDownloadRequest handler**

```python
case "tunnelDownloadRequest":
    deps.send_native_message({
        "type": "tunnelDownloadAck",
        "id": deps.request_id(message),
        "ok": True,
        "message": "Tunnel download request forwarded. Results arrive via CDP tunnel.",
    })
```

- [ ] **Step 3: add run_sw_segment_batch to host.py deps**

```python
def run_sw_segment_batch(message):
    # Store SW-captured segments in memory
    job_id = message.get("jobId", "")
    segments = message.get("segments", [])
    # Forward to download manager for assembly
    ...
```

- [ ] **Step 4: Commit**

```bash
git add src/native_host/host_dispatch.py src/native_host/host.py
git commit -m "feat(native): add SW segment batch and tunnel download message types"
```

---
### Task 9: Integration Tests

**Files:**
- Create: `tests/extension/background/test_cdp_tunnel.js` (already done in Task 6)
- Create: `tests/extension/content/test_service_worker_capture.js` (already done in Task 4)
- Create: `tests/extension/background/test_sw_relay.js` (already done in Task 5)
- Create: `tests/native-host/test_cookie_injection.py` (referenced in Task 2)

**End-to-end test:**

- [ ] **Step 1: Build the extension**

Run: `npm run build:chromium`

- [ ] **Step 2: Run all extension tests**

Run: `node tests/extension/background/test_cookie_extraction.js && node tests/extension/background/test_cdp_tunnel.js && node tests/extension/content/test_service_worker_capture.js && node tests/extension/background/test_sw_relay.js`
Expected: All tests PASS

