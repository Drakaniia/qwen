"use strict";

/**
 * Shared Media Protocol Detection Patterns
 *
 * Central repository of URL patterns, Content-Type checks, and CMS
 * detection regexes shared across content scripts, background scripts,
 * and native host. This avoids duplicating detection logic across
 * multiple modules.
 *
 * Used by:
 *   - Layer 0 (Detection): content script DOM scanning
 *   - Layer 3 (SW Capture): SW fetch event filtering
 *   - Layer 4 (MSE Demux): segment classification
 *   - Layer 6 (Tunnel): URL type routing
 */

// ─── Media Content Types ───────────────────────────────────────────────────

/** Match any media-related content type. */
const MEDIA_CONTENT_TYPE_RE = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;

/** Check if a Content-Type header value indicates media content. */
function hasMediaContentType(contentType) {
  if (!contentType || typeof contentType !== "string") return false;
  return MEDIA_CONTENT_TYPE_RE.test(contentType.trim());
}

// ─── URL Patterns ─────────────────────────────────────────────────────────

/** Match segment-level URLs (.ts, .m4s, .cmfv, .cmfa). */
const SEGMENT_URL_RE = /\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\?|$)/i;

/** Match manifest URLs (.m3u8, .mpd). */
const MANIFEST_URL_RE = /\.(m3u8|mpd)(\?|$)/i;

/** Match direct media file URLs (mp4, webm, avi, mkv). */
const DIRECT_MEDIA_RE = /\.(mp4|webm|avi|mkv|mov|wmv|flv)(\?|$)/i;

/** Detect signed/token-authenticated URLs (expiry params). */
const SIGNED_URL_RE = /[?&](?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id|X-Amz-Expires|AWSAccessKeyId)=/i;

/** Detect transferMode: "stream" patterns in fetch intercept code. */
const TRANSFER_MODE_RE = /transferMode\s*[:=]\s*['"]stream['"]/i;

/** Detect WebSocket URLs. */
const WEBSOCKET_MEDIA_RE = /^wss?:\/\//i;

// ─── CMS Detection Patterns ───────────────────────────────────────────────

const CMS_PATTERNS = [
  { pattern: /jwp(?:layer)?\.com|jwplatform\.com/i, name: "jwplayer" },
  { pattern: /videojs\.com|video-js\.min\.js/i, name: "videojs" },
  { pattern: /shaka-player|shaka\.compiled/i, name: "shaka" },
  { pattern: /flowplayer\.org|flowplayer\.min\.js/i, name: "flowplayer" },
  { pattern: /hls\.js|hls\.min\.js/i, name: "hlsjs" },
  { pattern: /dashjs|dash\.all\.min\.js/i, name: "dashjs" },
  { pattern: /bitmovin\.com|bitdash/i, name: "bitmovin" },
  { pattern: /plyr\.io|plyr\.min\.js/i, name: "plyr" },
  { pattern: /clappr\.io|clappr\.min\.js/i, name: "clappr" },
  { pattern: /theoplayer|theo\.player/i, name: "theoplayer" },
  { pattern: /cdn\.amazonaws\.com\/IVS|ivs\.rocks/i, name: "aws-ivs" },
  { pattern: /cloudflare\.com\/stream|videodelivery\.net/i, name: "cloudflare-stream" },
];

// ─── URL Classification ───────────────────────────────────────────────────

/**
 * Classify a URL to determine its type, format, and CMS origin.
 *
 * @param {string} url - The URL to classify.
 * @returns {{type: string, format: string, cms: string|null}}
 */
function classifyUrl(url) {
  if (!url || typeof url !== "string") {
    return { type: "unknown", format: "", cms: null };
  }

  // Format extraction
  let format = "";
  const extMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  if (extMatch) format = extMatch[1].toLowerCase();

  // CMS detection
  let cms = null;
  for (const cp of CMS_PATTERNS) {
    if (cp.pattern.test(url)) {
      cms = cp.name;
      break;
    }
  }

  // Type classification
  let type = "unknown";
  if (WEBSOCKET_MEDIA_RE.test(url)) {
    type = "websocket";
  } else if (MANIFEST_URL_RE.test(url)) {
    type = "manifest";
  } else if (SEGMENT_URL_RE.test(url)) {
    type = "segment";
  } else if (DIRECT_MEDIA_RE.test(url)) {
    type = "direct";
  } else if (url.startsWith("blob:")) {
    type = "blob";
  } else if (url.startsWith("data:")) {
    type = "data";
  } else {
    type = "page";
  }

  return { type, format, cms };
}

export {
  MEDIA_CONTENT_TYPE_RE,
  SEGMENT_URL_RE,
  MANIFEST_URL_RE,
  DIRECT_MEDIA_RE,
  SIGNED_URL_RE,
  TRANSFER_MODE_RE,
  WEBSOCKET_MEDIA_RE,
  CMS_PATTERNS,
  hasMediaContentType,
  classifyUrl,
};
