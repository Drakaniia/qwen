const path = require("path");
const assert = require("assert");

// Setup environment for the shared scripts
globalThis.QwinMediaCandidates = require(path.resolve(__dirname, "../../src/shared/media_candidates.js"));
const videoFilters = require(path.resolve(__dirname, "../../src/shared/video_filters.js"));

console.log("Running Video Filters Tests...");

try {
  // Test Case 1: Regular video candidate should be accepted
  const normalVideo = {
    url: "https://example.com/video.mp4",
    source: "dom-video",
    duration: 60,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(normalVideo),
    true,
    "Normal video should be accepted",
  );

  // Test Case 2: Short video candidate should be rejected
  const shortVideo = {
    url: "https://example.com/clip.mp4",
    source: "dom-video",
    duration: 10,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(shortVideo),
    false,
    "Short video should be rejected",
  );

  // Test Case 3: "performance" source video with NO duration (unknown)
  // CURRENT BEHAVIOR: Returns true (accepted)
  // DESIRED BEHAVIOR: Returns false (rejected) because it's likely a clip
  const performanceUnknown = {
    url: "https://example.com/resource.mp4",
    source: "performance",
    duration: 0,
  };
  console.log("Testing performanceUnknown...");
  const resultUnknown = videoFilters.isLikelyFullLengthVideoCandidate(performanceUnknown);
  console.log("Result for performanceUnknown:", resultUnknown);
  assert.strictEqual(resultUnknown, false, "Performance source with unknown duration should be rejected as a clip");

  // Test Case 4: "performance" source video with LONG duration
  // DESIRED BEHAVIOR: Returns true (accepted)
  const performanceFull = {
    url: "https://example.com/full.mp4",
    source: "performance",
    duration: 120,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(performanceFull),
    true,
    "Performance source with long duration should be accepted",
  );

  // Test Case 5: URL with "performance" keyword but NOT "performance" source
  const performanceKeyword = {
    url: "https://example.com/performance.mp4",
    source: "dom-video",
    duration: 0,
  };
  console.log("Testing performanceKeyword...");
  const resultKeyword = videoFilters.isLikelyFullLengthVideoCandidate(performanceKeyword);
  console.log("Result for performanceKeyword:", resultKeyword);
  // We might want this to be false too if "performance" is a clip keyword
  // assert.strictEqual(resultKeyword, false, 'URL with performance keyword should be rejected');

  // Test Case 6: Page fallback candidate with format PAGE should be accepted
  const pageFallback = {
    url: "https://example.com/article",
    source: "page-fallback",
    format: "PAGE",
    downloadable: true,
    pageUrl: "https://example.com/article",
    title: "Article Title",
    duration: 120,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(pageFallback),
    true,
    "Page fallback candidate should be accepted as full-length video",
  );

  // Test Case 7: Direct video and page fallback on same page get grouped
  const directMp4 = {
    url: "https://cdn.example.com/video.mp4",
    source: "dom-video",
    format: "MP4",
    downloadable: true,
    pageUrl: "https://example.com/article",
    title: "Article Title",
    duration: 120,
    width: 1920,
    height: 1080,
  };
  const grouped = videoFilters.groupUniqueFullVideos([directMp4, pageFallback]);
  assert.strictEqual(Array.isArray(grouped), true, "groupUniqueFullVideos should return an array");
  assert.strictEqual(grouped.length, 1, "Direct MP4 and page fallback should be grouped into one video");
  assert.strictEqual(grouped[0].downloadable, true, "Grouped video should be downloadable");

  // Test Case 8: groupUniqueFullVideos identifies PAGE format video as playlist-like
  const pageOnly = videoFilters.groupUniqueFullVideos([pageFallback]);
  assert.strictEqual(pageOnly.length, 1, "Page fallback alone should produce a group");
  assert.strictEqual(pageOnly[0].downloadable, true, "Page fallback group should be downloadable");

  // Test Case 9: sourceLabel for page-fallback should show "full video" not "manual link"
  // BUG: PAGE format + page-fallback source currently returns "manual link" (wrong)
  // DESIRED: Should return "full video" like other extractor-based formats
  const labelPageFallback = videoFilters.sourceLabel({ format: "PAGE", source: "page-fallback" });
  console.log("sourceLabel for page-fallback:", JSON.stringify(labelPageFallback));
  assert.strictEqual(
    labelPageFallback,
    "full video",
    "PAGE format with page-fallback source should show as full video, not manual link",
  );

  // Test Case 10: sourceLabel for manual-url should still be "manual link"
  const labelManualUrl = videoFilters.sourceLabel({ format: "PAGE", source: "manual-url" });
  assert.strictEqual(labelManualUrl, "manual link", "manual-url source should show as manual link");

  // Test Case 11: sourceLabel for M3U8 should be "full video"
  const labelM3U8 = videoFilters.sourceLabel({ format: "M3U8" });
  assert.strictEqual(labelM3U8, "full video", "M3U8 format should show as full video");

  console.log("All tests passed!");
} catch (error) {
  console.error("Test failed!");
  console.error(error);
  process.exit(1);
}
