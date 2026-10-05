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

/**
 * Check if a Content-Type header value indicates media content.
 *
 * `unknown` rather than `string`: the value comes straight off a response header or a
 * DOM attribute, and the guard below is what has always rejected a missing one.
 */
function hasMediaContentType(contentType: unknown): boolean {
  if (!contentType || typeof contentType !== "string") return false;
  return MEDIA_CONTENT_TYPE_RE.test(contentType.trim());
}

export { hasMediaContentType };
