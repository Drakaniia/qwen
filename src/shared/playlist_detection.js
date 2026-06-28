"use strict";

/**
 * Playlist / Batch Detection Module
 *
 * Detects playlist URLs across supported platforms (YouTube, Spotify,
 * Apple Music, SoundCloud) and provides metadata for batch download.
 */

// ─── Regex patterns ─────────────────────────────────────────────────────────

const YOUTUBE_PLAYLIST_PATH_RE = /^\/playlist(?:\/|$)/i;
const YOUTUBE_MUSIC_PLAYLIST_PATH_RE = /^\/playlist(?:\/|$)/i;
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
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  );
}

function isYoutubePlaylistUrl(url) {
  const host = hostname(url);
  if (!isYoutubeHost(host)) {
    return false;
  }
  const path = pathname(url);
  // youtube.com/playlist or music.youtube.com/playlist
  if (YOUTUBE_PLAYLIST_PATH_RE.test(path) || YOUTUBE_MUSIC_PLAYLIST_PATH_RE.test(path)) {
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

function getYoutubePlaylistId(url) {
  const params = searchParams(url);
  return params.get("list") || "";
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

function getSpotifyPlaylistId(url) {
  const path = pathname(url);
  // /playlist/{id}
  const match = path.match(/^\/(?:playlist|show)\/([^/?#]+)/i);
  return match ? match[1] : "";
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

function getAppleMusicPlaylistId(url) {
  const path = pathname(url);
  // /{locale}/playlist/{id} or /{locale}/album/{name}/{id}
  const match = path.match(/^\/(?:[a-z]{2}\/)?(?:playlist|album)\/(?:[^/]+\/)?([^/?#]+)/i);
  return match ? match[1] : "";
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

function getSoundCloudPlaylistId(url) {
  const path = pathname(url);
  const match = path.match(/\/sets\/([^/?#]+)/i);
  return match ? match[1] : "";
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if a URL represents a playlist or collection of media items
 * that could be downloaded as a batch.
 *
 * @param {string} url - The URL to check
 * @returns {boolean} - True if the URL is a playlist
 */
function isPlaylistUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  return (
    isYoutubePlaylistUrl(url) ||
    isSpotifyPlaylistUrl(url) ||
    isAppleMusicPlaylistUrl(url) ||
    isSoundCloudPlaylistUrl(url)
  );
}

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
 * Extract a unique identifier for a playlist URL.
 *
 * @param {string} url - The playlist URL
 * @returns {string} - The playlist ID, or empty string if not a playlist
 */
function extractPlaylistId(url) {
  if (!url || typeof url !== "string") {
    return "";
  }

  if (isYoutubePlaylistUrl(url)) {
    return getYoutubePlaylistId(url);
  }

  const host = hostname(url);

  if (isSpotifyHost(host)) {
    const path = pathname(url);
    // Albums don't have a playlist ID per se; return empty
    if (SPOTIFY_ALBUM_RE.test(path)) {
      return "";
    }
    return getSpotifyPlaylistId(url);
  }

  if (isAppleMusicHost(host)) {
    return getAppleMusicPlaylistId(url);
  }

  if (isSoundCloudHost(host)) {
    return getSoundCloudPlaylistId(url);
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

/**
 * Get batch download info for a video candidate.
 * This is used to determine if a detected video should offer
 * a "Download all from playlist" option.
 *
 * @param {Object} video - A video candidate object (from video_filters / popup)
 * @returns {Object} - { isPlaylist, title, source, itemCount, playlistUrl }
 */
function getBatchInfo(video) {
  if (!video || typeof video !== "object") {
    return {
      isPlaylist: false,
      title: "",
      source: "",
      itemCount: 0,
      playlistUrl: "",
    };
  }

  // HLS/DASH stream manifests are not batch playlists
  const format = String(video.format || "").toUpperCase();
  if (format === "M3U8" || format === "MPD" || format === "ISM") {
    return {
      isPlaylist: false,
      title: "",
      source: "",
      itemCount: 0,
      playlistUrl: "",
    };
  }

  // Check the video URL for playlist status
  const url = video.url || video.pageUrl || "";

  if (!isPlaylistUrl(url)) {
    return {
      isPlaylist: false,
      title: "",
      source: "",
      itemCount: 0,
      playlistUrl: "",
    };
  }

  const source = getPlaylistSource(url);
  const title = getPlaylistTitle(url);

  return {
    isPlaylist: true,
    source,
    title: title || video.title || "",
    itemCount: 0, // Unknown until we enumerate via native host
    playlistUrl: url,
  };
}

export {
  isPlaylistUrl,
  isPlaylistPage,
  getPlaylistSource,
  extractPlaylistId,
  getPlaylistTitle,
  getBatchInfo,
};
