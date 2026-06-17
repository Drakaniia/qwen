import assert from "node:assert/strict";

import * as mediaCandidates from "../../src/shared/media_candidates.js";
import * as filters from "../../src/shared/video_filters.js";

// ─── YouTube Music ─────────────────────────────────────────────────────────

// YouTube Music watch page — a watch URL on music.youtube.com hosts a playable
// video that yt-dlp can extract.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  true,
  "YouTube Music watch URL should be detected as a YouTube video page",
);

assert.equal(
  mediaCandidates.normalizeYouTubeVideoPageUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube Music watch URL should normalize to standard youtube.com/watch URL",
);

assert.equal(
  mediaCandidates.classifyMediaUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  "YOUTUBE",
  "YouTube Music watch URL should classify as YOUTUBE format",
);

assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  true,
  "YouTube Music watch URL should be downloadable",
);

// YouTube Music playlist page — playlists are not individual video pages.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  false,
  "YouTube Music playlist URL should NOT be detected as a video page",
);

assert.equal(
  mediaCandidates.classifyMediaUrl("https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  "VIDEO",
  "YouTube Music playlist URL should classify as generic VIDEO (not YOUTUBE)",
);

assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube Music playlist URL should be downloadable as a manual/pasted link (yt-dlp supports it)",
);

// YouTube Music browse page (e.g. album or artist pages) — no video ID.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://music.youtube.com/browse/MPREb_4JLq6fMhDmo"),
  false,
  "YouTube Music browse URL should NOT be detected as a video page",
);

assert.equal(
  mediaCandidates.classifyMediaUrl("https://music.youtube.com/browse/MPREb_4JLq6fMhDmo"),
  "VIDEO",
  "YouTube Music browse URL should classify as generic VIDEO",
);

// YouTube Music library / history pages.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://music.youtube.com/library/albums"),
  false,
  "YouTube Music library URL should NOT be detected as a video page",
);

// Filter layer consistency
assert.equal(
  filters.isYouTubeVideoPageUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  true,
  "filters.isYouTubeVideoPageUrl should detect YouTube Music watch URLs",
);

assert.equal(
  filters.normalizeYouTubeVideoPageUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "filters.normalizeYouTubeVideoPageUrl should normalize YouTube Music watch URLs",
);

assert.equal(
  filters.classifyVideoUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  "YOUTUBE",
  "filters.classifyVideoUrl should classify YouTube Music watch URLs as YOUTUBE",
);

assert.equal(
  filters.isDownloadableUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"),
  true,
  "filters.isDownloadableUrl should accept YouTube Music watch URLs",
);

// YouTube Music watch URL considered by isLikelyFullLengthVideoCandidate
assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Example Song",
    source: "youtube-page",
    duration: 240,
  }),
  true,
  "YouTube Music watch candidate should be accepted as full-length video",
);

// YouTube Music playlist as manual URL candidate
assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
    title: "My Playlist",
    format: "PAGE",
    source: "manual-url",
    duration: 8,
  }),
  true,
  "YouTube Music playlist as manual URL should be accepted (yt-dlp extractor)",
);

// ─── Spotify ───────────────────────────────────────────────────────────────

// Spotify track page — should NOT be a YouTube video page.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
  false,
  "Spotify track URL should NOT be detected as a YouTube video page",
);

assert.equal(
  mediaCandidates.classifyMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
  "VIDEO",
  "Spotify track URL should classify as generic VIDEO (no video extension matched)",
);

// Spotify URLs pass the URL filter (valid HTTP, not blocked). The actual
// download is handled by the native host's Spotify→YouTube fallback pipeline
// (spotify_resolver.py), since yt-dlp cannot extract DRM-protected Spotify content.
assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
  true,
  "Spotify track URL passes the URL filter (native host resolves via YouTube fallback)",
);

// Spotify album page.
assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo"),
  false,
  "Spotify album URL should NOT be detected as a YouTube video page",
);

assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo"),
  true,
  "Spotify album URL should be downloadable as a manual/pasted link",
);

// Spotify playlist page.
assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  true,
  "Spotify playlist URL should be downloadable as a manual/pasted link",
);

// Spotify as manual URL candidate (pasted in settings).
// The native host resolves these via the Spotify→YouTube fallback pipeline.
assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    title: "Example Song",
    format: "PAGE",
    source: "manual-url",
    duration: 8,
  }),
  true,
  "Spotify track as manual URL should be accepted (native host resolves via YouTube)",
);

assert.equal(
  filters.isLikelyFullLengthVideoCandidate({
    url: "https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo",
    title: "Example Album",
    format: "PAGE",
    source: "manual-url",
    duration: 8,
  }),
  true,
  "Spotify album as manual URL should be accepted (native host resolves via YouTube)",
);

// ─── YouTube.com non-watch pages (control — should NOT be detected) ─────────

assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  false,
  "Standard YouTube playlist should NOT be detected as a video page",
);

assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://www.youtube.com/feed/trending"),
  false,
  "YouTube trending page should NOT be detected as a video page",
);

// ─── Negative: non-media HTTP URLs ─────────────────────────────────────────

assert.equal(
  mediaCandidates.isDownloadableMediaUrl("https://example.com"),
  true,
  "Plain example.com should be downloadable (it's an HTTP URL not blocked)",
);

assert.equal(
  filters.isDownloadableUrl("https://example.com"),
  true,
  "Plain example.com through filters should be downloadable",
);

assert.equal(
  mediaCandidates.isYouTubeVideoPageUrl("https://example.com"),
  false,
  "Plain example.com is not a YouTube page",
);

console.log("music streaming platform support tests passed");
