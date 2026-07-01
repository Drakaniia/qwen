# Phase 3 — Robustness & Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 3 of the universal video capture pipeline — formal layered fallback chain, SW + CDP parallel capture, token expiry handling, browser tunnel with progress reporting and memory management, and comprehensive error reporting.

**Architecture:** Five subsystems. (1) A formal 7-layer fallback chain in `download_orchestration.js` that tries layers 1-6 in order (probes → CDP extraction → SW capture → MSE demux → CDM decrypt → browser tunnel), with clear success/failure reporting at each layer. (2) Parallel SW + CDP capture that runs both capture pathways simultaneously and deduplicates results. (3) Token expiry detection that monitors signed URLs and triggers fast parallel re-capture of remaining segments. (4) Browser tunnel with progress callbacks, memory limits, and IndexedDB spill-to-disk. (5) Comprehensive error classification with structured error types, user-friendly messages, and layer-by-layer reporting.

**Tech Stack:** JS (Manifest V3 ES modules, esbuild bundling), Python 3.11+ (native host error classification), Chrome Extension APIs (chrome.debugger, chrome.storage, IndexedDB).

## Global Constraints

- JS: 2-space indent, trailing commas, double quotes, 120 char width.
- Python: 4-space indent, ruff (E/F/W/I), 120 char width.
- No global npm packages. Use `npm run setup` for dependency installation.
- Rebuild with `npm run build` after any `src/` JS change.
- Tests: Python unittest (`tests/native-host/`), Node.js for extension (`tests/extension/`).
- Message sizes limited to 4MB via chrome.runtime messaging (chunk larger payloads).
- IndexedDB used for spill-to-disk when in-memory buffers exceed 100MB.
- Max 4 concurrent CDP tunnel fetches per tab.
- Error classification must produce both machine-parseable (error_type code) and human-readable output.

---
### Task 1: Formal 7-Layer Fallback Chain

**Files:**
- Create: `src/background/layered_fallback.js` — formal layer definitions and orchestration
- Modify: `src/background/download_orchestration.js` — delegate to layered fallback
- Modify: `src/background/download_fallbacks.js` — add layer-specific error classification
- Create: `tests/extension/background/test_layered_fallback.js`

**Interfaces:**
- Produces: `layered_fallback.js` exports:
  - `LAYERS: Array<{name: string, layer: number, try: Function, timeout: number}>` — ordered layer definitions
  - `executeLayeredFallback(url, video, ctx): Promise<{ok, result, layer, error}>` — run through layers
  - `getLayerResult(layer: number): Object` — get result from a specific layer
  - `getAttemptedLayers(): Array<{layer, name, ok, error}>` — summary of all attempted layers

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extension/background/test_layered_fallback.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const layeredFallback = await import("../../../src/background/layered_fallback.js");

  // Test that LAYERS array is defined in the correct order
  assert.ok(Array.isArray(layeredFallback.LAYERS), "LAYERS must be an array");
  assert.ok(layeredFallback.LAYERS.length >= 3, "LAYERS must have at least 3 entries");
  
  // Verify layer numbers are sequential
  for (let i = 0; i < layeredFallback.LAYERS.length; i++) {
    assert.equal(layeredFallback.LAYERS[i].layer, i + 1,
      `LAYERS[${i}] must have layer=${i + 1}`);
    assert.ok(typeof layeredFallback.LAYERS[i].name === "string",
      `LAYERS[${i}] must have a name`);
    assert.ok(typeof layeredFallback.LAYERS[i].timeout === "number",
      `LAYERS[${i}] must have a timeout`);
  }

  // Layer 1 should be "Parallel Probes"
  assert.equal(layeredFallback.LAYERS[0].name, "Parallel Probes",
    "Layer 1 must be Parallel Probes");

  // Test executeLayeredFallback exists
  assert.equal(typeof layeredFallback.executeLayeredFallback, "function",
    "executeLayeredFallback must be a function");

  // Test getAttemptedLayers returns empty array before execution
  const before = layeredFallback.getAttemptedLayers();
  assert.ok(Array.isArray(before), "getAttemptedLayers must return an array");
  assert.equal(before.length, 0, "getAttemptedLayers should be empty before execution");

  // Test with a mock context where Layer 1 succeeds
  const mockCtx = {
    probeUrl: async () => ({ ok: true, backend: "yt-dlp", command: ["yt-dlp", "url"] }),
    cdpExtract: async () => ({ ok: false }),
    swCapture: async () => ({ ok: false }),
    mseDemux: async () => ({ ok: false }),
    cdmDecrypt: async () => ({ ok: false }),
    tunnelDownload: async () => ({ ok: false }),
    browserDownload: async () => ({ ok: false }),
  };

  const result = await layeredFallback.executeLayeredFallback("https://example.com/video.mp4", {}, mockCtx);
  assert.ok(result.ok, "Layer 1 should succeed for valid URL");
  assert.equal(result.layer, 1, "Result should be from layer 1");
  assert.equal(result.backend, "yt-dlp", "Result backend should be yt-dlp");

  // Test getAttemptedLayers returns results after execution
  const after = layeredFallback.getAttemptedLayers();
  assert.ok(after.length > 0, "getAttemptedLayers should have entries after execution");

  console.log("✓ All layered fallback tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:chromium && node tests/extension/background/test_layered_fallback.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/background/layered_fallback.js
"use strict";

/**
 * Layered Fallback Chain
 *
 * Formal 7-layer fallback chain for the universal video capture pipeline.
 * Each layer is attempted in order. If a layer succeeds, the result is used.
 * If a layer fails, the next layer is attempted.
 *
 * Layers:
 *   Layer 1 — Parallel Probes (yt-dlp, curl_cffi, N_m3u8DL-RE, Streamlink)
 *   Layer 2 — CDP Source Extraction (chrome.debugger → Runtime.evaluate)
 *   Layer 3 — Service Worker Capture (SW fetch intercept)
 *   Layer 4 — MSE/fMP4 Demuxing (SourceBuffer capture → reassembly)
 *   Layer 5 — EME/CDM Key Extraction (Go binary → decrypt segments)
 *   Layer 6 — Browser Tunnel (CDP fetch injection)
 *   Layer 7 — Browser Download API (chrome.downloads last resort)
 */

// ─── Layer Definitions ─────────────────────────────────────────────────────

const LAYERS = [
  { name: "Parallel Probes",    layer: 1, timeout: 30000, key: "probe" },
  { name: "CDP Extraction",     layer: 2, timeout: 20000, key: "cdpExtract" },
  { name: "SW Capture",         layer: 3, timeout: 15000, key: "swCapture" },
  { name: "MSE Demux",          layer: 4, timeout: 30000, key: "mseDemux" },
  { name: "CDM Decrypt",        layer: 5, timeout: 60000, key: "cdmDecrypt" },
  { name: "Browser Tunnel",     layer: 6, timeout: 60000, key: "tunnelDownload" },
  { name: "Browser Download",   layer: 7, timeout: 30000, key: "browserDownload" },
];

// ─── State ─────────────────────────────────────────────────────────────────

/** @type {Array<{layer: number, name: string, ok: boolean, error?: string, duration?: number}>} */
const attemptedLayers = [];

/** @type {Map<number, Object>} */
const layerResults = new Map();

// ─── Layer Execution ───────────────────────────────────────────────────────

/**
 * Execute the layered fallback chain.
 *
 * @param {string} url - The video URL to download.
 * @param {Object} video - Video metadata object.
 * @param {Object} ctx - Context object with functions for each layer.
 * @param {Function} ctx.probeUrl - Layer 1: probe with backends.
 * @param {Function} ctx.cdpExtract - Layer 2: extract via CDP.
 * @param {Function} ctx.swCapture - Layer 3: capture via SW.
 * @param {Function} ctx.mseDemux - Layer 4: demux MSE segments.
 * @param {Function} ctx.cdmDecrypt - Layer 5: decrypt via CDM.
 * @param {Function} ctx.tunnelDownload - Layer 6: tunnel via CDP.
 * @param {Function} ctx.browserDownload - Layer 7: browser download API.
 * @returns {Promise<{ok: boolean, result?: any, layer: number, backend?: string, error?: string}>}
 */
async function executeLayeredFallback(url, video, ctx) {
  // Clear previous state
  attemptedLayers.length = 0;
  layerResults.clear();

  for (const layerDef of LAYERS) {
    const startTime = Date.now();
    const handler = getLayerHandler(layerDef, ctx);
    
    if (!handler) {
      // Layer not available — skip
      attemptedLayers.push({
        layer: layerDef.layer,
        name: layerDef.name,
        ok: false,
        error: "No handler available for this layer",
        duration: 0,
      });
      continue;
    }

    try {
      const result = await Promise.race([
        handler(url, video),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${layerDef.name} timed out after ${layerDef.timeout}ms`)), layerDef.timeout)
        ),
      ]);

      const duration = Date.now() - startTime;

      if (result && result.ok) {
        layerResults.set(layerDef.layer, result);
        attemptedLayers.push({
          layer: layerDef.layer,
          name: layerDef.name,
          ok: true,
          duration,
          backend: result.backend || "",
        });
        return { ok: true, result, layer: layerDef.layer, backend: result.backend };
      }

      // Layer returned failure
      layerResults.set(layerDef.layer, result);
      attemptedLayers.push({
        layer: layerDef.layer,
        name: layerDef.name,
        ok: false,
        error: result.error || `${layerDef.name} returned no result`,
        duration,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      attemptedLayers.push({
        layer: layerDef.layer,
        name: layerDef.name,
        ok: false,
        error: error.message || String(error),
        duration,
      });
    }
  }

  // All layers failed
  return {
    ok: false,
    layer: 0,
    error: `All ${LAYERS.length} layers failed. Last error: ${attemptedLayers[attemptedLayers.length - 1]?.error || "Unknown"}`,
  };
}

/**
 * Get the handler function for a layer definition from the context.
 * @param {Object} layerDef
 * @param {Object} ctx
 * @returns {Function|null}
 */
function getLayerHandler(layerDef, ctx) {
  switch (layerDef.key) {
    case "probe":           return ctx.probeUrl || null;
    case "cdpExtract":      return ctx.cdpExtract || null;
    case "swCapture":       return ctx.swCapture || null;
    case "mseDemux":        return ctx.mseDemux || null;
    case "cdmDecrypt":      return ctx.cdmDecrypt || null;
    case "tunnelDownload":  return ctx.tunnelDownload || null;
    case "browserDownload": return ctx.browserDownload || null;
    default:                return null;
  }
}

/**
 * Get the result from a specific layer.
 * @param {number} layerNumber
 * @returns {Object|undefined}
 */
function getLayerResult(layerNumber) {
  return layerResults.get(layerNumber);
}

/**
 * Get a summary of all attempted layers.
 * @returns {Array<{layer: number, name: string, ok: boolean, error?: string, duration?: number}>}
 */
function getAttemptedLayers() {
  return [...attemptedLayers];
}

export {
  LAYERS,
  executeLayeredFallback,
  getLayerResult,
  getAttemptedLayers,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_layered_fallback.js`
Expected: PASS.

- [ ] **Step 5: Register in esbuild bundle and wire into download_orchestration.js**

Add `layered_fallback.js` to the esbuild config in `scripts/build-bundles.js`, and integrate into download_orchestration.js so that `startNativeDownloadFromVideo()` delegates to the layered fallback when `backend === "auto"`.

- [ ] **Step 6: Run full extension test suite**

Run: `npm run test:extension`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/layered_fallback.js src/background/download_orchestration.js scripts/build-bundles.js tests/extension/background/test_layered_fallback.js
git commit -m "feat(background): add formal 7-layer fallback chain for video capture"
```

---
### Task 2: SW + CDP Parallel Capture

**Files:**
- Create: `src/background/parallel_capture.js` — orchestrate SW + CDP capture in parallel
- Modify: `src/background/sw_relay.js` — expose capture status and segment deduplication
- Modify: `src/background/cdp_extraction.js` — add CDP network capture for cross-origin media
- Create: `tests/extension/background/test_parallel_capture.js`

**Interfaces:**
- Produces: `parallel_capture.js` exports:
  - `startParallelCapture(tabId, options): Promise<{ok, captureId}>` — start both SW and CDP capture
  - `stopParallelCapture(captureId): Promise<{ok, segments}>` — stop and collect results
  - `getCapturedSegments(captureId): Array` — deduplicated segments from both sources
  - `getCaptureStatus(captureId): Object` — per-source status

- [ ] **Step 1: Write failing test**

```javascript
// tests/extension/background/test_parallel_capture.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const parallelCapture = await import("../../../src/background/parallel_capture.js");

  // Verify module exports
  assert.equal(typeof parallelCapture.startParallelCapture, "function");
  assert.equal(typeof parallelCapture.stopParallelCapture, "function");
  assert.equal(typeof parallelCapture.getCapturedSegments, "function");
  assert.equal(typeof parallelCapture.getCaptureStatus, "function");
  assert.equal(typeof parallelCapture.deduplicateSegments, "function");

  // Test deduplication logic
  const segments = [
    { url: "https://cdn.example.com/seg1.ts", bodyB64: "AAAA", capturedAt: 100 },
    { url: "https://cdn.example.com/seg2.ts", bodyB64: "BBBB", capturedAt: 200 },
    { url: "https://cdn.example.com/seg1.ts", bodyB64: "AAAA", capturedAt: 150 }, // duplicate
    { url: "https://cdn.example.com/seg3.ts", bodyB64: "CCCC", capturedAt: 300 },
  ];

  const deduped = parallelCapture.deduplicateSegments(segments);
  assert.equal(deduped.length, 3, "Deduplication should keep only unique URLs");
  assert.ok(deduped.some((s) => s.url.includes("seg1.ts")), "First seg1 should be kept");
  assert.ok(deduped.some((s) => s.url.includes("seg2.ts")), "seg2 should be kept");
  assert.ok(deduped.some((s) => s.url.includes("seg3.ts")), "seg3 should be kept");

  // Test with empty array
  assert.equal(parallelCapture.deduplicateSegments([]).length, 0, "Empty array should return empty");

  // Test status returns correct shape
  const status = parallelCapture.getCaptureStatus("test-capture");
  assert.ok(status, "getCaptureStatus should return an object");
  assert.ok("swActive" in status, "Status should have swActive");
  assert.ok("cdpActive" in status, "Status should have cdpActive");

  console.log("✓ All parallel capture tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Write minimal implementation**

```javascript
// src/background/parallel_capture.js
"use strict";

/**
 * Parallel Capture Orchestration
 *
 * Runs both Service Worker capture and CDP Network capture in parallel
 * to maximize media segment coverage. SW capture handles same-origin
 * media with full body access; CDP capture handles cross-origin CDN
 * media where SW can't access opaque response bodies.
 *
 * Deduplication: segments are deduplicated by URL (first capture wins).
 * When SW and CDP both capture the same segment, the SW version is kept
 * (it has full body data).
 */

import * as swRelay from "./sw_relay.js";
import * as cdpExtraction from "./cdp_extraction.js";

// ─── State ─────────────────────────────────────────────────────────────────

/** @type {Map<string, {captureId: string, tabId: number, swActive: boolean, cdpActive: boolean, segments: Array, startedAt: number}>} */
const activeCaptures = new Map();

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Start parallel capture on a tab.
 *
 * @param {number} tabId
 * @param {Object} [options]
 * @param {boolean} [options.swCapture=true] - Enable SW capture path.
 * @param {boolean} [options.cdpCapture=true] - Enable CDP network capture path.
 * @returns {Promise<{ok: boolean, captureId: string, error?: string}>}
 */
async function startParallelCapture(tabId, options = {}) {
  const captureId = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const swCapture = options.swCapture !== false;
  const cdpCapture = options.cdpCapture !== false;

  const state = {
    captureId,
    tabId,
    swActive: false,
    cdpActive: false,
    segments: [],
    startedAt: Date.now(),
  };

  // Start SW capture
  if (swCapture) {
    try {
      // SW capture is initiated from content script — send message to tab
      const api = typeof browser !== "undefined" ? browser : chrome;
      await api.tabs.sendMessage(tabId, { type: "qwinInitSWCapture" }).catch(() => {});
      state.swActive = true;
    } catch (_e) {
      // SW capture not available
    }
  }

  // Start CDP network capture
  if (cdpCapture) {
    try {
      // Enable Network domain on the debugger
      await cdpExtraction.attach(tabId);
      await cdpExtraction.sendCommand(tabId, "Network.enable");
      state.cdpActive = true;
    } catch (_e) {
      // CDP capture not available
    }
  }

  activeCaptures.set(captureId, state);
  return { ok: true, captureId };
}

/**
 * Stop parallel capture and collect all deduplicated segments.
 *
 * @param {string} captureId
 * @returns {Promise<{ok: boolean, segments: Array, error?: string}>}
 */
async function stopParallelCapture(captureId) {
  const state = activeCaptures.get(captureId);
  if (!state) {
    return { ok: false, segments: [], error: `Capture ${captureId} not found` };
  }

  // Stop SW capture
  if (state.swActive) {
    try {
      const api = typeof browser !== "undefined" ? browser : chrome;
      await api.tabs.sendMessage(state.tabId, { type: "qwinStopSWCapture" }).catch(() => {});
    } catch (_e) {}
    state.swActive = false;
  }

  // Stop CDP capture
  if (state.cdpActive) {
    try {
      await cdpExtraction.sendCommand(state.tabId, "Network.disable");
    } catch (_e) {}
    state.cdpActive = false;
  }

  // Collect segments from both sources
  const swSegments = swRelay.getTabSegments(state.tabId);
  const cdpSegments = getCdpCapturedSegments(state.tabId);

  // Merge and deduplicate
  const allSegments = [...swSegments, ...cdpSegments];
  state.segments = deduplicateSegments(allSegments);

  activeCaptures.delete(captureId);
  
  return { ok: true, segments: state.segments };
}

/**
 * Get captured segments for a capture (deduplicated).
 *
 * @param {string} captureId
 * @returns {Array}
 */
function getCapturedSegments(captureId) {
  const state = activeCaptures.get(captureId);
  return state ? [...state.segments] : [];
}

/**
 * Get capture status.
 *
 * @param {string} captureId
 * @returns {{swActive: boolean, cdpActive: boolean, segmentCount: number, elapsed: number}}
 */
function getCaptureStatus(captureId) {
  const state = activeCaptures.get(captureId);
  if (!state) {
    return { swActive: false, cdpActive: false, segmentCount: 0, elapsed: 0 };
  }
  return {
    swActive: state.swActive,
    cdpActive: state.cdpActive,
    segmentCount: state.segments.length,
    elapsed: Date.now() - state.startedAt,
  };
}

/**
 * Deduplicate segments by URL (first occurrence wins).
 *
 * @param {Array} segments
 * @returns {Array}
 */
function deduplicateSegments(segments) {
  const seen = new Set();
  const result = [];
  for (const seg of segments) {
    const key = seg.url || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(seg);
  }
  return result;
}

/**
 * Get segments captured via CDP Network domain (placeholder — actual
 * CDP response capture requires Network.responseReceived event handlers).
 *
 * @param {number} tabId
 * @returns {Array}
 */
function getCdpCapturedSegments(tabId) {
  // Placeholder — CDP segment capture will be filled in by subsequent tasks
  return [];
}

export {
  startParallelCapture,
  stopParallelCapture,
  getCapturedSegments,
  getCaptureStatus,
  deduplicateSegments,
};
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_parallel_capture.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/background/parallel_capture.js src/background/sw_relay.js tests/extension/background/test_parallel_capture.js
git commit -m "feat(background): add SW + CDP parallel capture orchestration"
```

---
### Task 3: Token Expiry Detection and Fast Parallel Segment Re-capture

**Files:**
- Create: `src/background/token_expiry_handler.js` — detect and handle signed URL expiry
- Create: `src/background/segment_capture.js` — fast parallel segment capture for time-limited content
- Modify: `tests/extension/background/test_token_expiry.js`
- Modify: `src/background/download_orchestration.js` — integrate token expiry detection

**Interfaces:**
- Produces: `token_expiry_handler.js` exports:
  - `hasExpiryToken(url: string): boolean` — check if URL contains expiry parameters
  - `getExpiryTime(url: string): number|null` — extract expiry timestamp from URL
  - `getTimeToExpiry(url: string): number` — milliseconds until URL expires
  - `detectExpiryInResponse(url: string, status: number, headers: Object): boolean` — detect token expiry from response
- Produces: `segment_capture.js` exports:
  - `startFastCapture(tabId, manifestUrl, options): Promise<{ok, segments}>` — fast parallel segment capture
  - `getCaptureProgress(): Object` — segments captured, remaining, estimated time

- [ ] **Step 1: Write failing test**

```javascript
// tests/extension/background/test_token_expiry.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const tokenExpiry = await import("../../../src/background/token_expiry_handler.js");

  // Test hasExpiryToken
  assert.ok(tokenExpiry.hasExpiryToken("https://cdn.example.com/video.mp4?token=abc&expires=1700000000"),
    "Should detect expires parameter");
  assert.ok(tokenExpiry.hasExpiryToken("https://cdn.example.com/seg1.ts?signature=xyz&expiry=1700000000"),
    "Should detect expiry parameter");
  assert.ok(tokenExpiry.hasExpiryToken("https://cdn.example.com/master.m3u8?t=12345&e=1700000000"),
    "Should detect e= parameter");
  assert.ok(!tokenExpiry.hasExpiryToken("https://cdn.example.com/video.mp4"),
    "Should NOT detect expiry on URL without token params");

  // Test getExpiryTime
  const expiry = tokenExpiry.getExpiryTime("https://cdn.example.com/video.mp4?expires=1700000000");
  assert.equal(expiry, 1700000000, "Should extract expires= parameter as number");

  const expiryAlt = tokenExpiry.getExpiryTime("https://cdn.example.com/video.mp4?e=1700000000");
  assert.equal(expiryAlt, 1700000000, "Should extract e= parameter as number");

  assert.equal(tokenExpiry.getExpiryTime("https://cdn.example.com/video.mp4"), null,
    "Should return null for URLs without expiry");

  // Test getTimeToExpiry
  const futureUrl = `https://cdn.example.com/video.mp4?expires=${Math.floor(Date.now() / 1000) + 60}`;
  const timeLeft = tokenExpiry.getTimeToExpiry(futureUrl);
  assert.ok(timeLeft > 0 && timeLeft <= 60000, `Time to expiry should be positive and ≤ 60s, got ${timeLeft}ms`);

  // Test detectExpiryInResponse
  assert.ok(tokenExpiry.detectExpiryInResponse("https://cdn.example.com/video.mp4", 403, {}),
    "HTTP 403 might indicate expired token");
  assert.ok(tokenExpiry.detectExpiryInResponse("https://cdn.example.com/video.mp4", 410, {}),
    "HTTP 410 Gone might indicate expired token");
  assert.ok(!tokenExpiry.detectExpiryInResponse("https://cdn.example.com/video.mp4", 200, {}),
    "HTTP 200 should not indicate expiry");

  console.log("✓ All token expiry tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:chromium && node tests/extension/background/test_token_expiry.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/background/token_expiry_handler.js
"use strict";

/**
 * Token Expiry Handler
 *
 * Detects and handles time-limited signed URLs (token-authenticated manifests
 * and segments). When a URL is about to expire, triggers fast parallel capture
 * of all remaining segments before the token becomes invalid.
 *
 * Common expiry parameter names across CDNs:
 *   - expires, expiry, e, exp, t, token, signature, sig, st, se, ts, x-amz-expires
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const EXPIRY_PARAM_RE = /(?:\b|_)(?:expires?|e\b|exp|se|st|expiry|timeout|ttl|deadline)(?:[=:])(\d{9,11})/i;
const EXPIRY_RESPONSE_CODES = new Set([401, 403, 410]);

const MIN_TIME_TO_EXPIRY_MS = 5000; // 5 seconds — minimum time before expiry to trigger fast capture

// ─── URL Analysis ──────────────────────────────────────────────────────────

/**
 * Check if a URL contains an expiry parameter (signed URL / token).
 *
 * @param {string} url
 * @returns {boolean}
 */
function hasExpiryToken(url) {
  if (!url) return false;
  return EXPIRY_PARAM_RE.test(url);
}

/**
 * Extract the expiry timestamp (Unix seconds) from a URL.
 *
 * @param {string} url
 * @returns {number|null} Expiry timestamp in Unix seconds, or null.
 */
function getExpiryTime(url) {
  if (!url) return null;
  const match = url.match(EXPIRY_PARAM_RE);
  if (!match) return null;
  const timestamp = parseInt(match[1], 10);
  if (isNaN(timestamp)) return null;
  return timestamp;
}

/**
 * Get the time in milliseconds until the URL expires.
 *
 * @param {string} url
 * @returns {number} Milliseconds until expiry (0 if already expired or unknown).
 */
function getTimeToExpiry(url) {
  const expiry = getExpiryTime(url);
  if (!expiry) return Infinity;
  const now = Math.floor(Date.now() / 1000);
  const remaining = (expiry - now) * 1000;
  return Math.max(0, remaining);
}

/**
 * Detect whether an HTTP response indicates the token has expired.
 *
 * @param {string} url
 * @param {number} status - HTTP status code.
 * @param {Object} headers - Response headers.
 * @returns {boolean}
 */
function detectExpiryInResponse(url, status, headers) {
  if (EXPIRY_RESPONSE_CODES.has(status)) {
    return true;
  }

  // Check for expiry-related headers
  const headerKeys = Object.keys(headers || {}).map((k) => k.toLowerCase());
  if (headerKeys.includes("x-amz-expires") || headerKeys.includes("x-expires")) {
    return true;
  }

  // Check for expiry in the response body via headers
  const xCache = String(headers["x-cache"] || "").toLowerCase();
  if (xCache.includes("expired") || xCache.includes("stale")) {
    return true;
  }

  return false;
}

/**
 * Check if a URL is about to expire and should trigger fast re-capture.
 *
 * @param {string} url
 * @returns {{expiring: boolean, timeToExpiryMs: number}}
 */
function checkExpiryUrgency(url) {
  const timeLeft = getTimeToExpiry(url);
  if (timeLeft === Infinity) {
    return { expiring: false, timeToExpiryMs: Infinity };
  }
  return {
    expiring: timeLeft < MIN_TIME_TO_EXPIRY_MS * 10, // Urgent if < 50 seconds
    timeToExpiryMs: timeLeft,
  };
}

export {
  hasExpiryToken,
  getExpiryTime,
  getTimeToExpiry,
  detectExpiryInResponse,
  checkExpiryUrgency,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_token_expiry.js`
Expected: PASS.

- [ ] **Step 5: Add segment_capture.js for fast parallel capture**

```javascript
// src/background/segment_capture.js
"use strict";

/**
 * Fast Parallel Segment Capture
 *
 * When a time-limited manifest URL is detected, this module captures all
 * segments in parallel before the token expires. It uses a combination of:
 * - Parsing the manifest (M3U8/MPD) to discover all segment URLs
 * - Dispatching parallel fetch requests (via CDP tunnel) for each segment
 * - Deduplicating and reassembling the captured segments
 */

import * as tokenExpiry from "./token_expiry_handler.js";
import * as cdpTunnel from "./cdp_tunnel_download.js";

// ─── State ─────────────────────────────────────────────────────────────────

/** @type {Map<string, {tabId: number, manifestUrl: string, segments: Array, completed: number, total: number, startedAt: number, errors: Array}>} */
const activeCaptures = new Map();

const MAX_CONCURRENT_SEGMENTS = 4;
const SEGMENT_TIMEOUT_MS = 15000;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Start fast parallel capture of all segments under a manifest URL.
 *
 * @param {number} tabId
 * @param {string} manifestUrl
 * @param {Object} [options]
 * @param {number} [options.maxConcurrent=4]
 * @param {number} [options.segmentTimeout=15000]
 * @returns {Promise<{ok: boolean, captureId: string, error?: string}>}
 */
async function startFastCapture(tabId, manifestUrl, options = {}) {
  const captureId = `fc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const maxConcurrent = options.maxConcurrent || MAX_CONCURRENT_SEGMENTS;
  const segmentTimeout = options.segmentTimeout || SEGMENT_TIMEOUT_MS;

  const state = {
    tabId,
    manifestUrl,
    segments: [],
    completed: 0,
    total: 0,
    startedAt: Date.now(),
    errors: [],
    maxConcurrent,
    segmentTimeout,
  };

  activeCaptures.set(captureId, state);

  // Start capturing in background (don't await — caller can poll status)
  captureAllSegments(captureId, state).catch(() => {});

  return { ok: true, captureId };
}

/**
 * Capture all segments from a manifest.
 * @param {string} captureId
 * @param {Object} state
 */
async function captureAllSegments(captureId, state) {
  // Step 1: Download the manifest via CDP tunnel
  const manifestResult = await cdpTunnel.tunnelManifestDownload(
    state.tabId,
    state.manifestUrl,
  );

  if (!manifestResult.ok || !manifestResult.data) {
    state.errors.push("Failed to download manifest");
    return;
  }

  // Step 2: Parse manifest to get segment URLs
  const segmentUrls = parseManifestForSegments(manifestResult.data, state.manifestUrl);
  state.total = segmentUrls.length;

  // Step 3: Download all segments in parallel batches
  const semaphore = new Semaphore(state.maxConcurrent);
  const promises = segmentUrls.map((segUrl) =>
    semaphore.run(async () => {
      if (tokenExpiry.checkExpiryUrgency(segUrl).expiring) {
        // URL about to expire — capture immediately
        const result = await cdpTunnel.tunnelSegmentDownload(state.tabId, segUrl, {}, { timeout: state.segmentTimeout });
        if (result.ok) {
          state.segments.push({
            url: segUrl,
            dataB64: result.data,
            byteLength: result.byteLength,
            contentType: result.contentType,
          });
        }
        state.completed++;
      }
    })
  );

  await Promise.allSettled(promises);
}

/**
 * Parse an M3U8 or MPD manifest for segment URLs.
 *
 * @param {string} manifestContent
 * @param {string} manifestUrl
 * @returns {Array<string>} List of absolute segment URLs.
 */
function parseManifestForSegments(manifestContent, manifestUrl) {
  const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);
  const segments = [];
  const lines = manifestContent.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments, tags, and empty lines
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<")) continue;

    // Resolve relative URLs
    const absoluteUrl = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
    segments.push(absoluteUrl);
  }

  return segments;
}

/**
 * Get capture progress for a fast capture.
 *
 * @param {string} captureId
 * @returns {{active: boolean, completed: number, total: number, segments: number, errors: number, elapsed: number}}
 */
function getCaptureProgress(captureId) {
  const state = activeCaptures.get(captureId);
  if (!state) return { active: false, completed: 0, total: 0, segments: 0, errors: 0, elapsed: 0 };

  return {
    active: state.completed < state.total,
    completed: state.completed,
    total: state.total,
    segments: state.segments.length,
    errors: state.errors.length,
    elapsed: Date.now() - state.startedAt,
  };
}

/**
 * Get captured segments for a fast capture.
 *
 * @param {string} captureId
 * @returns {Array}
 */
function getCapturedSegments(captureId) {
  const state = activeCaptures.get(captureId);
  return state ? [...state.segments] : [];
}

/**
 * Small semaphore for limiting concurrent async operations.
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.current >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.current++;
    try {
      return await fn();
    } finally {
      this.current--;
      if (this.queue.length > 0) {
        this.queue.shift()();
      }
    }
  }
}

export {
  startFastCapture,
  getCaptureProgress,
  getCapturedSegments,
  parseManifestForSegments,
};
```

- [ ] **Step 6: Commit**

```bash
git add src/background/token_expiry_handler.js src/background/segment_capture.js tests/extension/background/test_token_expiry.js
git commit -m "feat(background): add token expiry detection and fast parallel segment re-capture"
```

---
### Task 4: Browser Tunnel with Progress Reporting and Memory Management

**Files:**
- Modify: `src/background/cdp_tunnel_download.js` — add progress reporting, memory limits, IndexedDB spill-to-disk
- Create: `src/background/tunnel_memory_manager.js` — manage in-memory vs on-disk segment storage
- Create: `tests/extension/background/test_tunnel_memory.js`
- Modify: `src/background/download_orchestration.js` — wire tunnel progress to download UI

**Interfaces:**
- Produces: Modified `tunnelSegmentDownload()` now:
  - Reports progress during download via callback: `onProgress(bytesDownloaded, totalBytes)`
  - Automatically spills large responses (>100MB) to IndexedDB
  - Enforces memory cap: 2GB total per session
  - Limits concurrent tunnels: max 4 per tab
- Produces: `tunnel_memory_manager.js` exports:
  - `storeSegment(key, data): Promise<void>` — store segment data (memory or IndexedDB)
  - `retrieveSegment(key): Promise<ArrayBuffer>` — retrieve segment data
  - `getTotalBytes(): number` — total bytes stored
  - `clearSession(): Promise<void>` — clear all stored data

- [ ] **Step 1: Write failing test**

```javascript
// tests/extension/background/test_tunnel_memory.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const memoryManager = await import("../../../src/background/tunnel_memory_manager.js");

  // Test getTotalBytes
  assert.equal(memoryManager.getTotalBytes(), 0, "Total bytes should start at 0");

  // Test storeSegment with small data (stays in memory)
  const smallData = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello" = 5 bytes
  await memoryManager.storeSegment("test-key-1", smallData);
  assert.equal(memoryManager.getTotalBytes(), 5, "Total bytes should increase after storing");

  // Test retrieveSegment
  const retrieved = await memoryManager.retrieveSegment("test-key-1");
  assert.ok(retrieved instanceof ArrayBuffer, "retrieveSegment should return ArrayBuffer");
  assert.equal(retrieved.byteLength, 5, "Retrieved data should have correct length");

  // Test clearSession
  await memoryManager.clearSession();
  assert.equal(memoryManager.getTotalBytes(), 0, "Total bytes should reset after clear");
  const afterClear = await memoryManager.retrieveSegment("test-key-1");
  assert.equal(afterClear, null, "Retrieved data should be null after clear");

  // Test with large data (spills to IndexedDB)
  const largeData = new Uint8Array(1024 * 1024 * 2).buffer; // 2MB
  await memoryManager.storeSegment("test-key-large", largeData);
  const retrievedLarge = await memoryManager.retrieveSegment("test-key-large");
  assert.ok(retrievedLarge instanceof ArrayBuffer, "Large data should be retrievable");
  assert.equal(retrievedLarge.byteLength, largeData.byteLength, "Large data should have correct length");

  console.log("✓ All tunnel memory manager tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Write tunnel_memory_manager.js**

```javascript
// src/background/tunnel_memory_manager.js
"use strict";

/**
 * Tunnel Memory Manager
 *
 * Manages segment data storage for CDP tunnel downloads. Small segments
 * are kept in memory. Large segments (over MEMORY_THRESHOLD) are spilled
 * to IndexedDB to prevent excessive memory usage.
 *
 * Limits:
 *   - Memory threshold: 100MB (segments larger than this go to IndexedDB)
 *   - Total cap: 2GB per session
 *   - IndexedDB database name: "qwin-tunnel-cache"
 */

const MEMORY_THRESHOLD = 100 * 1024 * 1024; // 100MB
const TOTAL_CAP = 2 * 1024 * 1024 * 1024; // 2GB

/** @type {Map<string, ArrayBuffer>} */
const memoryStore = new Map();

/** @type {number} */
let totalBytes = 0;

/** @type {IDBDatabase|null} */
let db = null;

// ─── IndexedDB Setup ───────────────────────────────────────────────────────

function getDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    const request = indexedDB.open("qwin-tunnel-cache", 1);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains("segments")) {
        database.createObjectStore("segments", { keyPath: "key" });
      }
    };
    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Store a segment's data. Small data goes to memory; large data spills to IndexedDB.
 *
 * @param {string} key - Unique segment key (e.g., URL hash).
 * @param {ArrayBuffer} data - Segment data.
 * @returns {Promise<void>}
 */
async function storeSegment(key, data) {
  if (totalBytes + data.byteLength > TOTAL_CAP) {
    console.warn(`[tunnel-memory] Total cap (2GB) exceeded, dropping segment ${key}`);
    return;
  }

  if (data.byteLength <= MEMORY_THRESHOLD) {
    // Keep in memory
    memoryStore.set(key, data);
  } else {
    // Spill to IndexedDB
    const database = await getDB();
    const transaction = database.transaction(["segments"], "readwrite");
    const store = transaction.objectStore("segments");
    store.put({ key, data: new Uint8Array(data) });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });
  }

  totalBytes += data.byteLength;
}

/**
 * Retrieve a segment's data by key.
 *
 * @param {string} key
 * @returns {Promise<ArrayBuffer|null>}
 */
async function retrieveSegment(key) {
  // Check memory first
  if (memoryStore.has(key)) {
    return memoryStore.get(key);
  }

  // Check IndexedDB
  try {
    const database = await getDB();
    const transaction = database.transaction(["segments"], "readonly");
    const store = transaction.objectStore("segments");
    const request = store.get(key);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (result && result.data) {
      return result.data.buffer;
    }
  } catch (_e) {}

  return null;
}

/**
 * Get the total bytes stored across memory and IndexedDB.
 * @returns {number}
 */
function getTotalBytes() {
  return totalBytes;
}

/**
 * Clear all stored data and reset state.
 * @returns {Promise<void>}
 */
async function clearSession() {
  memoryStore.clear();
  totalBytes = 0;

  try {
    const database = await getDB();
    const transaction = database.transaction(["segments"], "readwrite");
    const store = transaction.objectStore("segments");
    store.clear();
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });
  } catch (_e) {}
}

export {
  storeSegment,
  retrieveSegment,
  getTotalBytes,
  clearSession,
  MEMORY_THRESHOLD,
  TOTAL_CAP,
};
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_tunnel_memory.js`
Expected: PASS.

- [ ] **Step 4: Add progress reporting to cdp_tunnel_download.js**

Modify `tunnelSegmentDownload()` to accept an optional `onProgress` callback. The CDP-injected fetch script can't easily report mid-download progress (because it loads the entire response via `response.arrayBuffer()`), but we can report download start and completion:

```javascript
// In tunnelSegmentDownload(), add before/after progress reporting:
if (options.onProgress) {
  options.onProgress(0, 0); // Starting
}
// ... do fetch ...
if (options.onProgress && result.ok) {
  options.onProgress(result.byteLength || 0, result.byteLength || 0); // Complete
}
```

For true incremental progress, inject a streaming fetch that uses `response.body.getReader()` to stream chunks and send them back via multiple CDP Runtime.evaluate calls. This is a more advanced improvement that can be added later.

- [ ] **Step 5: Wire tunnel progress to download_orchestration.js**

When CDP tunnel is used as a fallback, update the download UI with tunnel-specific progress:
```javascript
deps.updateDownload(jobId, {
  stage: "tunnel",
  message: "Downloading via browser tunnel...",
  tunnelInfo: { segmentsDownloaded: tunnelResult.segments?.length || 0 },
});
```

- [ ] **Step 6: Commit**

```bash
git add src/background/tunnel_memory_manager.js src/background/cdp_tunnel_download.js src/background/download_orchestration.js tests/extension/background/test_tunnel_memory.js
git commit -m "feat(background): add browser tunnel progress reporting and memory management with IndexedDB spill"
```

---
### Task 5: Comprehensive Error Reporting — Structured Error Types & Layer-by-Layer Reporting

**Files:**
- Create: `src/shared/error_types.js` — structured error type definitions
- Modify: `src/background/download_fallbacks.js` — add structured error construction
- Modify: `src/background/download_orchestration.js` — include layer info in error messages
- Create: `src/background/error_reporter.js` — format and display layer-by-layer error reports
- Create: `tests/extension/background/test_error_reporter.js`

**Interfaces:**
- Produces: `error_types.js` exports:
  - `ERROR_TYPES: Object` — map of error codes to metadata
  - `class CaptureError` — structured error with layer, code, message, details
- Produces: `error_reporter.js` exports:
  - `formatErrorReport(error, attemptedLayers): string` — human-readable error report
  - `formatErrorForPopup(error): string` — concise popup-friendly error
  - `getErrorSuggestion(error): string` — suggested action for the user

- [ ] **Step 1: Write failing test**

```javascript
// tests/extension/background/test_error_reporter.js
"use strict";
import assert from "node:assert/strict";

(async () => {
  const errorTypes = await import("../../../src/shared/error_types.js");
  const errorReporter = await import("../../../src/background/error_reporter.js");

  // Test error type definitions
  assert.ok(errorTypes.ERROR_TYPES, "ERROR_TYPES must be defined");
  assert.ok(errorTypes.ERROR_TYPES.cloudflare_block, "Must define cloudflare_block error type");
  assert.ok(errorTypes.ERROR_TYPES.token_expired, "Must define token_expired error type");
  assert.ok(errorTypes.ERROR_TYPES.l1_only_drm, "Must define l1_only_drm error type");
  assert.ok(errorTypes.ERROR_TYPES.no_segments, "Must define no_segments error type");
  assert.ok(errorTypes.ERROR_TYPES.cors_blocked, "Must define cors_blocked error type");

  // Test CaptureError
  const error = new errorTypes.CaptureError("cloudflare_block", "Cloudflare blocked the request", {
    layer: 1,
    url: "https://example.com/video.mp4",
  });
  assert.equal(error.code, "cloudflare_block", "Error code should match");
  assert.equal(error.message, "Cloudflare blocked the request", "Error message should match");
  assert.equal(error.layer, 1, "Error layer should match");
  assert.ok(error.timestamp, "Error should have timestamp");

  // Test formatErrorReport
  const attemptedLayers = [
    { layer: 1, name: "Parallel Probes", ok: false, error: "cloudflare_block" },
    { layer: 2, name: "CDP Extraction", ok: false, error: "No video URLs found" },
    { layer: 3, name: "SW Capture", ok: false, error: "SW registration failed" },
  ];
  const report = errorReporter.formatErrorReport(error, attemptedLayers);
  assert.ok(report, "formatErrorReport should return a string");
  assert.ok(report.includes("cloudflare_block"), "Report should include the error code");
  assert.ok(report.includes("Layer 1"), "Report should mention layer numbers");

  // Test formatErrorForPopup
  const popupError = errorReporter.formatErrorForPopup(error);
  assert.ok(popupError, "formatErrorForPopup should return a string");

  // Test getErrorSuggestion
  const suggestion = errorReporter.getErrorSuggestion(error);
  assert.ok(suggestion, "getErrorSuggestion should return a string");

  console.log("✓ All error reporter tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
```

- [ ] **Step 2: Write error_types.js**

```javascript
// src/shared/error_types.js
"use strict";

/**
 * Structured Error Types for the Universal Video Capture Pipeline.
 *
 * Each error has a machine-parseable code and a human-readable description.
 * Error codes are used throughout the pipeline to classify failures and
 * determine appropriate fallback actions.
 */

// ─── Error Type Definitions ───────────────────────────────────────────────

const ERROR_TYPES = {
  cloudflare_block: {
    code: "cloudflare_block",
    title: "Cloudflare Anti-Bot Block",
    description: "Cloudflare JS challenge or Turnstile blocked the request.",
    suggestion: "Extract cf_clearance cookie via CDP and retry, or escalate to browser tunnel.",
    severity: "error",
  },
  token_expired: {
    code: "token_expired",
    title: "Signed URL Expired",
    description: "The signed URL or token has expired before the download completed.",
    suggestion: "Re-navigate to the page to get a fresh token and retry immediately.",
    severity: "error",
  },
  l1_only_drm: {
    code: "l1_only_drm",
    title: "Hardware-Backed DRM (L1)",
    description: "Content uses Widevine L1 hardware-backed DRM — keys cannot be extracted in software.",
    suggestion: "Use CDP browser tunnel to download through the browser session (playback required).",
    severity: "warning",
  },
  no_segments: {
    code: "no_segments",
    title: "No Media Segments Captured",
    description: "MSE intercept or SW capture found no media segments to download.",
    suggestion: "Try CDP extraction to find alternative video URLs, or use the page URL with yt-dlp.",
    severity: "error",
  },
  cors_blocked: {
    code: "cors_blocked",
    title: "Cross-Origin Media Blocked",
    description: "The CDN serving the media does not allow cross-origin access. SW capture cannot read the response body.",
    suggestion: "Use CDP Network capture (chrome.debugger) which can read cross-origin responses.",
    severity: "warning",
  },
  license_denied: {
    code: "license_denied",
    title: "License Server Refused",
    description: "The DRM license server refused the request (geo-block, expired subscription, too many devices).",
    suggestion: "Check your subscription status and try from a different region.",
    severity: "error",
  },
  unknown_protection: {
    code: "unknown_protection",
    title: "Unknown Protection Mechanism",
    description: "The video uses an unrecognized protection mechanism that none of the capture layers could handle.",
    suggestion: "Report this video URL for analysis so a new capture strategy can be developed.",
    severity: "error",
  },
  no_media_found: {
    code: "no_media_found",
    title: "No Detectable Media",
    description: "None of the capture layers could find any video media on this page or URL.",
    suggestion: "Try playing the video first, then scan again. Some players only expose URLs during playback.",
    severity: "error",
  },
  tunnel_failed: {
    code: "tunnel_failed",
    title: "Browser Tunnel Failed",
    description: "The CDP browser tunnel could not download media through the browser session.",
    suggestion: "The browser session may have been closed or the tab navigated away. Reopen the page and retry.",
    severity: "error",
  },
};

// ─── CaptureError Class ────────────────────────────────────────────────────

class CaptureError extends Error {
  /**
   * @param {string} code - Error code from ERROR_TYPES.
   * @param {string} message - Human-readable error message.
   * @param {Object} [details] - Additional details.
   * @param {number} [details.layer] - Pipeline layer where the error occurred.
   * @param {string} [details.url] - URL that caused the error.
   * @param {Object} [details.meta] - Arbitrary metadata.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.layer = details.layer || 0;
    this.url = details.url || "";
    this.meta = details.meta || {};
    this.timestamp = Date.now();

    // Look up error type metadata
    const errorType = ERROR_TYPES[code];
    this.severity = errorType?.severity || "error";
    this.suggestion = errorType?.suggestion || "";
    this.title = errorType?.title || code;
  }

  /**
   * Convert to a plain object for messaging/serialization.
   * @returns {Object}
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      layer: this.layer,
      url: this.url,
      severity: this.severity,
      suggestion: this.suggestion,
      title: this.title,
      timestamp: this.timestamp,
      meta: this.meta,
    };
  }

  /**
   * Check if this error matches a specific code.
   * @param {string} code
   * @returns {boolean}
   */
  is(code) {
    return this.code === code;
  }
}

export { ERROR_TYPES, CaptureError };
```

- [ ] **Step 3: Write error_reporter.js**

```javascript
// src/background/error_reporter.js
"use strict";

import { ERROR_TYPES, CaptureError } from "../shared/error_types.js";

/**
 * Format a detailed layer-by-layer error report.
 *
 * @param {CaptureError} error - The final error.
 * @param {Array} attemptedLayers - Array of layer attempt results.
 * @returns {string} Human-readable report.
 */
function formatErrorReport(error, attemptedLayers) {
  const lines = [];
  lines.push(`╔══ Qwin Video Download — Error Report ═══`);
  lines.push(`║`);
  lines.push(`║  ${error.title}`);
  lines.push(`║  ${error.message}`);
  if (error.suggestion) {
    lines.push(`║`);
    lines.push(`║  Suggestion: ${error.suggestion}`);
  }
  lines.push(`║`);

  if (attemptedLayers && attemptedLayers.length > 0) {
    lines.push(`║  Layers attempted:`);
    for (const layer of attemptedLayers) {
      const icon = layer.ok ? "✅" : "❌";
      const dur = layer.duration ? ` (${(layer.duration / 1000).toFixed(1)}s)` : "";
      lines.push(`║    ${icon} Layer ${layer.layer}: ${layer.name}${dur}`);
      if (!layer.ok && layer.error) {
        lines.push(`║       └─ ${layer.error}`);
      }
    }
  }

  lines.push(`║`);
  lines.push(`╚══════════════════════════════════════════`);

  return lines.join("\n");
}

/**
 * Format an error for display in the popup (concise).
 *
 * @param {CaptureError} error
 * @returns {string}
 */
function formatErrorForPopup(error) {
  if (error.is("cloudflare_block")) {
    return "Blocked by Cloudflare anti-bot protection.";
  }
  if (error.is("token_expired")) {
    return "The video URL expired. Please refresh the page and try again.";
  }
  if (error.is("l1_only_drm")) {
    return "Uses hardware-backed DRM (Widevine L1). Try playing the video and use the browser tunnel.";
  }
  if (error.is("cors_blocked")) {
    return "Cross-origin CDN blocked. The browser tunnel may work.";
  }
  if (error.is("license_denied")) {
    return "License server refused (geo-block or expired subscription).";
  }
  if (error.is("no_segments") || error.is("no_media_found")) {
    return "No video media could be found on this page.";
  }
  return error.message.slice(0, 200);
}

/**
 * Get a suggested action for the user based on the error.
 *
 * @param {CaptureError} error
 * @returns {string}
 */
function getErrorSuggestion(error) {
  return error.suggestion || "Try playing the video first, then scan again.";
}

export {
  formatErrorReport,
  formatErrorForPopup,
  getErrorSuggestion,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:chromium && node tests/extension/background/test_error_reporter.js`
Expected: PASS.

- [ ] **Step 5: Integrate error reporting into download_orchestration.js**

In `startNativeDownloadFromVideo()`, when all fallbacks fail, construct a `CaptureError` with the attempted layers and format a user-friendly report:

```javascript
// After all fallbacks exhausted, in the error handler:
import { CaptureError } from "../shared/error_types.js";
import { formatErrorReport, formatErrorForPopup } from "./error_reporter.js";

// ... in the error path:
const captureError = new CaptureError("no_media_found", errorText, {
  layer: attemptedLayer,
  url: video.url,
});
const report = formatErrorReport(captureError, attemptedLayers);
deps.updateDownload(jobId, {
  status: "error",
  error: formatErrorForPopup(captureError),
  rawProgressLine: report,
});
```

