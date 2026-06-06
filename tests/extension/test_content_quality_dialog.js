const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../src/content/content.js"), "utf8");

assert.match(
  source,
  /function\s+formatQualityValue\s*\(/,
  "content overlay must format quality metadata for comparison rows"
);

assert.match(
  source,
  /function\s+showQualityLoadingDialog\s*\(/,
  "content overlay must show a quality dialog immediately while versions load"
);

assert.match(
  source,
  /const\s+requestToken\s*=\s*showQualityLoadingDialog\(\)/,
  "content overlay clicks must open a loading dialog before asking the helper for formats"
);

assert.ok(
  source.indexOf("const requestToken = showQualityLoadingDialog()") <
    source.indexOf("const formatsResponse = await sendMessageWithResponse("),
  "content overlay must show loading feedback before awaiting format lookup"
);

assert.match(
  source,
  /button\.dataset\.variantId\s*=/,
  "content overlay choices must preserve the selected source variant id"
);

assert.match(
  source,
  /button\.dataset\.backend\s*=/,
  "content overlay choices must preserve the selected downloader backend"
);

assert.match(
  source,
  /type:\s*"downloadVideo"/,
  "content overlay should download by grouped video id after choosing a version"
);

assert.match(
  source,
  /variantId:\s*selectedFormat\.variantId/,
  "content overlay download requests must send the selected source variant id"
);

assert.match(
  source,
  /backend:\s*selectedFormat\.backend/,
  "content overlay download requests must send the selected downloader backend"
);

assert.match(
  source,
  /function\s+thumbnailForVideo\s*\(/,
  "content scanner must read a thumbnail or poster URL for downloadable videos"
);

assert.match(
  source,
  /thumbnailUrl:\s*thumbnailForVideo\(video\)/,
  "content scanner must include thumbnailUrl in detected video candidates"
);

assert.match(
  source,
  /function\s+pageFallbackCandidateForVideo\s*\(/,
  "content overlay must build a yt-dlp page fallback candidate when the player uses a browser-only media URL"
);

assert.match(
  source,
  /source:\s*"page-fallback"/,
  "content overlay page fallback candidates must be marked so background downloads the page URL, not an unrelated detected stream"
);

assert.match(
  source,
  /overlayCandidate\s*\|\|\s*pageFallbackCandidate/,
  "content overlay must prefer the clicked player's page fallback over getBestVideoFormats"
);

assert.match(
  source,
  /const\s+seenUrls\s*=\s*new Map\(\)/,
  "content scanner must track per-URL metadata signatures, not just suppress repeated URLs"
);

assert.match(
  source,
  /seenUrls\.set\(candidate\.url,\s*signature\)/,
  "content scanner must republish a URL when thumbnail or metadata improves"
);

console.log("content quality dialog tests passed");
