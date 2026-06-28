"use strict";

/**
 * Browser download utilities for the chrome.downloads API backend.
 *
 * Provides pure functions for determining whether a video format is
 * suitable for browser-based direct download and deriving filenames.
 */

/**
 * Check whether a video format can be downloaded directly via the
 * browser's chrome.downloads API (i.e., it's a direct media URL and
 * not a streaming format like HLS or DASH).
 *
 * @param {string|null|undefined} format - The format string (e.g. "MP4", "M3U8").
 * @returns {boolean} true if the format is suitable for browser download.
 */
function isBrowserDownloadableFormat(format) {
  const f = String(format || "").toUpperCase();
  return f !== "M3U8" && f !== "MPD" && f !== "HLS" && f !== "DASH" && f !== "ISM" && f !== "SMOOTH";
}

/**
 * Derive a safe filename from a video object.
 *
 * Uses the video title and the extension from the URL. Falls back to
 * "video" for the name and "mp4" for the extension. Sanitises the title
 * by removing filesystem-unsafe characters and truncating to 200 chars.
 *
 * @param {Object} video - Video object with `url` and optional `title`.
 * @returns {string} A safe filename with extension.
 */
function filenameFromVideo(video) {
  const extMatch = String(video.url || "").match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const ext = (extMatch ? extMatch[1].toLowerCase() : "mp4").replace(/[^a-z0-9]/g, "");
  const safeTitle = (video.title || "video").replace(/[<>:"/\\|?*]/g, "_").slice(0, 200);
  return `${safeTitle}.${ext}`;
}

export { isBrowserDownloadableFormat, filenameFromVideo };
