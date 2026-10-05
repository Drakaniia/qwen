/**
 * Media URL classification — the gate every layer asks before treating a URL as
 * downloadable video (content script DOM sweep, service worker header capture,
 * popup rendering, and the native host's own copy).
 *
 * Spec D4 turned this file's if/else chains into data: the regexes moved to
 * `media_patterns.ts`, the rule tables to `media_rules.ts`, and one generic matcher
 * now answers for all of them. What is left here is the set of questions callers ask
 * and the case convention each question was asked under — the part that is easy to
 * get wrong when a chain is moved into data.
 *
 * This module stays the only import target: the lexicon and the rules are re-exported
 * from here, so nothing outside `shared/` knows the split exists.
 */

import { lower, PLAYLIST_LIKE_FORMATS, youtubeVideoIdFromPageUrl, type MediaCandidateLike } from "./media_patterns.js";
import {
  AUDIO_URL_RULES,
  findMediaRule,
  MEDIA_BLOCK_RULES,
  MEDIA_CLASSIFY_RULES,
  PLAYLIST_LIKE_RULES,
  resolveMediaRuleId,
  VIDEO_REQUEST_RULES,
  type MediaContext,
} from "./media_rules.js";

// `VIDEO_EXTENSION_RE`, `HLS_RE`, `DASH_RE`, `CDN_HINT_RE` and
// `DIRECT_VIDEO_EXTENSION_RE` are re-exported for `background/video_utils.ts`, which
// used to re-derive the patterns it needed. The rule tables are not re-exported:
// every question they answer is asked through a function in this module, so a caller
// wanting `MEDIA_BLOCK_RULES` was reaching past the API on purpose.
export {
  CDN_HINT_RE,
  DASH_RE,
  DIRECT_VIDEO_EXTENSION_RE,
  HLS_RE,
  PLAYLIST_LIKE_FORMATS,
  VIDEO_EXTENSION_RE,
  type MediaCandidateLike,
} from "./media_patterns.js";

export { findMediaRule, type MediaContext, type MediaRule } from "./media_rules.js";

/**
 * Build the matcher context. `text` is lowercased for every question except
 * `isBlockedMediaUrl`, whose patterns were always tested against the raw URL —
 * every one of them carries `/i`, so the two agree, but the call sites keep their
 * own convention rather than inheriting a "normalized" one.
 */
function mediaContext(rawUrl: string, contentType: string, resourceType = "", text?: string): MediaContext {
  return {
    rawUrl,
    text: text === undefined ? lower(rawUrl) : text,
    type: lower(contentType),
    resourceType,
  };
}

/** Only http(s)/blob/ws(s) reach a download backend — anything else is not fetchable by URL. */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "blob:" ||
      parsed.protocol === "ws:" ||
      parsed.protocol === "wss:"
    );
  } catch (_error) {
    return false;
  }
}

/** Whether a URL is audio rather than video, per {@link AUDIO_URL_RULES}. */
export function isLikelyAudioUrl(url: string, contentType = ""): boolean {
  return Boolean(findMediaRule(AUDIO_URL_RULES, mediaContext(url, contentType)));
}

/** True when this is a YouTube *page* URL — a valid yt-dlp source, unlike every other page URL here. */
export function isYouTubeVideoPageUrl(url: string): boolean {
  return Boolean(youtubeVideoIdFromPageUrl(url));
}

/**
 * The canonical watch URL for a YouTube page URL, keeping `/shorts/` and `/live/`
 * because yt-dlp picks a different extractor for them.
 */
export function normalizeYouTubeVideoPageUrl(url: string): string {
  const videoId = youtubeVideoIdFromPageUrl(url);
  if (!videoId) {
    return "";
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith("/shorts/")) {
      return `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;
    }
    if (path.startsWith("/live/")) {
      return `https://www.youtube.com/live/${encodeURIComponent(videoId)}`;
    }
  } catch (_error) {
    // Fall through to the canonical watch URL.
  }

  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * Whether this URL may never be offered as a video — static assets, ad/analytics
 * traffic, HLS segments, and page URLs from hosts that only embed real streams.
 *
 * First match in {@link MEDIA_BLOCK_RULES} wins. An empty URL blocks on its own:
 * there is nothing for a pattern to match, and "unknown" has always meant "no".
 */
export function isBlockedMediaUrl(url: string, contentType = ""): boolean {
  const text = String(url || "");
  if (!text) {
    return true;
  }
  return Boolean(findMediaRule(MEDIA_BLOCK_RULES, mediaContext(text, contentType, "", text)));
}

/**
 * {@link isBlockedMediaUrl} with the filter lists' exception domains applied: an
 * unblocked hostname (or a subdomain of one) survives an otherwise-blocked URL, so
 * a video CDN allow-listed by uBO/EasyList is never filtered out of the list.
 */
export function isBlockedMediaUrlWithExceptions(
  url: string,
  contentType = "",
  exceptionDomains?: ReadonlySet<string> | null,
): boolean {
  // First check if the URL would normally be blocked.
  if (!isBlockedMediaUrl(url, contentType)) {
    return false;
  }

  // If no exception domains provided, the URL is blocked.
  if (!exceptionDomains || typeof exceptionDomains !== "object" || exceptionDomains.size === 0) {
    return true;
  }

  // Extract the hostname from the URL.
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch (_error) {
    return true;
  }

  if (!hostname) {
    return true;
  }

  // Check if the hostname matches any exception domain (exact or subdomain).
  for (const domain of exceptionDomains) {
    const normalized = String(domain || "")
      .toLowerCase()
      .replace(/^\.+/, "");
    if (!normalized) {
      continue;
    }
    if (hostname === normalized || hostname.endsWith("." + normalized)) {
      return false;
    }
  }

  return true;
}

/**
 * The format label for a URL: `M3U8`, `MPD`, `MP4`, `WEBM`, `AUDIO`, `BLOB`,
 * `YOUTUBE`, the subtype of a `video/*` Content-Type, or `VIDEO`.
 *
 * Labels are exactly what {@link MEDIA_CLASSIFY_RULES} carries — the old chain's
 * `return "…"` values, copied verbatim. Callers compare them case-sensitively.
 */
export function classifyMediaUrl(url: string, contentType = ""): string {
  const context = mediaContext(String(url || ""), contentType);
  const rule = findMediaRule(MEDIA_CLASSIFY_RULES, context);
  return rule ? resolveMediaRuleId(rule, context) : "VIDEO";
}

/**
 * Whether a candidate is a playlist/manifest rather than a single file. True when it
 * was classified as one, when the URL says so directly, or when a stream
 * Content-Type says so — the last two catch candidates whose `format` came from
 * somewhere other than {@link classifyMediaUrl}.
 */
export function isPlaylistLike(details: unknown): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }
  const candidate = details as MediaCandidateLike;
  const url = candidate.url || "";
  const contentType = candidate.contentType || "";
  const format = String(candidate.format || classifyMediaUrl(url, contentType)).toUpperCase();
  if (PLAYLIST_LIKE_FORMATS.has(format)) {
    return true;
  }
  return Boolean(findMediaRule(PLAYLIST_LIKE_RULES, mediaContext(url, contentType, "", String(url))));
}

/** Fetchable and not blocked — the two conditions a download target must pass. */
export function isDownloadableMediaUrl(url: string, contentType = ""): boolean {
  return isHttpUrl(url) && !isBlockedMediaUrl(url, contentType);
}

/**
 * Whether a `webRequest` observation is worth looking at. Blocked URLs are out; then
 * a video extension, a media Content-Type, or a media resource type on a known CDN.
 */
export function isLikelyVideoRequest(url: string, resourceType = "", contentType = ""): boolean {
  if (isBlockedMediaUrl(url, contentType)) {
    return false;
  }
  const context = mediaContext(String(url || ""), contentType, resourceType, String(url || ""));
  return Boolean(findMediaRule(VIDEO_REQUEST_RULES, context));
}
