/**
 * The candidate filter every layer shares: is this detection a full-length video the
 * user would want, and how should it be labelled.
 *
 * Two hardcoded regex constants used to decide "short/preview or incomplete?" through
 * an if/else. They are now {@link FILTER_RULES} plus one generic matcher
 * (spec D4) — appending a signal word is one array entry.
 *
 * Note what is *not* here: the format/URL classification. That belongs to
 * `media_candidates.ts` and its rule tables, and the wrappers below are a naming
 * layer over it (`isBlockedVideoUrl` → `isBlockedMediaUrl`), so there is one
 * classifier rather than two that can disagree.
 */

import * as mediaCandidates from "./media_candidates.js";
import { byPriority, finiteNumber, lower } from "./media_patterns.js";
import type { MediaCandidateLike } from "./media_rules.js";

// ── Re-exports from sub-modules ────────────────────────────────────────

export { isGenericTitle } from "./video_identity.js";

export { groupUniqueFullVideos } from "./video_sorting.js";

export type { MediaCandidateLike } from "./media_rules.js";

// ── Signal rules (spec D4) ─────────────────────────────────────────────

/**
 * One "this is probably not a full-length video" signal.
 *
 * Deliberately not `media_rules.ts`'s `MediaRule`: this matcher sees one
 * pre-joined string (URL + title + label + note + source + Content-Type) and has no
 * Content-Type or resource-type input, so it needs neither `typePattern` nor a
 * guard. The category vocabulary is D4's; only `blocked` is populated today.
 */
export interface FilterRule {
  /** Diagnostic label — which signal word class matched. */
  readonly id: string;
  readonly pattern: RegExp;
  readonly category: "video" | "playlist" | "blocked";
  /** Lower runs first; array order is the match order. */
  readonly priority: number;
}

/**
 * The only regexes this module owned, as data.
 *
 * These two patterns are the whole "short/preview or incomplete" heuristic, in the
 * order the old `hasShortOrIncompleteSignal` tested them. Both reject a candidate,
 * so both are `blocked`; DOM-derived candidates are exempt from the whole check
 * (`isLikelyFullLengthVideoCandidate`), which is why these words only bite on
 * network/SSR detections.
 */

export const FILTER_RULES: FilterRule[] = byPriority([
  {
    id: "short-or-preview",
    pattern:
      /(?:^|[/?#._\s-])(?:shorts?|clips?|previews?|teasers?|trailers?|highlights?|snippets?|promos?|thumbs?|thumbnails?|stories|reels|loop-preview)(?:[/?#._\s-]|$)/i,
    category: "blocked",
    priority: 10,
  },
  {
    id: "incomplete",
    pattern:
      /(?:^|[/?#._\s-])(?:partial|incomplete|fragment|fragments|segment|segments|chunk|chunks|part|parts)(?:[/?#._\s-]|\d|$)/i,
    category: "blocked",
    priority: 20,
  },
]);

/** The first signal rule matching `text`, or `undefined`. The generic matcher for {@link FILTER_RULES}. */
export function findFilterRule(text: string): FilterRule | undefined {
  return FILTER_RULES.find((rule) => rule.pattern.test(text));
}

// ── Constants ───────────────────────────────────────────────────────────

const MIN_FULL_LENGTH_SECONDS = 30;
const MIN_DIRECT_MEDIA_BYTES = 2048;
const MIN_HEADER_VIDEO_BYTES = 1024 * 1024; // 1MB for direct video from headers/network

/** Formats that mean "the manifest/page stands in for the whole video". */
const FULL_VIDEO_FORMATS = ["M3U8", "MPD", "YOUTUBE", "PAGE"];

// ── Basic utilities ─────────────────────────────────────────────────────

/** Every text-ish field of a candidate, joined — what the signal rules are matched against. */
function textForVideoSignals(details: unknown): string {
  if (!details || typeof details !== "object") {
    return String(details || "");
  }
  const candidate = details as MediaCandidateLike;
  return [candidate.url, candidate.title, candidate.label, candidate.note, candidate.source, candidate.contentType]
    .filter(Boolean)
    .join(" ");
}

function hasShortOrIncompleteSignal(details: unknown): boolean {
  return Boolean(findFilterRule(textForVideoSignals(details)));
}

// ── Classification wrappers ─────────────────────────────────────────────

function isPlaylistLike(details: unknown): boolean {
  return mediaCandidates.isPlaylistLike(details);
}

function isBlockedVideoUrl(url: string, contentType = ""): boolean {
  return mediaCandidates.isBlockedMediaUrl(url, contentType);
}

/**
 * The format label for a URL — `M3U8`, `MPD`, `MP4`, `WEBM`, `AUDIO`, `BLOB`,
 * `YOUTUBE`, `ISM`, or `VIDEO`. A thin name over `media_candidates.classifyMediaUrl`,
 * whose rule table is the data-driven form of the classification chain: adding a
 * format is appending a rule there, not editing this.
 */
function classifyVideoUrl(url: string, contentType = ""): string {
  return mediaCandidates.classifyMediaUrl(url, contentType);
}

function isYouTubeVideoPageUrl(url: string): boolean {
  return mediaCandidates.isYouTubeVideoPageUrl(url);
}

function normalizeYouTubeVideoPageUrl(url: string): string {
  return mediaCandidates.normalizeYouTubeVideoPageUrl(url);
}

function isDownloadableUrl(url: string, contentType = ""): boolean {
  return mediaCandidates.isDownloadableMediaUrl(url, contentType);
}

function isLikelyVideoRequest(url: string, resourceType = "", contentType = ""): boolean {
  return mediaCandidates.isLikelyVideoRequest(url, resourceType, contentType);
}

// ── Display helpers ─────────────────────────────────────────────────────

/** Format badge text. Accepts a candidate or a bare format string. */
function displayVideoFormat(videoOrFormat: unknown): string {
  const format = lower(
    typeof videoOrFormat === "object" && videoOrFormat !== null
      ? (videoOrFormat as MediaCandidateLike).format || ""
      : videoOrFormat,
  );
  if (format === "audio") {
    return "AUDIO";
  }
  if (format === "m3u8" || format === "mpd" || format === "ism") {
    return "MP4";
  }
  if (format === "youtube") {
    return "MP4";
  }
  if (format === "page") {
    return "MP4";
  }
  return format ? format.toUpperCase() : "VIDEO";
}

/** Byte count as `2.0 KB`. Empty for anything under 1 byte — "unknown", not "0 B". */
function humanSize(numBytes: unknown): string {
  const size = finiteNumber(numBytes);
  if (size <= 0) {
    return "";
  }

  let value = size;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024 || unit === "GB") {
      return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return "";
}

/**
 * The largest byte count a candidate reports, or 0.
 *
 * Playlist-shaped candidates report 0 even when a size is present: the size belongs
 * to the manifest, not to a file, and showing it would imply a single download.
 */
function numericVideoSize(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (isPlaylistLike(value)) {
    return 0;
  }
  const candidate = value as MediaCandidateLike;
  return (
    finiteNumber(candidate.sizeBytes) ||
    finiteNumber(candidate.filesize) ||
    finiteNumber(candidate.filesize_approx) ||
    finiteNumber(candidate.fileSize) ||
    0
  );
}

/**
 * Size label for a candidate: its own `size` string, else its byte count, else the
 * largest among its variants, else the first variant's string.
 */
function displayVideoSize(videoOrFormat: unknown): string {
  if (!videoOrFormat || typeof videoOrFormat !== "object") {
    return "";
  }
  const candidate = videoOrFormat as MediaCandidateLike;

  if (typeof candidate.size === "string" && candidate.size.trim()) {
    return candidate.size.trim();
  }

  const directSize = numericVideoSize(candidate);
  if (directSize > 0) {
    return humanSize(directSize);
  }

  const variants = Array.isArray(candidate.variants) ? candidate.variants : [];
  let largestSize = 0;
  let fallbackLabel = "";
  for (const variant of variants) {
    largestSize = Math.max(largestSize, numericVideoSize(variant));
    if (!fallbackLabel && variant && typeof variant.size === "string" && variant.size.trim()) {
      fallbackLabel = variant.size.trim();
    }
  }
  return largestSize > 0 ? humanSize(largestSize) : fallbackLabel;
}

// ── Candidate filtering ────────────────────────────────────────────────

/**
 * Whether a detection is worth offering as a download: a full-length video, not a
 * clip, trailer, segment or placeholder.
 *
 * The order of the checks is the contract — a trusted source (`manual-url`,
 * `ssr-json:*`) returns early, DOM sources are exempt from the word filter but not
 * from the duration floor, and the size floors are relaxed for playlist candidates.
 */
function isLikelyFullLengthVideoCandidate(details: unknown): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }
  const candidate = details as MediaCandidateLike;

  if (!isDownloadableUrl(candidate.url || "", candidate.contentType || "")) {
    return false;
  }

  if (candidate.downloadable === false) {
    return false;
  }

  if (candidate.source === "manual-url") {
    return true;
  }

  // SSR-detected URLs are trusted candidates — they come from manifest
  // configs in server-rendered JSON, not from DOM video elements.
  if (typeof candidate.source === "string" && candidate.source.startsWith("ssr-json:")) {
    return true;
  }

  const youtubePage = isYouTubeVideoPageUrl(candidate.url || "");
  const isDomSource =
    candidate.source === "dom-video" ||
    candidate.source === "dom-source" ||
    candidate.source === "page-fallback" ||
    candidate.source === "youtube-page";

  if (!youtubePage && !isDomSource && hasShortOrIncompleteSignal(candidate)) {
    return false;
  }

  const duration = finiteNumber(candidate.duration);
  if (!youtubePage && duration > 0 && duration < MIN_FULL_LENGTH_SECONDS) {
    return false;
  }

  if (candidate.source === "performance" && duration === 0) {
    return false;
  }

  const directSize = numericVideoSize(candidate);
  if (directSize > 0 && directSize < MIN_DIRECT_MEDIA_BYTES) {
    return false;
  }

  const isPlaylist = isPlaylistLike(candidate);
  if (!isPlaylist && (candidate.source === "headers" || candidate.source === "network")) {
    if (directSize > 0 && directSize < MIN_HEADER_VIDEO_BYTES) {
      return false;
    }
  }

  if (candidate.complete === false || candidate.partial === true) {
    return false;
  }

  return true;
}

/**
 * Whether a `<video>` element's metrics are those of real video rather than a
 * tracking pixel, a banner loop, or a decorative box.
 */
function isLikelyRealVideoBox(details: unknown): boolean {
  const candidate = details as MediaCandidateLike;
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  const duration = Number(candidate.duration || 0);

  if ((width && width < 160) || (height && height < 90) || width * height < 14400) {
    return false;
  }
  if (Number.isFinite(duration) && duration > 0 && duration < 1.5) {
    return false;
  }
  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    duration < 5 &&
    candidate.loop &&
    candidate.muted &&
    candidate.autoplay
  ) {
    return false;
  }
  return true;
}

/** Both halves: a real box *and* a candidate worth downloading. */
function isLikelyRealVideoElement(details: unknown): boolean {
  if (!isLikelyFullLengthVideoCandidate(details)) {
    return false;
  }
  return isLikelyRealVideoBox(details);
}

/** Where a candidate came from, in words. */
function sourceLabel(video: unknown): string {
  const candidate = (video || {}) as MediaCandidateLike;
  if (candidate.source === "manual-url") {
    return "manual link";
  }
  if (candidate.source === "music-page") {
    return "music";
  }
  if (FULL_VIDEO_FORMATS.includes(String(candidate.format || "").toUpperCase())) {
    return "full video";
  }
  return candidate.source || "detected";
}

export {
  // Basic utilities
  lower,
  finiteNumber,
  textForVideoSignals,

  // Classification
  isBlockedVideoUrl,
  classifyVideoUrl,
  normalizeYouTubeVideoPageUrl,
  isDownloadableUrl,
  isLikelyVideoRequest,

  // Display
  displayVideoFormat,
  humanSize,
  numericVideoSize,
  displayVideoSize,

  // Candidate filtering
  isLikelyFullLengthVideoCandidate,
  isLikelyRealVideoBox,
  isLikelyRealVideoElement,

  // Source label
  sourceLabel,
};
