import assert from "node:assert/strict";

import * as playlistDetection from "../../../src/shared/playlist_detection.js";
import * as mediaCandidates from "../../../src/shared/media_candidates.js";

// ─── YouTube playlist URLs ──────────────────────────────────────────────────

assert.equal(
  playlistDetection.isPlaylistUrl("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube playlist URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube Music playlist URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube watch URL with list param should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  false,
  "YouTube watch URL without list param should NOT be a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://youtu.be/dQw4w9WgXcQ"),
  false,
  "Short YouTube URL without list param should NOT be a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://youtu.be/dQw4w9WgXcQ?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "Short YouTube URL with list param should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube Shorts URL with list param should be detected as a playlist",
);

// ─── Spotify playlist/album URLs ─────────────────────────────────────────────

assert.equal(
  playlistDetection.isPlaylistUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  true,
  "Spotify playlist URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo"),
  true,
  "Spotify album URL should be detected as a playlist (album = batch download)",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
  false,
  "Spotify track URL should NOT be detected as a playlist",
);

// ─── Apple Music playlist/album URLs ─────────────────────────────────────────

assert.equal(
  playlistDetection.isPlaylistUrl("https://music.apple.com/us/playlist/pl.u-abc123"),
  true,
  "Apple Music playlist URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://music.apple.com/us/album/greatest-hits/1234567890"),
  true,
  "Apple Music album URL should be detected as a playlist (album = batch)",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://music.apple.com/us/song/1234567890"),
  false,
  "Apple Music track URL should NOT be detected as a playlist",
);

// ─── SoundCloud ──────────────────────────────────────────────────────────────

assert.equal(
  playlistDetection.isPlaylistUrl("https://soundcloud.com/user/sets/playlist-name"),
  true,
  "SoundCloud set URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://soundcloud.com/user/track-name"),
  false,
  "SoundCloud track URL should NOT be detected as a playlist",
);

// ─── Non-playlist URLs ───────────────────────────────────────────────────────

assert.equal(
  playlistDetection.isPlaylistUrl("https://example.com/video.mp4"),
  false,
  "Plain video URL should NOT be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  false,
  "YouTube watch URL should NOT be a playlist (no list param)",
);

assert.equal(
  playlistDetection.isPlaylistUrl(""),
  false,
  "Empty string should NOT be detected as a playlist",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://example.com"),
  false,
  "Plain domain should NOT be detected as a playlist",
);

// ─── Playlist source extraction ─────────────────────────────────────────────

assert.equal(
  playlistDetection.getPlaylistSource("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  "youtube",
  "YouTube playlist source should be 'youtube'",
);

assert.equal(
  playlistDetection.getPlaylistSource("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  "spotify",
  "Spotify playlist source should be 'spotify'",
);

assert.equal(
  playlistDetection.getPlaylistSource("https://music.apple.com/us/playlist/pl-u-abc123"),
  "apple-music",
  "Apple Music playlist source should be 'apple-music'",
);

assert.equal(
  playlistDetection.getPlaylistSource("https://soundcloud.com/user/sets/playlist-name"),
  "soundcloud",
  "SoundCloud set source should be 'soundcloud'",
);

assert.equal(
  playlistDetection.getPlaylistSource("https://example.com/video.mp4"),
  "",
  "Non-playlist URL source should be empty string",
);

// ─── Playlist ID extraction ──────────────────────────────────────────────────

assert.equal(
  playlistDetection.extractPlaylistId("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
  "YouTube playlist ID should be extracted from list param",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2"),
  "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
  "YouTube playlist ID should be extracted from watch URL with list param",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  "37i9dQZF1DXcBWIGoYBM5M",
  "Spotify playlist ID should be the last path segment",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo"),
  "",
  "Album URLs should return empty ID (albums are handled differently)",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk"),
  "Spotify Show",
  "Spotify show URL should get 'Spotify Show' title",
);

assert.equal(
  playlistDetection.isPlaylistUrl("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk"),
  true,
  "Spotify show URL should be detected as a playlist",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://music.apple.com/us/playlist/pl-u-abc123"),
  "pl-u-abc123",
  "Apple Music playlist ID should be the last path segment",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://soundcloud.com/user/sets/playlist-name"),
  "playlist-name",
  "SoundCloud set ID should be the last path segment after /sets/",
);

assert.equal(
  playlistDetection.extractPlaylistId("https://example.com/video.mp4"),
  "",
  "Non-playlist URL should return empty ID",
);

// ─── isPlaylistPage check (for detecting current page context) ────────────────

assert.equal(
  playlistDetection.isPlaylistPage("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube playlist page should be detected",
);

assert.equal(
  playlistDetection.isPlaylistPage("https://music.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  true,
  "YouTube Music playlist page should be detected",
);

assert.equal(
  playlistDetection.isPlaylistPage("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  true,
  "Spotify playlist page should be detected",
);

assert.equal(
  playlistDetection.isPlaylistPage("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  false,
  "YouTube watch page with playlist should NOT be detected (still a watch page)",
);

assert.equal(
  playlistDetection.isPlaylistPage("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
  false,
  "Spotify track page should NOT be detected as a playlist page",
);

// ─── getPlaylistTitle ───────────────────────────────────────────────────────

assert.equal(
  playlistDetection.getPlaylistTitle("https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"),
  "YouTube Playlist",
  "YouTube playlist should get generic title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"),
  "Spotify Playlist",
  "Spotify playlist should get generic title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwHQyo"),
  "Spotify Album",
  "Spotify album should get appropriate title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://music.apple.com/us/playlist/pl-u-abc123"),
  "Apple Music Playlist",
  "Apple Music playlist should get generic title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://music.apple.com/us/album/greatest-hits/1234567890"),
  "Apple Music Album",
  "Apple Music album should get appropriate title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://soundcloud.com/user/sets/playlist-name"),
  "SoundCloud Playlist",
  "SoundCloud set should get generic title",
);

assert.equal(
  playlistDetection.getPlaylistTitle("https://example.com/video.mp4"),
  "",
  "Non-playlist URL should return empty string",
);

// ─── Batch info helpers ─────────────────────────────────────────────────────

// getBatchInfo is used to provide metadata about a playlist for batch download UI.
// It returns { isPlaylist, title, source, itemCount (estimated), playlistUrl }
const batchInfo = playlistDetection.getBatchInfo({
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
  title: "Never Gonna Give You Up",
  pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
});

assert.equal(
  batchInfo.isPlaylist,
  true,
  "getBatchInfo should detect playlist on watch URL with list param",
);

assert.equal(
  batchInfo.source,
  "youtube",
  "getBatchInfo should detect YouTube source",
);

assert.equal(
  batchInfo.title,
  "YouTube Playlist",
  "getBatchInfo should provide playlist title",
);

assert.ok(
  typeof batchInfo.itemCount === "number",
  "getBatchInfo should have an itemCount field",
);

assert.ok(
  batchInfo.playlistUrl,
  "getBatchInfo should have a playlistUrl field",
);

// Non-playlist video should not have batch info
const nonBatchInfo = playlistDetection.getBatchInfo({
  url: "https://cdn.example.com/movie.mp4",
  title: "Movie",
  pageUrl: "https://example.com/watch/123",
});

assert.equal(
  nonBatchInfo.isPlaylist,
  false,
  "getBatchInfo for non-playlist video should return isPlaylist=false",
);

// YouTube watch without list param should not be a batch
const noListInfo = playlistDetection.getBatchInfo({
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
});

assert.equal(
  noListInfo.isPlaylist,
  false,
  "getBatchInfo for simple YouTube watch should return isPlaylist=false",
);

// Spotify playlist page
const spotifyBatchInfo = playlistDetection.getBatchInfo({
  url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
  title: "Today's Top Hits",
  pageUrl: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
});

assert.equal(
  spotifyBatchInfo.isPlaylist,
  true,
  "getBatchInfo should detect Spotify playlist",
);

assert.equal(
  spotifyBatchInfo.source,
  "spotify",
  "getBatchInfo for Spotify playlist should show source 'spotify'",
);

// HLS/DASH stream manifest should NOT be treated as a batch playlist
// (These are individual stream manifests, not collections of videos)
const manifestInfo = playlistDetection.getBatchInfo({
  url: "https://cdn.example.com/master.m3u8",
  format: "M3U8",
  pageUrl: "https://streaming.example.com/video/123",
});

assert.equal(
  manifestInfo.isPlaylist,
  false,
  "getBatchInfo for HLS manifest should NOT be a batch playlist",
);

console.log("playlist detection tests passed");
