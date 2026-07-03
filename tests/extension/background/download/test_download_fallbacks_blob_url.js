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

// Test for bug: fallback mechanism should not return blob URLs
// Blob URLs cannot be sent to yt-dlp and will cause download to fail

(async () => {
  const downloadFallbacks = await import("../../../src/background/download_fallbacks.js");

  const mockVideo = {
    id: "test-video-1",
    url: "https://www.youtube.com/watch?v=PgyggSRHY1o",
    title: "Test Video",
    source: "youtube-page",
    groupVariants: [
      {
        id: "variant-1",
        url: "blob:https://www.youtube.com/7da9ac36-02f2-4cd1-a54f-98475762131f",
        format: "mp4",
        downloadable: true,
      },
      {
        id: "variant-2",
        url: "https://example.com/video.mp4",
        format: "mp4",
        downloadable: true,
      },
    ],
  };

  const mockDeps = {
    normalizeUrl: (url) => url,
    variantsForVideo: (video) => video.groupVariants || [],
    isDownloadableUrl: () => true,
  };

  const attemptedUrls = new Set();

  // downloadableVariants should filter out blob URLs
  const variants = downloadFallbacks.downloadableVariants(mockVideo, attemptedUrls, mockDeps);

  // Should not include the blob URL variant
  assert.ok(variants.length > 0, "Should have at least one variant");
  assert.ok(
    !variants.some((v) => v.url.startsWith("blob:")),
    "Should not include blob URLs in downloadable variants"
  );
  assert.equal(
    variants[0].url,
    "https://example.com/video.mp4",
    "Should return the non-blob URL variant"
  );

  console.log("✓ All download_fallbacks blob URL tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
