/**
 * Test: SSR JSON Data Parsing for Embedded Video URLs
 *
 * Tests that the content script can extract video URLs from SSR page
 * data embedded as JSON (__NEXT_DATA__, __NUXT__, __INITIAL_STATE__).
 *
 * Edge Case from audit: §4.3 SSR JSON parsing (MEDIUM)
 */

import assert from "node:assert/strict";
import * as pageDetectionModule from "../../../src/content/page_detection.js";
import * as filters from "../../../src/shared/video_filters.js";

function createDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Test Page",
    baseURI: options.url || "https://example.com/page",
    querySelector(sel) {
      if (options[sel]) return options[sel];
      return null;
    },
    querySelectorAll(sel) {
      if (options.queryAll && options.queryAll[sel]) return options.queryAll[sel];
      return [];
    },
    getElementById() { return null; },
  };
  const loc = new URL(options.url || "https://example.com/page");
  return pageDetectionModule.create({
    document: doc,
    location: loc,
    videoFilters: filters,
    seenUrls: options.seenUrls || new Map(),
  });
}

// ─── 1. scanSsrVideoUrls finds URLs in __NEXT_DATA__ JSON ──────────────

{
  console.log("--- Test 1: Extract video URLs from __NEXT_DATA__ JSON ---");

  const detection = createDetection({
    url: "https://example.com/movie",
    docTitle: "Movie Page",
  });

  // Simulate content of a __NEXT_DATA__ script tag with embedded video URLs
  const nextData = JSON.stringify({
    props: {
      pageProps: {
        video: {
          url: "https://cdn.example.com/videos/movie.mp4",
          poster: "https://cdn.example.com/posters/movie.jpg",
          sources: [
            { src: "https://cdn.example.com/hls/master.m3u8", type: "application/x-mpegURL" },
            { src: "https://cdn.example.com/dash/manifest.mpd", type: "application/dash+xml" },
          ],
        },
        relatedVideos: [
          { id: 1, url: "https://cdn.example.com/related/clip1.mp4", title: "Clip 1" },
          { id: 2, url: "https://cdn.example.com/related/clip2.mp4", title: "Clip 2" },
        ],
      },
    },
  });

  const candidates = detection.scanTextForMediaUrls(nextData, "script-config");

  assert.ok(candidates.some((c) => c.url.includes("movie.mp4")),
    "Should extract movie.mp4 URL from __NEXT_DATA__");
  assert.ok(candidates.some((c) => c.url.includes("master.m3u8")),
    "Should extract HLS URL from __NEXT_DATA__");
  assert.ok(candidates.some((c) => c.url.includes("manifest.mpd")),
    "Should extract DASH URL from __NEXT_DATA__");
  assert.ok(candidates.some((c) => c.url.includes("clip1.mp4")),
    "Should extract related video URLs");

  console.log("  ✓ __NEXT_DATA__ video URLs extracted successfully");
  console.log("  Found", candidates.length, "candidates");
}

// ─── 2. __NUXT__ JSON parsing ──────────────────────────────────────────

{
  console.log("\n--- Test 2: Extract video URLs from __NUXT__ JSON ---");

  const detection = createDetection({
    url: "https://example.com/series",
    docTitle: "Series Page",
  });

  const nuxtData = JSON.stringify({
    data: [{
      video: {
        url: "https://cdn.example.com/videos/episode.webm",
        duration: 2400,
        thumbnails: ["https://cdn.example.com/thumbs/ep1.jpg"],
      },
    }],
    state: {
      video: {
        currentSrc: "https://cdn.example.com/videos/episode.mp4",
      },
    },
  });

  const candidates = detection.scanTextForMediaUrls(nuxtData, "script-config");

  assert.ok(candidates.some((c) => c.url.includes("episode.webm")),
    "Should extract episode.webm from __NUXT__");
  assert.ok(candidates.some((c) => c.url.includes("episode.mp4")),
    "Should extract episode.mp4 from __NUXT__ state");

  console.log("  ✓ __NUXT__ video URLs extracted successfully");
}

// ─── 3. window.__INITIAL_STATE__ pattern ───────────────────────────────

{
  console.log("\n--- Test 3: __INITIAL_STATE__ JSON parsing ---");

  const detection = createDetection({
    url: "https://example.com/live",
    docTitle: "Live Stream",
  });

  const initStateData = JSON.stringify({
    stream: {
      url: "https://cdn.example.com/live/stream.m3u8",
      isLive: true,
      qualities: [
        { label: "1080p", url: "https://cdn.example.com/live/1080p.m3u8" },
        { label: "720p", url: "https://cdn.example.com/live/720p.m3u8" },
      ],
    },
  });

  const candidates = detection.scanTextForMediaUrls(initStateData, "script-config");

  assert.ok(candidates.some((c) => c.url.includes("stream.m3u8")),
    "Should extract stream URL from __INITIAL_STATE__");

  console.log("  ✓ __INITIAL_STATE__ video URLs extracted");
}

// ─── 4. Empty / malformed JSON handling ────────────────────────────────

{
  console.log("\n--- Test 4: Handle malformed SSR JSON gracefully ---");

  const detection = createDetection({
    url: "https://example.com/page",
    docTitle: "Test Page",
  });

  // Malformed JSON should not cause errors
  const badJson1 = "{ this is not valid json }";
  const badJson2 = '{"data": null}';
  const badJson3 = "";

  for (const text of [badJson1, badJson2, badJson3]) {
    let error = null;
    try {
      detection.scanTextForMediaUrls(text, "script-config");
    } catch (e) {
      error = e;
    }
    assert.ok(error === null,
      "scanTextForMediaUrls should not throw on malformed JSON (got " + error + ")");
  }

  console.log("  ✓ Malformed SSR JSON handled without errors");
}

// ─── 5. Deeply nested video URLs in SSR ────────────────────────────────

{
  console.log("\n--- Test 5: Extract deeply nested video URLs ---");

  const detection = createDetection({
    url: "https://example.com/page",
    docTitle: "CMS Page",
  });

  // Simulate a complex SSR state with deeply nested video references
  const deepData = JSON.stringify({
    props: {
      pageProps: {
        content: {
          blocks: [
            {
              type: "video",
              data: {
                mp4: { url: "https://cdn.example.com/deep/video.mp4" },
                hls: { url: "https://cdn.example.com/deep/playlist.m3u8" },
              },
            },
            {
              type: "gallery",
              items: [
                { video: { url: "https://cdn.example.com/gallery/item1.mp4" } },
                { video: { url: "https://cdn.example.com/gallery/item2.webm" } },
              ],
            },
          ],
        },
      },
    },
  });

  const candidates = detection.scanTextForMediaUrls(deepData, "script-config");

  assert.ok(candidates.some((c) => c.url.includes("video.mp4")),
    "Should extract deeply nested video.mp4");
  assert.ok(candidates.some((c) => c.url.includes("playlist.m3u8")),
    "Should extract deeply nested playlist.m3u8");
  assert.ok(candidates.some((c) => c.url.includes("item1.mp4")),
    "Should extract gallery video URLs");

  console.log("  ✓ Deeply nested SSR video URLs extracted");
  console.log("  Found", candidates.length, "candidates");
}

console.log("\n✓ All SSR JSON detection tests completed");
