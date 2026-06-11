const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mediaCandidates = require(path.join(__dirname, "../../src/shared/media_candidates.js"));
const filters = require(path.join(__dirname, "../../src/shared/video_filters.js"));
const candidateRules = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../fixtures/media_candidate_rules.json"), "utf8")
);

for (const rule of candidateRules) {
  assert.equal(
    mediaCandidates.classifyMediaUrl(rule.url, rule.contentType),
    rule.format,
    `${rule.name} should classify through media candidate contract`
  );
  assert.equal(
    mediaCandidates.isBlockedMediaUrl(rule.url, rule.contentType),
    rule.blocked,
    `${rule.name} should have expected blocked status through media candidate contract`
  );
  assert.equal(
    mediaCandidates.isDownloadableMediaUrl(rule.url, rule.contentType),
    rule.downloadable,
    `${rule.name} should have expected downloadable status through media candidate contract`
  );
  assert.equal(
    filters.classifyVideoUrl(rule.url, rule.contentType),
    rule.format,
    `${rule.name} should classify consistently`
  );
  assert.equal(
    filters.isBlockedVideoUrl(rule.url, rule.contentType),
    rule.blocked,
    `${rule.name} should have expected blocked status`
  );
  assert.equal(
    filters.isDownloadableUrl(rule.url, rule.contentType),
    rule.downloadable,
    `${rule.name} should have expected downloadable status`
  );
}

assert.equal(filters.isBlockedVideoUrl("https://ads.example.com/preroll.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/banner.gif"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/preview.mp4", "image/gif"), true);
assert.equal(filters.isBlockedVideoUrl("https://media.example.com/tenor-preview.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/giphy-loop.webm"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/hls/segment-00001.ts"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/dash/chunk-42.m4s"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/video/frag-001.mp4"), true);
assert.equal(filters.isBlockedVideoUrl("https://george.xtremestream.xyz/player/assets/jwplayer-8.34.0/provider.hlsjs"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/hls/720p/000012.mp4?token=abc"), true);
assert.equal(
  filters.isBlockedVideoUrl(
    "https://rr3---sn.example.googlevideo.com/videoplayback?expire=1799999999&itag=137&mime=video%2Fmp4&range=0-1000"
  ),
  true
);
assert.equal(filters.isBlockedVideoUrl("https://www.youtube.com/manifest.webmanifest"), true);
assert.equal(filters.isBlockedVideoUrl("https://www.youtube.com/manifest.json", "application/manifest+json"), true);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/master.m3u8"), false);
assert.equal(filters.isBlockedVideoUrl("https://cdn.example.com/movie.mp4"), false);
assert.equal(filters.isYouTubeVideoPageUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
assert.equal(filters.isYouTubeVideoPageUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=abc"), true);
assert.equal(filters.isYouTubeVideoPageUrl("https://youtu.be/dQw4w9WgXcQ?t=10"), true);
assert.equal(filters.isYouTubeVideoPageUrl("https://www.youtube.com/results?search_query=ai"), false);
assert.equal(
  filters.normalizeYouTubeVideoPageUrl("https://youtu.be/dQw4w9WgXcQ?t=10"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  filters.normalizeYouTubeVideoPageUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share"),
  "https://www.youtube.com/shorts/dQw4w9WgXcQ"
);
assert.equal(filters.classifyVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", ""), "YOUTUBE");
assert.equal(filters.displayVideoFormat({ format: "YOUTUBE" }), "MP4");

assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/hls/segment-00001.ts", "media", ""), false);
assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/dash/chunk-42.m4s", "media", ""), false);
assert.equal(
  filters.isLikelyVideoRequest(
    "https://george.xtremestream.xyz/player/assets/jwplayer-8.34.0/provider.hlsjs",
    "media",
    "application/javascript"
  ),
  false
);
assert.equal(filters.isLikelyVideoRequest("https://cdn.example.com/hls/720p/000012.mp4?token=abc", "media", ""), false);
assert.equal(
  filters.isLikelyVideoRequest(
    "https://rr3---sn.example.googlevideo.com/videoplayback?expire=1799999999&itag=137&mime=video%2Fmp4&range=0-1000",
    "media",
    "video/mp4"
  ),
  false
);
assert.equal(filters.isLikelyVideoRequest("https://www.youtube.com/manifest.webmanifest", "media", ""), false);
assert.equal(filters.isDownloadableUrl("https://www.youtube.com/manifest.webmanifest", ""), false);

assert.equal(filters.classifyVideoUrl("https://cdn.example.com/master.m3u8", ""), "M3U8");
assert.equal(filters.classifyVideoUrl("https://cdn.example.com/clip.webm", ""), "WEBM");
assert.equal(filters.classifyVideoUrl("https://cdn.example.com/manifest", "application/dash+xml"), "MPD");
assert.equal(filters.classifyVideoUrl("https://cdn.example.com/live/channel.ism/Manifest", ""), "ISM");
assert.equal(filters.displayVideoFormat({ format: "M3U8" }), "MP4");
assert.equal(filters.displayVideoFormat({ format: "MPD" }), "MP4");
assert.equal(filters.displayVideoFormat({ format: "ISM" }), "MP4");
assert.equal(filters.displayVideoFormat({ format: "WEBM" }), "WEBM");
assert.equal(filters.displayVideoSize({ sizeBytes: 98_000_000 }), "93.5 MB");
assert.equal(filters.displayVideoSize({ size: "1.4 GB" }), "1.4 GB");
assert.equal(filters.displayVideoSize({ format: "M3U8", url: "https://cdn.example.com/master.m3u8", sizeBytes: 4000 }), "");
assert.equal(
  filters.displayVideoSize({
    variants: [{ sizeBytes: 12_000_000 }, { sizeBytes: 98_000_000 }],
  }),
  "93.5 MB"
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/movie-1080p.mp4",
    title: "Sample Movie",
    duration: 420,
  }),
  true
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/movie-preview.mp4",
    title: "Sample Movie preview",
    duration: 420,
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://www.youtube.com/manifest.webmanifest",
    title: "YouTube Video",
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/movie.mp4",
    title: "Sample Movie",
    duration: 12,
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/movie.mp4",
    title: "Sample Movie",
    duration: 420,
    downloadable: false,
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/movie.mp4",
    title: "Sample Movie",
    sizeBytes: 31,
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://cdn.example.com/master.m3u8",
    title: "Sample Movie",
    format: "M3U8",
    sizeBytes: 31,
  }),
  true
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://rr3---sn.example.googlevideo.com/videoplayback?expire=1799999999&itag=137&mime=video%2Fmp4",
    title: "YouTube Video",
    contentType: "video/mp4",
    duration: 420,
  }),
  false
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "YouTube Video",
    format: "YOUTUBE",
    source: "youtube-page",
    duration: 12,
  }),
  true
);
assert.equal(filters.displayVideoFormat({ format: "PAGE" }), "MP4");
for (const url of [
  "https://www.instagram.com/reels/ABC123/",
  "https://www.tiktok.com/@creator/video/1234567890123456789",
  "https://x.com/example/status/1234567890123456789",
  "https://www.threads.net/@example/post/ABC123",
]) {
  assert.equal(
    filters.isLikelyFullLengthVideoCandidate({
      url,
      title: "Manual social link",
      format: "PAGE",
      source: "manual-url",
      duration: 8,
    }),
    true,
    `manual extractor page should be accepted: ${url}`
  );
}

const groupedVideos = filters.groupUniqueFullVideos([
  {
    id: "v_720",
    url: "https://cdn-a.example.com/media/sample-movie-720p.mp4?token=one",
    title: "Sample Movie",
    pageUrl: "https://example.com/watch/sample",
    format: "MP4",
    source: "network",
    duration: 420,
    height: 720,
    sizeBytes: 42_000_000,
    downloadable: true,
  },
  {
    id: "v_1080",
    url: "https://cdn-b.example.com/media/sample-movie-1080p.webm?token=two",
    title: "Sample Movie",
    pageUrl: "https://example.com/watch/sample",
    format: "WEBM",
    source: "headers",
    duration: 420,
    height: 1080,
    sizeBytes: 98_000_000,
    downloadable: true,
  },
  {
    id: "v_preview",
    url: "https://cdn.example.com/media/sample-movie-preview.mp4",
    title: "Sample Movie Preview",
    pageUrl: "https://example.com/watch/sample",
    format: "MP4",
    source: "network",
    duration: 8,
    height: 360,
    downloadable: true,
  },
]);

assert.equal(groupedVideos.length, 1);
assert.equal(groupedVideos[0].variants.length, 2);
assert.equal(groupedVideos[0].height, 1080);
assert.equal(groupedVideos[0].sizeBytes, 98_000_000);
assert.equal(groupedVideos[0].variantCount, 2);

const sortedVideos = filters.groupUniqueFullVideos([
  {
    id: "v_small_newer",
    url: "https://cdn.example.com/media/newer-small-video.mp4",
    title: "Newer Small Video",
    pageUrl: "https://example.com/watch/newer-small",
    format: "MP4",
    duration: 420,
    height: 720,
    sizeBytes: 12_000_000,
    downloadable: true,
    lastSeen: 300,
  },
  {
    id: "v_large_older",
    url: "https://cdn.example.com/media/older-large-video.mp4",
    title: "Older Large Video",
    pageUrl: "https://example.com/watch/older-large",
    format: "MP4",
    duration: 420,
    height: 720,
    sizeBytes: 210_000_000,
    downloadable: true,
    lastSeen: 100,
  },
]);

assert.equal(sortedVideos[0].id, "v_large_older");

const sortedFullVideos = filters.groupUniqueFullVideos([
  {
    id: "v_direct_newer",
    url: "https://cdn.example.com/media/direct-copy.mp4",
    title: "Direct Copy",
    pageUrl: "https://example.com/watch/direct-copy",
    format: "MP4",
    duration: 420,
    height: 720,
    sizeBytes: 12_000_000,
    downloadable: true,
    lastSeen: 300,
  },
  {
    id: "v_playlist_older",
    url: "https://cdn.example.com/media/master.m3u8",
    title: "Playlist Full Video",
    pageUrl: "https://example.com/watch/playlist-full",
    format: "M3U8",
    duration: 420,
    downloadable: true,
    lastSeen: 100,
  },
]);

assert.equal(sortedFullVideos[0].id, "v_playlist_older");

const sortedVariantVideos = filters.groupUniqueFullVideos([
  {
    id: "v_1080_smaller",
    url: "https://cdn-a.example.com/media/feature-1080p.mp4",
    title: "Feature Film",
    pageUrl: "https://example.com/watch/feature",
    format: "MP4",
    duration: 420,
    height: 1080,
    sizeBytes: 98_000_000,
    downloadable: true,
  },
  {
    id: "v_720_larger",
    url: "https://cdn-b.example.com/media/feature-720p.mp4",
    title: "Feature Film",
    pageUrl: "https://example.com/watch/feature",
    format: "MP4",
    duration: 420,
    height: 720,
    sizeBytes: 180_000_000,
    downloadable: true,
  },
]);

assert.equal(sortedVariantVideos[0].variants[0].id, "v_720_larger");
assert.equal(sortedVariantVideos[0].sizeBytes, 180_000_000);

const groupedThumbnailVideos = filters.groupUniqueFullVideos([
  {
    id: "v_dom",
    url: "https://cdn.example.com/media/example-720p.mp4",
    title: "Example Movie",
    pageUrl: "https://example.com/watch/example",
    format: "MP4",
    duration: 300,
    height: 720,
    downloadable: true,
    thumbnailUrl: "https://img.example.com/example.jpg",
  },
  {
    id: "v_network",
    url: "https://cdn.example.com/media/example-1080p.mp4",
    title: "Example Movie",
    pageUrl: "https://example.com/watch/example",
    format: "MP4",
    duration: 300,
    height: 1080,
    downloadable: true,
  },
]);

assert.equal(groupedThumbnailVideos.length, 1);
assert.equal(groupedThumbnailVideos[0].thumbnailUrl, "https://img.example.com/example.jpg");

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
