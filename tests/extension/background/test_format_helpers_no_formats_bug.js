"use strict";

// ─── Mock chrome API ────────────────────────────────────────────────────────

globalThis.chrome = {
  runtime: { lastError: null },
  tabs: {
    sendMessage: () => Promise.resolve(),
  },
  storage: {
    local: {
      get: (keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      set: (items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      },
    },
  },
};

globalThis.browser = chrome;

import assert from "node:assert/strict";

// Test for bug: yt-dlp returns response but no formats found
// This happens when yt-dlp succeeds but all formats are filtered out
// (e.g., audio-only formats, segmented streams, etc.)

(async () => {
  const formatHelpers = await import("../../../src/background/format_helpers.js");

  const mockVideo = {
    id: "test-video-1",
    url: "https://www.youtube.com/watch?v=PgyggSRHY1o",
    title: "Test Video",
    source: "youtube-page",
  };

  const mockNativeRequestFn = async (request) => {
    // Simulate yt-dlp returning a response with empty formats array
    return {
      type: "formats",
      id: request.id,
      title: "Test Video",
      webpageUrl: "https://www.youtube.com/watch?v=PgyggSRHY1o",
      thumbnailUrl: "",
      hasSubtitles: false,
      subtitleLanguages: 0,
      formats: [], // Empty formats array - this is the bug scenario
    };
  };

  const mockGetVisibleVideosFn = () => [mockVideo];
  const mockNotifyPopupFn = () => {};
  const mockAddDetectedVideoFn = async () => mockVideo;

  // This should not throw an error - it should handle empty formats gracefully
  const result = await formatHelpers.getNativeFormatsForVideo(
    1,
    mockVideo,
    mockGetVisibleVideosFn,
    mockNotifyPopupFn,
    mockNativeRequestFn,
    mockAddDetectedVideoFn,
  );

  // Verify the result has a fallback format even when native formats are empty
  assert.ok(result, "Should return a result even with empty formats");
  assert.ok(result.formats, "Result should have formats array");
  assert.ok(result.formats.length > 0, "Should provide fallback format when native formats are empty");
  assert.equal(result.formats[0].id, "best", "Fallback format should be 'best'");

  console.log("✓ All format_helpers no formats bug tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
