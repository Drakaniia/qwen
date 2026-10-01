"use strict";

/**
 * Playlist / Batch Detection Module
 *
 * Detects playlist URLs across supported platforms (YouTube, Spotify,
 * Apple Music, SoundCloud) and provides metadata for batch download.
 */
// ─── Regex patterns ─────────────────────────────────────────────────────────

const YOUTUBE_PLAYLIST_PATH_RE = /^\/playlist(?:\/|$)/i;
const SPOTIFY_PLAYLIST_RE = /^\/playlist\//i;
const SPOTIFY_ALBUM_RE = /^\/album\//i;
const SPOTIFY_SHOW_RE = /^\/show\//i;
const APPLE_MUSIC_PLAYLIST_RE = /^\/[a-z]{2}\/playlist\//i;
const APPLE_MUSIC_ALBUM_RE = /^\/[a-z]{2}\/album\//i;
const SOUNDCLOUD_SETS_RE = /\/sets\//i;

// ─── URL parsing helpers ────────────────────────────────────────────────────

function tryParseUrl(url) {
  try {
    return new URL(url);
  } catch (_error) {
    return null;
  }
}

function hostname(url) {
  const parsed = tryParseUrl(url);
  return parsed ? parsed.hostname.toLowerCase() : "";
}

function pathname(url) {
  const parsed = tryParseUrl(url);
  return parsed ? parsed.pathname : "";
}

function searchParams(url) {
  const parsed = tryParseUrl(url);
  return parsed ? parsed.searchParams : new URLSearchParams();
}

// ─── YouTube helpers ────────────────────────────────────────────────────────

function isYoutubeHost(host) {
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}

function isYoutubePlaylistUrl(url) {
  const host = hostname(url);
  if (!isYoutubeHost(host)) {
    return false;
  }
  const path = pathname(url);
  // youtube.com/playlist or music.youtube.com/playlist
  if (YOUTUBE_PLAYLIST_PATH_RE.test(path)) {
    return true;
  }
  // Any YouTube URL with a 'list' parameter (except when it's just a video)
  const params = searchParams(url);
  const list = params.get("list");
  return Boolean(list);
}

function isYoutubePlaylistOnlyPage(url) {
  // A "playlist page" is one that shows a list of videos, not a video player
  const host = hostname(url);
  if (!isYoutubeHost(host)) {
    return false;
  }
  const path = pathname(url);
  return YOUTUBE_PLAYLIST_PATH_RE.test(path);
}

// ─── Spotify helpers ────────────────────────────────────────────────────────

function isSpotifyHost(host) {
  return host === "open.spotify.com";
}

function isSpotifyPlaylistUrl(url) {
  const host = hostname(url);
  if (!isSpotifyHost(host)) {
    return false;
  }
  const path = pathname(url);
  return SPOTIFY_PLAYLIST_RE.test(path) || SPOTIFY_ALBUM_RE.test(path) || SPOTIFY_SHOW_RE.test(path);
}

// ─── Apple Music helpers ────────────────────────────────────────────────────

function isAppleMusicHost(host) {
  return host === "music.apple.com";
}

function isAppleMusicPlaylistUrl(url) {
  const host = hostname(url);
  if (!isAppleMusicHost(host)) {
    return false;
  }
  const path = pathname(url);
  return APPLE_MUSIC_PLAYLIST_RE.test(path) || APPLE_MUSIC_ALBUM_RE.test(path);
}

// ─── SoundCloud helpers ─────────────────────────────────────────────────────

function isSoundCloudHost(host) {
  return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
}

function isSoundCloudPlaylistUrl(url) {
  const host = hostname(url);
  if (!isSoundCloudHost(host)) {
    return false;
  }
  const path = pathname(url);
  // /user/sets/playlist-name
  return SOUNDCLOUD_SETS_RE.test(path);
}

// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Check if a URL is strictly a "playlist page" (not a video player page
 * that happens to be part of a playlist).
 *
 * @param {string} url - The URL to check
 * @returns {boolean} - True if the URL is a playlist landing page
 */
function isPlaylistPage(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  return isYoutubePlaylistOnlyPage(url) || isSpotifyPlaylistUrl(url);
}
/**
 * Get the source/platform identifier for a playlist URL.
 *
 * @param {string} url - The URL to check
 * @returns {string} - One of: "youtube", "spotify", "apple-music", "soundcloud", or "" if not a playlist
 */
function getPlaylistSource(url) {
  if (isYoutubePlaylistUrl(url)) {
    return "youtube";
  }
  if (isSpotifyPlaylistUrl(url)) {
    return "spotify";
  }
  if (isAppleMusicPlaylistUrl(url)) {
    return "apple-music";
  }
  if (isSoundCloudPlaylistUrl(url)) {
    return "soundcloud";
  }
  return "";
}

/**
 * Get a human-readable title for a playlist.
 *
 * @param {string} url - The playlist URL
 * @returns {string} - A descriptive title like "YouTube Playlist", or "" if not a playlist
 */
function getPlaylistTitle(url) {
  const source = getPlaylistSource(url);
  const path = pathname(url);

  switch (source) {
    case "youtube":
      return "YouTube Playlist";
    case "spotify": {
      if (SPOTIFY_ALBUM_RE.test(path)) {
        return "Spotify Album";
      }
      if (SPOTIFY_SHOW_RE.test(path)) {
        return "Spotify Show";
      }
      return "Spotify Playlist";
    }
    case "apple-music": {
      const isAlbum = APPLE_MUSIC_ALBUM_RE.test(path);
      return isAlbum ? "Apple Music Album" : "Apple Music Playlist";
    }
    case "soundcloud":
      return "SoundCloud Playlist";
    default:
      return "";
  }
}

export { isPlaylistPage, getPlaylistSource, getPlaylistTitle };
