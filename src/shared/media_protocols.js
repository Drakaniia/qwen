"use strict";

/**
 * Shared Media Protocol Detection Patterns
 *
 * Central repository of Content-Type checks shared across content scripts,
 * background scripts, and native host. This avoids duplicating detection
 * logic across multiple modules.
 *
 * Used by:
 *   - Layer 0 (Detection): content script DOM scanning
 *   - Layer 3 (SW Capture): SW fetch event filtering
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

/** Detect transferMode: "stream" patterns in fetch intercept code. */
const TRANSFER_MODE_RE = /transferMode\s*[:=]\s*['"]stream['"]/i;

export { TRANSFER_MODE_RE, hasMediaContentType };
