const assert = require("node:assert/strict");
const path = require("node:path");

const filters = require(path.join(__dirname, "../../src/shared/video_filters.js"));

assert.equal(filters.isBlockedVideoUrl("https://ads.example.com/preroll.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/banner.gif"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/preview.mp4", "image/gif"), true);
assert.equal(filters.isBlockedVideoUrl("https://media.example.com/tenor-preview.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/giphy-loop.webm"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/hls/segment-00001.ts"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/dash/chunk-42.m4s"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/video/frag-001.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/hls/720p/000012.mp4?token=abc"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/master.m3u8"), false);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/movie.mp4"), false);

assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/hls/segment-00001.ts", "media", ""), false);
assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/dash/chunk-42.m4s", "media", ""), false);
assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/hls/720p/000012.mp4?token=abc", "media", ""), false);

assert.equal(filters.classifyVideoUrl("https://cdn.example.com/master.m3u8", ""), "M3U8");
assert.equal(filters.classifyVideoUrl("https://cdn.example.com/clip.webm", ""), "WEBM");
assert.equal(filters.classifyVideoUrl("https://cdn.example.com/manifest", "application/dash+xml"), "MPD");
assert.equal(filters.displayVideoFormat({ format: "M3U8" }), "MP4");
assert.equal(filters.displayVideoFormat({ format: "MPD" }), "MP4");
assert.equal(filters.displayVideoFormat({ format: "WEBM" }), "WEBM");

assert.equal(
  filters.isLikelyRealVideoBox({
    width: 640,
    height: 360,
    duration: 0,
    loop: false,
    muted: false,
    autoplay: false,
  }),
  true
);

assert.equal(
  filters.isLikelyRealVideoBox({
    width: 120,
    height: 80,
    duration: 2,
    loop: true,
    muted: true,
    autoplay: true,
  }),
  false
);

assert.equal(
  filters.isLikelyRealVideoElement({
    url: "https://cdn.example.com/movie.mp4",
    width: 640,
    height: 360,
    duration: 300,
    loop: false,
    muted: false,
    autoplay: false,
  }),
  true
);

assert.equal(
  filters.isLikelyRealVideoElement({
    url: "https://cdn.example.com/animated-gif-preview.mp4",
    width: 640,
    height: 360,
    duration: 20,
    loop: true,
    muted: true,
    autoplay: true,
  }),
  false
);

assert.equal(
  filters.isLikelyRealVideoElement({
    url: "https://media.example.com/short.mp4",
    width: 300,
    height: 170,
    duration: 3,
    loop: true,
    muted: true,
    autoplay: true,
  }),
  false
);

console.log("video filter tests passed");
