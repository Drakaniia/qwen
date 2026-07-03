import assert from "node:assert/strict";

// Module under test — will be created after test fails
import { isBrowserDownloadableFormat, filenameFromVideo } from "../../../src/background/browser_download.js";

// ── isBrowserDownloadableFormat ─────────────────────────────────────────

assert.equal(isBrowserDownloadableFormat("MP4"), true, "MP4 should be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("mp4"), true, "lowercase mp4 should be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("WEBM"), true, "WebM should be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("M3U8"), false, "HLS M3U8 should NOT be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("MPD"), false, "DASH MPD should NOT be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("HLS"), false, "HLS format should NOT be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("DASH"), false, "DASH format should NOT be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("ISM"), false, "Smooth Streaming ISM should NOT be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("SMOOTH"), false, "Smooth format should NOT be browser-downloadable");

assert.equal(
  isBrowserDownloadableFormat(""),
  true,
  "empty format should be browser-downloadable (unknown defaults to direct URL)",
);

assert.equal(
  isBrowserDownloadableFormat(null),
  true,
  "null format should be browser-downloadable (unknown defaults to direct URL)",
);

assert.equal(isBrowserDownloadableFormat(undefined), true, "undefined format should be browser-downloadable");

assert.equal(isBrowserDownloadableFormat("AUDIO"), true, "AUDIO format should be browser-downloadable");

// ── filenameFromVideo ────────────────────────────────────────────────────

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.mp4", title: "My Video" }),
  "My Video.mp4",
  "should use title + url extension",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.mp4?token=abc", title: "My Video" }),
  "My Video.mp4",
  "should strip query string from extension",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video", title: "No Extension" }),
  "No Extension.mp4",
  "should default to .mp4 when no extension in URL",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.MKV", title: "Case Check" }),
  "Case Check.mkv",
  "should lowercase extension",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.webm", title: "" }),
  "video.webm",
  'should use "video" fallback title when title is empty',
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.webm" }),
  "video.webm",
  'should use "video" fallback title when title is undefined',
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/v:ideo.mp4", title: 'Bad: "chars"/\\' }),
  "Bad_ _chars___.mp4",
  "should sanitize special characters from title",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video.m3u8", title: "Stream" }),
  "Stream.m3u8",
  "should keep m3u8 extension even though not downloadable via browser",
);

assert.equal(
  filenameFromVideo({ url: "https://example.com/video", title: "A".repeat(500) }),
  "A".repeat(200) + ".mp4",
  "should truncate title to 200 characters max",
);

console.log("PASS: test_browser_download.js");
