"use strict";

import { finiteNumber, numericVideoSize, humanSize, isLikelyFullLengthVideoCandidate } from "./video_filters.js";

import { normalizeComparableUrl, isSameFullVideo, enrichVideoVariant } from "./video_identity.js";

// ── Format priority ────────────────────────────────────────────────────

function formatPriority(format) {
  const value = String(format || "").toUpperCase();
  if (value === "YOUTUBE") {
    return 10;
  }
  if (value === "M3U8" || value === "MPD" || value === "ISM") {
    return 8;
  }
  if (value === "PAGE") {
    return 6;
  }
  if (value === "MP4" || value === "WEBM") {
    return 4;
  }
  if (value === "AUDIO") {
    return 3;
  }
  return 1;
}

function fullVideoPriority(video) {
  if (!video) {
    return 0;
  }
  const format = String(video.format || "").toUpperCase();
  const priority = formatPriority(format);
  if (priority >= 6) {
    return priority;
  }

  const variants = Array.isArray(video.variants) ? video.variants : [];
  let best = 0;
  for (const variant of variants) {
    best = Math.max(best, formatPriority(variant.format));
  }
  return best >= 6 ? best : 0;
}

// ── Variant sorting ────────────────────────────────────────────────────

function variantSortKey(video) {
  const size = numericVideoSize(video);
  const format = String(video.format || "").toUpperCase();
  const isStreamFormat = format === "M3U8" || format === "MPD" || format === "ISM";
  const isArtifactSmall = !isStreamFormat && size > 0 && size < 1024 * 1024;

  return [
    video.downloadable ? 1 : 0,
    fullVideoPriority(video),
    isArtifactSmall ? 0 : size,
    finiteNumber(video.height),
    finiteNumber(video.tbr || video.bitrate),
    formatPriority(video.format),
    finiteNumber(video.lastSeen),
  ];
}

function compareVariants(left, right) {
  const leftKey = variantSortKey(left);
  const rightKey = variantSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return rightKey[index] - leftKey[index];
    }
  }
  return 0;
}

function mergeVariant(existing, next) {
  return {
    ...existing,
    ...next,
    thumbnailUrl: next.thumbnailUrl || existing.thumbnailUrl || "",
    firstSeen: existing.firstSeen || next.firstSeen,
    lastSeen: Math.max(finiteNumber(existing.lastSeen), finiteNumber(next.lastSeen)),
  };
}

// ── Grouped video sorting ──────────────────────────────────────────────

function groupedVideoSortKey(video) {
  const size = numericVideoSize(video);
  const format = String(video.format || "").toUpperCase();
  const isStreamFormat = format === "M3U8" || format === "MPD" || format === "ISM";
  const isArtifactSmall = !isStreamFormat && size > 0 && size < 1024 * 1024;

  return [
    video.downloadable ? 1 : 0,
    fullVideoPriority(video),
    isArtifactSmall ? 0 : size,
    finiteNumber(video.height),
    finiteNumber(video.tbr || video.bitrate),
    formatPriority(video.format),
    finiteNumber(video.duration),
    finiteNumber(video.lastSeen),
  ];
}

function compareGroupedVideos(left, right) {
  const leftKey = groupedVideoSortKey(left);
  const rightKey = groupedVideoSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return rightKey[index] - leftKey[index];
    }
  }
  return 0;
}

function buildGroupedVideo(group) {
  const variants = group.variants.map(enrichVideoVariant).sort(compareVariants);
  const representative = variants[0] || group.seed;
  const firstSeenValues = variants.map((variant) => finiteNumber(variant.firstSeen)).filter(Boolean);
  const lastSeenValues = variants.map((variant) => finiteNumber(variant.lastSeen));
  const largestSizeBytes = Math.max(...variants.map(numericVideoSize), 0);
  const thumbnailVariant = variants.find((variant) => variant.thumbnailUrl);
  return {
    ...representative,
    id: group.id,
    variants,
    variantCount: variants.length,
    downloadable: variants.some((variant) => variant.downloadable),
    size: representative.size || (largestSizeBytes > 0 ? humanSize(largestSizeBytes) : ""),
    sizeBytes: numericVideoSize(representative) || largestSizeBytes || null,
    thumbnailUrl: representative.thumbnailUrl || thumbnailVariant?.thumbnailUrl || "",
    firstSeen: firstSeenValues.length ? Math.min(...firstSeenValues) : representative.firstSeen || 0,
    lastSeen: lastSeenValues.length ? Math.max(...lastSeenValues) : representative.lastSeen || 0,
  };
}

function groupUniqueFullVideos(videos) {
  const groups = [];

  for (const rawVideo of Array.isArray(videos) ? videos : []) {
    if (!isLikelyFullLengthVideoCandidate(rawVideo)) {
      continue;
    }

    const video = enrichVideoVariant(rawVideo);
    let group = groups.find((item) => item.variants.some((variant) => isSameFullVideo(variant, video)));
    if (!group) {
      group = {
        id: video.id || normalizeComparableUrl(video.url || ""),
        seed: video,
        variants: [],
      };
      groups.push(group);
    }

    const existingIndex = group.variants.findIndex(
      (variant) => normalizeComparableUrl(variant.url || "") === normalizeComparableUrl(video.url || ""),
    );
    if (existingIndex >= 0) {
      group.variants[existingIndex] = mergeVariant(group.variants[existingIndex], video);
    } else {
      group.variants.push(video);
    }
  }

  return groups.map(buildGroupedVideo).sort(compareGroupedVideos);
}

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
};
