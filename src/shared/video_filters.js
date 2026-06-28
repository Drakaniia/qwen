"use strict";

import * as mediaCandidates from "./media_candidates.js";

// ── Re-exports from sub-modules (backward compatibility) ────────────────

export {
  normalizeComparableUrl,
  normalizeIdentityText,
  normalizeTitleKey,
  normalizeVideoStem,
  normalizePageKey,
  isGenericStem,
  isGenericTitle,
  videoIdentityParts,
  isSameFullVideo,
  inferResolutionFromText,
  inferBitrateFromText,
  enrichVideoVariant,
  QUALITY_WORD_RE,
  FORMAT_WORD_RE,
  RESOLUTION_RE,
  DIMENSION_RE,
  MBPS_RE,
  KBPS_RE,
  GENERIC_WORDS,
  GENERIC_STEM_RE,
  GENERIC_TITLE_RE,
} from "./video_identity.js";

export {
  formatPriority,
  fullVideoPriority,
  variantSortKey,
  compareVariants,
  mergeVariant,
  groupedVideoSortKey,
  compareGroupedVideos,
  buildGroupedVideo,
  groupUniqueFullVideos,
} from "./video_sorting.js";

// ── Regex constants ─────────────────────────────────────────────────────

const SHORT_OR_PREVIEW_RE =
  /(?:^|[/?#._\s-])(?:shorts?|clips?|previews?|teasers?|trailers?|highlights?|snippets?|promos?|thumbs?|thumbnails?|stories|reels|loop-preview)(?:[/?#._\s-]|$)/i;
const INCOMPLETE_RE =
  /(?:^|[/?#._\s-])(?:partial|incomplete|fragment|fragments|segment|segments|chunk|chunks|part|parts)(?:[/?#._\s-]|\d|$)/i;

// ── Video player SDK patterns (from uBO unbreak lists, Phase A.5) ──

// Google IMA SDK paths — video ad framework needed for playback.
const VIDEO_PLAYER_SDK_RE = /\/js\/sdkloader\/(?:ima3|ima3_dai|ima3_debug)\.js/i;

// Video-specific analytics (not generic tracking).
const VIDEO_ANALYTICS_RE = /(?:comscore\.streaming|mux\.js|mux\.min\.js)/i;

// Video player frameworks.
const VIDEO_FRAMEWORK_RE = /(?:akamaihtml5|ooyala|jwplayer|brightcove|kaltura|shaka)/i;

// ── Constants ───────────────────────────────────────────────────────────

const MIN_FULL_LENGTH_SECONDS = 30;
const MIN_DIRECT_MEDIA_BYTES = 2048;
const MIN_HEADER_VIDEO_BYTES = 1024 * 1024; // 1MB for direct video from headers/network

// ── Basic utilities ─────────────────────────────────────────────────────

function lower(value) {
  return String(value || "").toLowerCase();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function textForVideoSignals(details) {
  if (!details || typeof details !== "object") {
    return String(details || "");
  }
  return [details.url, details.title, details.label, details.note, details.source, details.contentType]
    .filter(Boolean)
    .join(" ");
}

function hasShortOrIncompleteSignal(details) {
  const text = textForVideoSignals(details);
  return SHORT_OR_PREVIEW_RE.test(text) || INCOMPLETE_RE.test(text);
}

// ── Classification wrappers ─────────────────────────────────────────────

function isPlaylistLike(details) {
  return mediaCandidates.isPlaylistLike(details);
}

function isBlockedVideoUrl(url, contentType = "") {
  return mediaCandidates.isBlockedMediaUrl(url, contentType);
}

function classifyVideoUrl(url, contentType = "") {
  return mediaCandidates.classifyMediaUrl(url, contentType);
}

function isYouTubeVideoPageUrl(url) {
  return mediaCandidates.isYouTubeVideoPageUrl(url);
}

function normalizeYouTubeVideoPageUrl(url) {
  return mediaCandidates.normalizeYouTubeVideoPageUrl(url);
}

function isDownloadableUrl(url, contentType = "") {
  return mediaCandidates.isDownloadableMediaUrl(url, contentType);
}

function isLikelyVideoRequest(url, resourceType = "", contentType = "") {
  return mediaCandidates.isLikelyVideoRequest(url, resourceType, contentType);
}

// ── Display helpers ─────────────────────────────────────────────────────

function displayVideoFormat(videoOrFormat) {
  const format = lower(
    typeof videoOrFormat === "object" && videoOrFormat !== null ? videoOrFormat.format || "" : videoOrFormat,
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

function humanSize(numBytes) {
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

function numericVideoSize(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (isPlaylistLike(value)) {
    return 0;
  }
  return (
    finiteNumber(value.sizeBytes) ||
    finiteNumber(value.filesize) ||
    finiteNumber(value.filesize_approx) ||
    finiteNumber(value.fileSize) ||
    0
  );
}

function displayVideoSize(videoOrFormat) {
  if (!videoOrFormat || typeof videoOrFormat !== "object") {
    return "";
  }

  if (typeof videoOrFormat.size === "string" && videoOrFormat.size.trim()) {
    return videoOrFormat.size.trim();
  }

  const directSize = numericVideoSize(videoOrFormat);
  if (directSize > 0) {
    return humanSize(directSize);
  }

  const variants = Array.isArray(videoOrFormat.variants) ? videoOrFormat.variants : [];
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

function isLikelyFullLengthVideoCandidate(details) {
  if (!details || typeof details !== "object") {
    return false;
  }

  if (!isDownloadableUrl(details.url || "", details.contentType || "")) {
    return false;
  }

  if (details.downloadable === false) {
    return false;
  }

  if (details.source === "manual-url") {
    return true;
  }

  const youtubePage = isYouTubeVideoPageUrl(details.url || "");
  const isDomSource =
    details.source === "dom-video" ||
    details.source === "dom-source" ||
    details.source === "page-fallback" ||
    details.source === "youtube-page" ||
    (typeof details.source === "string" && details.source.startsWith("cdp-"));

  if (!youtubePage && !isDomSource && hasShortOrIncompleteSignal(details)) {
    return false;
  }

  const duration = finiteNumber(details.duration);
  if (!youtubePage && duration > 0 && duration < MIN_FULL_LENGTH_SECONDS) {
    return false;
  }

  if (details.source === "performance" && duration === 0) {
    return false;
  }

  const directSize = numericVideoSize(details);
  if (directSize > 0 && directSize < MIN_DIRECT_MEDIA_BYTES) {
    return false;
  }

  const isPlaylist = isPlaylistLike(details);
  if (!isPlaylist && (details.source === "headers" || details.source === "network")) {
    if (directSize > 0 && directSize < MIN_HEADER_VIDEO_BYTES) {
      return false;
    }
  }

  if (details.complete === false || details.partial === true) {
    return false;
  }

  return true;
}

function isLikelyRealVideoBox(details) {
  const width = Number(details.width || 0);
  const height = Number(details.height || 0);
  const duration = Number(details.duration || 0);

  if ((width && width < 160) || (height && height < 90) || width * height < 14400) {
    return false;
  }
  if (Number.isFinite(duration) && duration > 0 && duration < 1.5) {
    return false;
  }
  if (Number.isFinite(duration) && duration > 0 && duration < 5 && details.loop && details.muted && details.autoplay) {
    return false;
  }
  return true;
}

function isLikelyRealVideoElement(details) {
  if (!isLikelyFullLengthVideoCandidate(details)) {
    return false;
  }
  return isLikelyRealVideoBox(details);
}

function isVideoPlayerSdkUrl(url) {
  if (!url) {
    return false;
  }
  return VIDEO_PLAYER_SDK_RE.test(url) || VIDEO_ANALYTICS_RE.test(url) || VIDEO_FRAMEWORK_RE.test(url);
}

function sourceLabel(video) {
  if (video && video.source === "manual-url") {
    return "manual link";
  }
  if (video && video.source === "music-page") {
    return "music";
  }
  if (["M3U8", "MPD", "YOUTUBE", "PAGE"].includes(String((video && video.format) || "").toUpperCase())) {
    return "full video";
  }
  return (video && video.source) || "detected";
}

export {
  // Regex constants
  SHORT_OR_PREVIEW_RE,
  INCOMPLETE_RE,
  VIDEO_PLAYER_SDK_RE,
  VIDEO_ANALYTICS_RE,
  VIDEO_FRAMEWORK_RE,

  // Basic utilities
  lower,
  finiteNumber,
  textForVideoSignals,
  hasShortOrIncompleteSignal,

  // Classification
  isPlaylistLike,
  isBlockedVideoUrl,
  classifyVideoUrl,
  isYouTubeVideoPageUrl,
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

  // SDK detection
  isVideoPlayerSdkUrl,

  // Source label
  sourceLabel,
};
