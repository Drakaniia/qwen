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
  "content overlay must still include quality dialog helpers for future extension use"
);

assert.match(
  source,
  /sendMessage\(\{\s*type:\s*"openPopup"\s*\}\)/,
  "content overlay clicks must send a message to open the extension popup instead of showing a local quality dialog"
);

assert.match(
  source,
  /button\.textContent\s*=\s*"Download"/,
  "content overlay button must be labeled as Download for clear intent"
);

assert.match(
  source,
  /button\.title\s*=\s*"Open available video"/,
  "content overlay button must have a title explaining its navigation behavior"
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
