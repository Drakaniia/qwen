/**
 * Test: Iframe and dynamic video detection in page_detection.js
 *
 * Tests that the content script's detection pipeline properly handles:
 * 1. Iframe-embedded videos (pinaypie → playmogo.com)
 * 2. Dynamically loaded video elements (nextflicks)
 */

import assert from "node:assert/strict";
import * as filters from "../../../src/shared/video_filters.js";
import * as pageDetectionModule from "../../../src/content/page_detection.js";
import * as mediaCandidates from "../../../src/shared/media_candidates.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

function createDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Test Page",
    baseURI: options.url || "https://example.com/video",
    querySelector(selector) {
      if (options.meta && selector.startsWith("meta")) {
        const property = selector.match(/property="([^"]+)"/);
        const name = selector.match(/name="([^"]+)"/);
        const key = (property && property[1]) || (name && name[1]);
        if (options.meta[key]) {
          return { content: options.meta[key] };
        }
      }
      if (selector === "iframe[src]" && options.iframes) {
        return options.iframes[0] || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "iframe[src]" && options.iframes) {
        return options.iframes || [];
      }
      if (selector === "h1, h2, h3, h4, h5, h6, figcaption, legend" && options.headings) {
        return options.headings.map((t) => ({ textContent: t }));
      }
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const loc = new URL(options.url || "https://example.com/video");
  return pageDetectionModule.create({
    document: doc,
    location: loc,
    videoFilters: filters,
    seenUrls: options.seenUrls || new Map(),
  });
}

function createVideoMock(attributes = {}, extra = {}) {
  return {
    currentSrc: attributes.currentSrc || "",
    src: attributes.src || "",
    videoWidth: attributes.videoWidth || 1920,
    videoHeight: attributes.videoHeight || 1080,
    duration: attributes.duration || 1800,
    loop: false,
    muted: false,
    autoplay: attributes.autoplay !== undefined ? attributes.autoplay : true,
    clientWidth: attributes.clientWidth || 640,
    clientHeight: attributes.clientHeight || 480,
    type: attributes.type || "",
    poster: attributes.poster || "",
    getAttribute(name) {
      return attributes[name] || null;
    },
    getBoundingClientRect() {
      return {
        width: attributes.width || 640,
        height: attributes.height || 480,
        top: 0,
        left: 0,
        bottom: (attributes.height || 480),
        right: (attributes.width || 640),
      };
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    ...extra,
  };
}

// ─── Test 1: Iframe URL detection ────────────────────────────────────────

{
  console.log("--- Test 1: playmogo.com iframe URL should be detected and downloadable ---");

  const seenUrls = new Map();
  const detection = createDetection({
    url: "https://pinaypie.com/watch/some-episode",
    docTitle: "Watch Episode 10 Online - PinayPie",
    seenUrls,
  });

  // Test that playmogo.com URL passes through isDownloadableUrl
  const iframeUrl = "https://playmogo.com/e/k2c18kmf5fea";
  const downloadable = mediaCandidates.isDownloadableMediaUrl(iframeUrl, "");
  assert.ok(downloadable, "playmogo.com iframe URL should be downloadable");

  // Test that the URL is not blocked
  const blocked = mediaCandidates.isBlockedMediaUrl(iframeUrl, "");
  assert.ok(!blocked, "playmogo.com iframe URL should NOT be blocked");

  // Create a candidate like scanVisiblePlayerFrames would
  const candidate = {
    url: iframeUrl,
    format: "PAGE",
    source: "iframe-page",
    contentType: "",
    pageUrl: "https://pinaypie.com/watch/some-episode",
    frameUrl: "https://pinaypie.com/watch/some-episode",
    title: "Watch Episode 10 Online - PinayPie",
    thumbnailUrl: "",
    downloadable: true,
    width: 640,
    height: 480,
    duration: 0,
  };

  const added = detection.addBuiltCandidate([], candidate);
  assert.ok(added, "iframe-page candidate should be added");
  assert.equal(added.url, iframeUrl);
  assert.equal(added.format, "PAGE");
  assert.equal(added.source, "iframe-page");

  console.log("  ✓ playmogo.com URL is downloadable and not blocked");
  console.log("  ✓ iframe-page candidate created with correct format and source");
}

// ─── Test 2: HLS video inside iframe detection ──────────────────────────

{
  console.log("\n--- Test 2: HLS video inside iframe (playmogo.com player) ---");

  const seenUrls = new Map();
  const detection = createDetection({
    url: "https://playmogo.com/e/k2c18kmf5fea",
    docTitle: "Video Player | playmogo",
    seenUrls,
  });

  // Simulate what the content script inside the iframe would detect:
  // a <video> element with an HLS stream URL
  const hlsUrl = "https://cdn.playmogo.com/hls/master.m3u8?token=abc123";
  const video = createVideoMock({
    currentSrc: hlsUrl,
    type: "application/x-mpegURL",
    duration: 1800,
  });

  // Test that the HLS URL is downloadable
  assert.ok(mediaCandidates.isDownloadableMediaUrl(hlsUrl, "application/x-mpegURL"),
    "HLS URL should be downloadable");

  // Test classification
  const format = mediaCandidates.classifyMediaUrl(hlsUrl, "application/x-mpegURL");
  assert.equal(format, "M3U8", "HLS URL should be classified as M3U8");

  // Test buildCandidate (what addCandidate does internally)
  // We need to test through addCandidate which is the main entry point
  const candidates = [];
  const added = detection.addCandidate(candidates, hlsUrl, "dom-video", "application/x-mpegURL", video);

  if (added) {
    console.log("  ✓ HLS video detected:", added.url);
    console.log("  Format:", added.format);
    console.log("  Source:", added.source);
    console.log("  Duration:", added.duration);
    assert.equal(added.format, "M3U8");
    assert.equal(added.source, "dom-video");
    assert.ok(added.downloadable !== false);
  } else {
    console.log("  ! HLS video was filtered out by buildCandidate");
    console.log("  This could mean isLikelyFullLengthVideoCandidate rejected it");
    // Let's check why
    const testCandidate = detection.buildCandidate(hlsUrl, "dom-video", "application/x-mpegURL", video);
    if (testCandidate) {
      console.log("  buildCandidate succeeded but addCandidate returned null (seenUrls?)");
    } else {
      console.log("  buildCandidate returned null - checking filters...");
      console.log("  isBlockedVideoUrl:", mediaCandidates.isBlockedMediaUrl(hlsUrl, "application/x-mpegURL"));
      console.log("  isDownloadableMediaUrl:", mediaCandidates.isDownloadableMediaUrl(hlsUrl, "application/x-mpegURL"));
    }
    assert.ok(added !== null, "HLS video should be detected by buildCandidate");
  }
}

// ─── Test 3: Direct MP4 video throughput ────────────────────────────────

{
  console.log("\n--- Test 3: Direct MP4 video detection ---");

  const seenUrls = new Map();
  const detection = createDetection({
    url: "https://example.com/video",
    docTitle: "Test Video",
    seenUrls,
  });

  const mp4Url = "https://cdn.example.com/videos/movie.mp4";
  const video = createVideoMock({
    currentSrc: mp4Url,
    type: "video/mp4",
    duration: 3600,
  });

  const candidates = [];
  const added = detection.addCandidate(candidates, mp4Url, "dom-video", "video/mp4", video);

  assert.ok(added, "MP4 video should be detected");
  assert.equal(added.format, "MP4");
  assert.equal(added.source, "dom-video");
  assert.ok(added.downloadable !== false, "MP4 should be downloadable");

  console.log("  ✓ Direct MP4 detected:", added.url);
}

// ─── Test 4: Video filters integration with iframe candidates ───────────

{
  console.log("\n--- Test 4: Video filters integration ---");

  // Verify that known iframe video hosting URLs pass through filters
  const testUrls = [
    { url: "https://playmogo.com/e/k2c18kmf5fea", desc: "playmogo embed", expected: true },
    { url: "https://playmogo.com/e/l6vrloft7rzt", desc: "playmogo embed from pinaypie.sh", expected: true },
    { url: "https://playmogo.com/some-video-title", desc: "playmogo page", expected: true },
    { url: "https://vibeplayer.net/e/abc123", desc: "vibeplayer embed", expected: true },
    { url: "https://pinaypie.sh/humihigpit-ang-kapait-ni-anne-kapag-nasasarapan/", desc: "pinaypie.sh page URL", expected: true },
    { url: "https://example.com/video.mp4", desc: "direct mp4", expected: true },
    { url: "https://cdn.example.com/hls/master.m3u8", desc: "hls manifest", expected: true },
    { url: "https://doubleclick.net/preroll.mp4", desc: "ad network", expected: false },
  ];

  for (const { url, desc, expected } of testUrls) {
    const result = mediaCandidates.isDownloadableMediaUrl(url, "");
    const status = result === expected ? "✓" : "✗";
    console.log(`  ${status} ${desc}: ${url} → ${result ? "downloadable" : "blocked"}`);
    assert.equal(result, expected, `Expected ${desc} to be ${expected ? "downloadable" : "blocked"}`);
  }
}

// ─── Test 5: Dynamic video element with innerHTML ───────────────────────

{
  console.log("\n--- Test 5: detectFormat and classifyUrl for dynamically loaded video ---");

  // When a video element is dynamically added with a src attribute,
  // the format should be correctly detected
  const testCases = [
    { url: "https://cdn.nextflicks.com/stream/master.m3u8", type: "application/x-mpegURL", expected: "M3U8" },
    { url: "https://cdn.nextflicks.com/dash/manifest.mpd", type: "application/dash+xml", expected: "MPD" },
    { url: "https://cdn.nextflicks.com/videos/movie.mp4", type: "video/mp4", expected: "MP4" },
    { url: "https://cdn.nextflicks.com/videos/clip.webm", type: "video/webm", expected: "WEBM" },
    { url: "https://nextflicks.com/watch/movie-123", type: "", expected: "VIDEO" },
  ];

  for (const { url, type, expected } of testCases) {
    const format = mediaCandidates.classifyMediaUrl(url, type);
    const status = format === expected ? "✓" : "✗";
    console.log(`  ${status} ${url} → ${format} (expected ${expected})`);
    assert.equal(format, expected, `Expected ${expected}, got ${format}`);
  }
}

// ─── Test 6: Blob URL handling with MSE intercept ───────────────────────

{
  console.log("\n--- Test 6: Blob URL handling ---");

  // Blob URLs should be classified but NOT downloadable directly
  const blobUrl = "blob:https://nextflicks.com/uuid-abc-123";
  const format = mediaCandidates.classifyMediaUrl(blobUrl, "");
  assert.equal(format, "BLOB", "blob: URLs should be classified as BLOB");

  const downloadable = mediaCandidates.isDownloadableMediaUrl(blobUrl, "");
  assert.ok(downloadable, "blob: URLs should pass through isDownloadableMediaUrl (handled later)");

  // Check that the format check correctly identifies blob: URLs
  const hasHttp = mediaCandidates.isHttpUrl(blobUrl);
  assert.ok(hasHttp, "blob: URLs should be treated as HTTP URLs for filtering purposes");

  console.log("  ✓ blob: URL classified as BLOB format");
  console.log("  ✓ blob: URL passes through isDownloadableMediaUrl");
}

console.log("\n✓ All iframe and dynamic video detection tests passed!");
