/**
 * RED PHASE — This test must FAIL with the current code.
 *
 * Test: When an iframe-page download fails, fallbackVideoForDownload should
 * find the actual video URL detected by the content script inside the iframe.
 *
 * Scenario:
 * - Parent page (pinaypie) has iframe to playmogo.com
 * - Parent content script creates iframe-page PAGE candidate
 * - Content script inside iframe detects HLS video
 * - Download of PAGE candidate fails
 * - fallbackVideoForDownload should find the HLS video from inside the iframe
 *
 * Current code: fallbackVideoForDownload does NOT look for iframe-detected
 * videos. This test should FAIL because the feature is missing.
 */

// Set up minimal browser API mocks BEFORE importing modules
globalThis.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    connectNative: () => ({
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: () => {},
    id: "test-extension-id",
  },
  storage: {
    local: {
      get: (_keys, cb) => cb({}),
      set: (_items, cb) => cb?.(),
      remove: (_keys, cb) => cb?.(),
    },
  },
  tabs: {
    query: (_query, cb) => cb([{ id: 42, url: "https://example.com" }]),
    sendMessage: (_tabId, _msg, cb) => cb?.(null),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: (_details, cb) => cb?.([]),
  },
  cookies: {
    getAll: (_details, cb) => cb([]),
  },
  webRequest: {
    onBeforeRequest: { addListener: () => {} },
    onBeforeSendHeaders: { addListener: () => {} },
    onHeadersReceived: { addListener: () => {} },
  },
};
globalThis.browser = undefined;
if (!globalThis.navigator) {
  globalThis.navigator = { userAgent: "Qwin Test" };
} else {
  Object.defineProperty(globalThis.navigator, "userAgent", {
    value: "Qwin Test",
    configurable: true,
  });
}
globalThis.URL = URL;

import assert from "node:assert/strict";

// Dynamic import after globals are set up
const downloadFallbacks = await import("../../../src/background/download_fallbacks.js");

// ─── Test: isIframePageVideo detection ────────────────────────────────────

{
  console.log("--- Test: isIframePageVideo correctly identifies iframe-page candidates ---");

  assert.ok(
    downloadFallbacks.isIframePageVideo({ source: "iframe-page", format: "PAGE" }),
    "should return true for iframe-page + PAGE",
  );
  assert.ok(
    downloadFallbacks.isIframePageVideo({ source: "iframe-page", format: "page" }),
    "should return true for case-insensitive format",
  );
  assert.ok(
    !downloadFallbacks.isIframePageVideo({ source: "dom-video", format: "M3U8" }),
    "should return false for dom-video source",
  );
  assert.ok(
    !downloadFallbacks.isIframePageVideo({ source: "iframe-page", format: "M3U8" }),
    "should return false for non-PAGE format",
  );
  assert.ok(!downloadFallbacks.isIframePageVideo(null), "should return false for null");
  assert.ok(!downloadFallbacks.isIframePageVideo({}), "should return false for empty object");

  console.log("✓ isIframePageVideo correctly identifies iframe-page candidates");
}
const videoUtils = await import("../../../src/background/video_utils.js");

// ─── RED TEST: iframe-page fallback should find iframe-detected video ───

{
  console.log("--- Test: iframe-page fallback should find iframe-detected HLS video ---");

  // Include the failed video's URL so it's not found as a variant and we reach the iframe fallback
  const attemptedUrls = new Set(["https://playmogo.com/e/k2c18kmf5fea"]);

  const deps = {
    addDetectedVideo: async () => null,
    detectFormat: videoUtils.detectFormat,
    findGroupedVideoForAnyVariant: () => null,
    getVisibleVideosForTab: (_tabId) => {
      // Simulate tab state with TWO candidates:
      return [
        {
          id: "iframe-page-1",
          url: "https://playmogo.com/e/k2c18kmf5fea",
          format: "PAGE",
          source: "iframe-page",
          pageUrl: "https://pinaypie.com/watch/episode",
          frameUrl: "https://pinaypie.com/watch/episode",
          title: "Watch Episode - PinayPie",
          downloadable: true,
        },
        {
          id: "hls-video-1",
          url: "https://cdn.playmogo.com/hls/master.m3u8?token=abc123",
          format: "M3U8",
          source: "dom-video",
          pageUrl: "https://pinaypie.com/watch/episode",
          frameUrl: "https://playmogo.com/e/k2c18kmf5fea",
          title: "Video Player | playmogo",
          downloadable: true,
          height: 1080,
          bitrate: 5000,
        },
      ];
    },
    hashId: (url) => url,
    isDownloadableUrl: videoUtils.isDownloadableUrl,
    nativeRequest: async () => ({ candidates: [] }),
    nativeRequestHeadersForVideo: async () => [],
    normalizeUrl: (url) => url,
    titleFromUrl: videoUtils.titleFromUrl,
    userAgent: "Mozilla/5.0",
    variantsForVideo: (video) => (video ? [video] : []),
  };

  // Failed iframe-page candidate
  const failedVideo = {
    id: "iframe-page-1",
    url: "https://playmogo.com/e/k2c18kmf5fea",
    format: "PAGE",
    source: "iframe-page",
    pageUrl: "https://pinaypie.com/watch/episode",
    frameUrl: "https://pinaypie.com/watch/episode",
    title: "Watch Episode - PinayPie",
    downloadable: true,
  };

  const fallbackResult = await downloadFallbacks.fallbackVideoForDownload(123, failedVideo, attemptedUrls, deps);

  console.log("Fallback result:", fallbackResult ? fallbackResult.url || "no URL" : "null");

  // THIS ASSERTION SHOULD FAIL with current code because the fallback
  // does NOT look for iframe-detected videos. The test expects to find
  // the HLS URL from inside the iframe.
  assert.ok(
    fallbackResult && fallbackResult.url && fallbackResult.url.includes("m3u8"),
    "FAIL: Expected fallbackVideoForDownload to find the HLS video from inside the iframe " +
      "(frameUrl matches iframe src URL). Got: " +
      (fallbackResult ? fallbackResult.url || JSON.stringify(fallbackResult).slice(0, 200) : "null"),
  );

  // If we get here, the test unexpectedly PASSED
  console.log("UNEXPECTED PASS: iframe fallback found HLS video:", fallbackResult.url);
}

console.log("\n✓ All iframe download fallback tests passed!");
