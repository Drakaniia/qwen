/**
 * Test: SSR Detection Module (ssr_detection.js) — Phase 1
 *
 * Tests the dedicated SSR JSON extraction module that runs in content scripts
 * to extract HLS manifest URLs from common SSR globals.
 *
 * Per spec: Phase 1 — SSR Detection (Content Script)
 * Tests the ACTUAL exported functions from src/content/ssr_detection.js.
 */

import assert from "node:assert/strict";
import * as ssrModule from "../../../src/content/ssr_detection.js";

// Polyfill MutationObserver for Node.js (it's a browser API not available in test runner)
if (typeof globalThis.MutationObserver === "undefined") {
  const mockObservers = [];
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this._timer = null;
      mockObservers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      clearTimeout(this._timer);
      const idx = mockObservers.indexOf(this);
      if (idx >= 0) mockObservers.splice(idx, 1);
    }
  };
  // Helper to trigger a mutation (used in tests)
  globalThis.__triggerMutation = (records) => {
    for (const obs of mockObservers) {
      obs.callback(records || []);
    }
  };
}

// ─── Basic export contract ────────────────────────────────────────────────

{
  console.log("--- Test 0: Module exports contract ---");

  assert.equal(typeof ssrModule.init, "function", "init must be a function");
  assert.equal(typeof ssrModule.scanSSRGlobals, "function", "scanSSRGlobals must be a function");
  assert.equal(typeof ssrModule.extractHLSUrlsFromJSON, "function",
    "extractHLSUrlsFromJSON must be a function");
  assert.equal(typeof ssrModule.installSSRObserver, "function",
    "installSSRObserver must be a function");

  console.log("  \u2713 All expected exports exist and are functions");
}

// ─── 1. extractHLSUrlsFromJSON: Direct HLS URL strings ─────────────────

{
  console.log("\n--- Test 1: extractHLSUrlsFromJSON \u2014 direct HLS URL strings ---");

  // Top-level string
  const r1 = ssrModule.extractHLSUrlsFromJSON("https://cdn.example.com/hls/master.m3u8");
  assert.equal(r1.length, 1, "Should find HLS URL in top-level string");
  assert.ok(r1[0].url.includes("master.m3u8"), "URL should be correct");

  // Nested in object
  const r2 = ssrModule.extractHLSUrlsFromJSON({ url: "https://cdn.example.com/hls/video.m3u8" });
  assert.equal(r2.length, 1, "Should find HLS URL nested in object");

  // In array with type
  const r3 = ssrModule.extractHLSUrlsFromJSON({
    sources: [{ src: "https://cdn.example.com/hls/stream.m3u8", type: "application/x-mpegURL" }],
  });
  assert.equal(r3.length, 1, "Should find HLS URL in array");
  assert.ok(r3[0].source.includes("ssr-json:"), "Source should include ssr-json prefix");

  // Multiple sources
  const r4 = ssrModule.extractHLSUrlsFromJSON({
    video: {
      sources: [
        { url: "https://cdn.example.com/hls/1080p.m3u8", type: "application/x-mpegURL" },
        { url: "https://cdn.example.com/hls/720p.m3u8", type: "application/x-mpegURL" },
      ],
    },
  });
  assert.equal(r4.length, 2, "Should find both HLS URLs");

  // With query params
  const r5 = ssrModule.extractHLSUrlsFromJSON(
    "https://cdn.example.com/hls/master.m3u8?token=abc123&expires=9999999999",
  );
  assert.equal(r5.length, 1, "Should find HLS URL with query params");

  // No HLS URLs
  const r6 = ssrModule.extractHLSUrlsFromJSON({ name: "test", description: "no video" });
  assert.equal(r6.length, 0, "Should return empty for non-HLS data");

  // Empty object
  const r7 = ssrModule.extractHLSUrlsFromJSON({});
  assert.equal(r7.length, 0, "Should return empty for empty object");

  // null/undefined
  const r8 = ssrModule.extractHLSUrlsFromJSON(null);
  assert.equal(r8.length, 0, "Should return empty for null");
  const r9 = ssrModule.extractHLSUrlsFromJSON(undefined);
  assert.equal(r9.length, 0, "Should return empty for undefined");

  // MP4 URLs should NOT be found (HLS-only focus per spec)
  const r10 = ssrModule.extractHLSUrlsFromJSON({ url: "https://cdn.example.com/video.mp4" });
  assert.equal(r10.length, 0, "Should NOT find MP4 URLs (HLS-only scope)");

  // DASH MPD URLs should NOT be found yet (Phase 1 is HLS-only)
  const r11 = ssrModule.extractHLSUrlsFromJSON({ manifest: "https://cdn.example.com/dash/manifest.mpd" });
  assert.equal(r11.length, 0, "Should NOT find DASH MPD URLs (HLS-only Phase 1)");

  console.log("  \u2713 All direct HLS URL string tests passed");
}

// ─── 2. extractHLSUrlsFromJSON: Deduplication ──────────────────────────

{
  console.log("\n--- Test 2: extractHLSUrlsFromJSON \u2014 deduplication ---");

  const sameUrl = "https://cdn.example.com/hls/same.m3u8";
  const data = {
    video1: { url: sameUrl },
    video2: { url: sameUrl },
    video3: { url: sameUrl },
  };

  const results = ssrModule.extractHLSUrlsFromJSON(data);
  assert.equal(results.length, 1, "Should deduplicate identical URLs across keys");

  console.log("  \u2713 Deduplication works correctly");
}

// ─── 3. extractHLSUrlsFromJSON: Deep nesting ──────────────────────────

{
  console.log("\n--- Test 3: extractHLSUrlsFromJSON \u2014 deep nesting ---");

  function deepNest(depth) {
    if (depth <= 0) return { url: "https://cdn.example.com/hls/deep.m3u8" };
    return { level: deepNest(depth - 1) };
  }

  const rDeep2 = ssrModule.extractHLSUrlsFromJSON(deepNest(2));
  assert.equal(rDeep2.length, 1, "Should find HLS URL at depth 2");

  const rDeep8 = ssrModule.extractHLSUrlsFromJSON(deepNest(8));
  assert.equal(rDeep8.length, 1, "Should find HLS URL at depth 8 (within maxDepth=10)");

  // Depth beyond MAX_JSON_DEPTH (10)
  const rDeep12 = ssrModule.extractHLSUrlsFromJSON(deepNest(12));
  assert.equal(rDeep12.length, 0, "Should NOT find HLS URL beyond maxDepth=10");

  console.log("  \u2713 Deep nesting tests passed (depth limit enforced)");
}

// ─── 4. extractHLSUrlsFromJSON: {url/file, type} object pattern ────────

{
  console.log("\n--- Test 4: extractHLSUrlsFromJSON \u2014 {url, type} and {file, type} patterns ---");

  // {file, type} pattern (common in JW Player, custom players)
  const r1 = ssrModule.extractHLSUrlsFromJSON({
    file: "https://cdn.example.com/hls/playlist.m3u8",
    type: "application/x-mpegURL",
  });
  assert.equal(r1.length, 1, "Should find HLS from {file, type} object");

  // {src, mimeType} pattern
  const r2 = ssrModule.extractHLSUrlsFromJSON({
    src: "https://cdn.example.com/hls/source.m3u8",
    mimeType: "application/vnd.apple.mpegURL",
  });
  assert.equal(r2.length, 1, "Should find HLS from {src, mimeType} object");

  console.log("  \u2713 {url/file, type} pattern handling works");
}

// ─── 5. scanSSRGlobals: __NEXT_DATA__ extraction ───────────────────────

{
  console.log("\n--- Test 5: scanSSRGlobals \u2014 __NEXT_DATA__ ---");

  const mockDoc = {
    title: "Movie Page",
    baseURI: "https://example.com/movie",
    getElementById(id) {
      if (id === "__NEXT_DATA__") {
        return {
          textContent: JSON.stringify({
            props: {
              pageProps: {
                video: {
                  sources: [
                    { src: "https://cdn.example.com/hls/master.m3u8", type: "application/x-mpegURL" },
                  ],
                },
              },
            },
          }),
        };
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const results = ssrModule.scanSSRGlobals(mockDoc, {});
  const hlsUrls = results.filter((r) => r.url.includes(".m3u8"));
  assert.ok(hlsUrls.length >= 1, "Should find HLS URL from __NEXT_DATA__ element");
  assert.ok(hlsUrls[0].source.includes("ssr-json:"), "Source should indicate ssr-json");

  console.log("  \u2713 __NEXT_DATA__ HLS URLs extracted via DOM scanning");
}

// ─── 6. scanSSRGlobals: __NUXT__ extraction ─────────────────────────────

{
  console.log("\n--- Test 6: scanSSRGlobals \u2014 __NUXT__ ---");

  const mockDoc = {
    title: "Series Page",
    baseURI: "https://example.com/series",
    getElementById(id) {
      if (id === "__NUXT__") {
        return {
          textContent: JSON.stringify({
            data: [{ video: { url: "https://cdn.example.com/hls/episode.m3u8" } }],
          }),
        };
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const results = ssrModule.scanSSRGlobals(mockDoc, {});
  const hlsUrls = results.filter((r) => r.url.includes(".m3u8"));
  assert.ok(hlsUrls.length >= 1, "Should find HLS URL from __NUXT__ element");

  console.log("  \u2713 __NUXT__ HLS URLs extracted");
}

// ─── 7. scanSSRGlobals: window globals (__INITIAL_STATE__) ─────────────

{
  console.log("\n--- Test 7: scanSSRGlobals \u2014 window.__INITIAL_STATE__ ---");

  const mockWin = {
    __INITIAL_STATE__: {
      stream: {
        url: "https://cdn.example.com/live/stream.m3u8",
        qualities: [
          { url: "https://cdn.example.com/live/1080p.m3u8" },
        ],
      },
    },
  };

  const results = ssrModule.scanSSRGlobals({}, mockWin);
  assert.ok(results.length >= 1, "Should find HLS URL from window.__INITIAL_STATE__");

  console.log("  \u2713 Window globals scanning works");
}

// ─── 8. scanSSRGlobals: No SSR globals (graceful) ─────────────────────

{
  console.log("\n--- Test 8: scanSSRGlobals \u2014 no SSR globals ---");

  const mockDoc = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const results = ssrModule.scanSSRGlobals(mockDoc, {});
  assert.equal(results.length, 0, "Should return empty array when no SSR globals exist");

  console.log("  \u2713 Graceful no-op when no SSR globals present");
}

// ─── 9. scanSSRGlobals: Deduplication across sources ───────────────────

{
  console.log("\n--- Test 9: scanSSRGlobals \u2014 deduplication across sources ---");

  const sameUrl = "https://cdn.example.com/hls/duplicate.m3u8";
  const mockDoc = {
    getElementById(id) {
      if (id === "__NEXT_DATA__") {
        return { textContent: JSON.stringify({ video: { url: sameUrl } }) };
      }
      if (id === "__NUXT__") {
        return { textContent: JSON.stringify({ video: { url: sameUrl } }) };
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const mockWin = { __INITIAL_STATE__: { stream: { url: sameUrl } } };

  const results = ssrModule.scanSSRGlobals(mockDoc, mockWin);
  assert.equal(results.length, 1, "Should deduplicate same URL across all SSR sources");

  console.log("  \u2713 Cross-source deduplication works");
}

// ─── 10. init() entry point ────────────────────────────────────────────

{
  console.log("\n--- Test 10: init() entry point ---");

  const mockDoc = {
    title: "Test Page",
    documentElement: { nodeType: 1 },
    getElementById(id) {
      if (id === "__NEXT_DATA__") {
        return {
          textContent: JSON.stringify({
            props: { pageProps: { video: { url: "https://cdn.example.com/hls/init.m3u8" } } },
          }),
        };
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };

  const result = ssrModule.init({ document: mockDoc, window: {} });
  assert.equal(result.active, true, "init should return active: true");
  assert.ok(Array.isArray(result.candidates), "init should return candidates array");
  assert.ok(result.candidates.length >= 1, "init should find SSR candidates");
  assert.ok(result.observer !== null, "init should install mutation observer");

  console.log("  \u2713 init() entry point works correctly");
  console.log(`  Found ${result.candidates.length} candidates`);
}

// ─── 11. init() — no SSR globals ──────────────────────────────────────

{
  console.log("\n--- Test 11: init() \u2014 no SSR globals ---");

  const emptyDoc = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    documentElement: { nodeType: 1 },
  };

  const result = ssrModule.init({ document: emptyDoc, window: {} });
  assert.equal(result.active, true, "init should still return active: true");
  assert.equal(result.candidates.length, 0, "Should find no candidates with no SSR globals");

  console.log("  \u2713 init() handles empty SSR pages gracefully");
}

// ─── 12. HTML-escaped URLs ────────────────────────────────────────────

{
  console.log("\n--- Test 12: HTML-escaped URLs ---");

  // JSON.parse resolves \\u0026 to &
  const escaped = '{"url": "https://cdn.example.com/hls/stream.m3u8?token=abc\\u0026exp=123"}';
  const parsed = JSON.parse(escaped);
  const result = ssrModule.extractHLSUrlsFromJSON(parsed);

  assert.equal(result.length, 1, "Should find HLS URL in escaped JSON");
  assert.ok(result[0].url.includes("stream.m3u8"), "URL should contain the HLS path");

  console.log("  \u2713 HTML-escaped URLs handled correctly");
}

console.log("\n\u2713 All SSR detection tests PASSED \u2014 real module verified");
