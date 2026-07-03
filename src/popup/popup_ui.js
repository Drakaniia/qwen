"use strict";

// ─── Imports ────────────────────────────────────────────────────────────────
import * as VideoPicker from "../shared/video_picker.js";
import * as videoFilters from "../shared/video_filters.js";

// ─── Constants ──────────────────────────────────────────────────────────────
const AUDIO_FORMAT = "AUDIO";

// ─── URL / video helpers ────────────────────────────────────────────────────

/**
 * Shorten a URL for display in the popup.
 * Returns "hostname/path" for short URLs, truncates long paths, adds "?..."
 * for search params.
 * @param {string} url
 * @returns {string}
 */
function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.hostname}${parsed.pathname}`;
    const suffix = parsed.search ? "?..." : "";
    return path.length > 74 ? `${path.slice(0, 34)}...${path.slice(-30)}${suffix}` : `${path}${suffix}`;
  } catch (_error) {
    return String(url || "").slice(0, 95);
  }
}

/**
 * Determine the display title for a video object.
 * Falls back to shortenUrl, then "Music" or "Video" based on format.
 * @param {Object} video
 * @returns {string}
 */
function videoTitle(video) {
  if (video && video.title) {
    return video.title;
  }
  const isAudio = video && String(video.format || "").toUpperCase() === AUDIO_FORMAT;
  return shortenUrl(video && video.url) || (isAudio ? "Music" : "Video");
}

/**
 * Display format label for a video using VideoPicker.
 * @param {Object} video
 * @returns {string}
 */
function displayFormat(video) {
  return VideoPicker.displayFormat(video, videoFilters);
}

/**
 * Source label for a video using VideoPicker.
 * @param {Object} video
 * @returns {string}
 */
function sourceLabel(video) {
  return VideoPicker.sourceLabel(video, videoFilters);
}

/**
 * Size label for a video using VideoPicker.
 * @param {Object} video
 * @returns {string}
 */
function videoSizeLabel(video) {
  return VideoPicker.videoSizeLabel(video, videoFilters);
}

/**
 * Extract a valid thumbnail URL from a video object.
 * Checks thumbnailUrl, poster, and image fields in that order.
 * Only accepts http://, https://, blob:, and data: protocols.
 * @param {Object|null} video
 * @returns {string}
 */
function videoThumbnailUrl(video) {
  const value = video && (video.thumbnailUrl || video.poster || video.image || "");
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "blob:", "data:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

/**
 * Normalize a manually entered URL. Returns empty string for invalid/non-http(s) URLs.
 * @param {string} value
 * @returns {string}
 */
function normalizeManualUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

export { shortenUrl, videoTitle, displayFormat, sourceLabel, videoSizeLabel, videoThumbnailUrl, normalizeManualUrl };
