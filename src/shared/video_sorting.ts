/**
 * Grouping and ordering for the candidate list.
 *
 * `groupUniqueFullVideos` is what the popup renders: candidates that are the same
 * video collapse into one row with a variant list, ordered so the version the user
 * most likely wants (downloadable, full-length, largest, highest) comes first.
 */

import type { MediaCandidateLike } from "./media_rules.js";
import {
  enrichVideoVariant,
  isSameFullVideo,
  normalizeComparableUrl,
  type EnrichedVideoVariant,
} from "./video_identity.js";
import { finiteNumber, humanSize, isLikelyFullLengthVideoCandidate, numericVideoSize } from "./video_filters.js";

/** A candidate with its inferred fields filled in — one row's variant. */
type VideoVariant = EnrichedVideoVariant<MediaCandidateLike>;

/** One video's worth of detections, before the representative is chosen. */
export interface VideoGroup {
  id: string;
  seed: VideoVariant;
  variants: MediaCandidateLike[];
}

/** A grouped row: the representative's fields plus the variant list behind it. */
export interface GroupedVideo extends VideoVariant {
  variants: VideoVariant[];
  variantCount: number;
}

/** Formats that are worth more than a direct file: a manifest or page stands in for the whole video. */
const FULL_VIDEO_FORMATS = new Set(["M3U8", "MPD", "ISM"]);

/**
 * The ordered thumbnail ladder (thumbnail-spec.md §3) is read and written through
 * this widening: it rides on `contracts.ts:DetectedVideo`, not on
 * `MediaCandidateLike`, which is the structural subset `media_patterns.ts` declares
 * and has no such key.
 */
type CandidateLadder = { thumbnailCandidates?: string[] };

/** A variant's ladder, or `[]` — `undefined` is the common case for a network candidate. */
function ladderOf(video: MediaCandidateLike | undefined | null): string[] {
  return (video as (MediaCandidateLike & CandidateLadder) | undefined | null)?.thumbnailCandidates || [];
}

// ── Format priority ────────────────────────────────────────────────────

/** Higher is better. Tiers, not a total order — anything unlisted is 1. */
function formatPriority(format: unknown): number {
  const value = String(format || "").toUpperCase();
  if (value === "YOUTUBE") {
    return 10;
  }
  if (FULL_VIDEO_FORMATS.has(value)) {
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

/** The best format priority on this video or any of its variants; 0 when none qualifies. */
function fullVideoPriority(video: MediaCandidateLike | null | undefined): number {
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

/**
 * The sort key for a video, most significant first.
 *
 * `withDuration` adds the duration term, which only matters between whole videos
 * (two variants of one video cannot disagree about how long it is).
 *
 * The size term drops to 0 for a sub-1MB non-stream file: those are artifacts
 * (thumbnails, sprites, trackers) that sniff a video Content-Type, and letting
 * their real size promote them would put them above the actual video.
 */
function videoSortKey(video: MediaCandidateLike, withDuration = false): number[] {
  const size = numericVideoSize(video);
  const isStreamFormat = FULL_VIDEO_FORMATS.has(String(video.format || "").toUpperCase());
  const isArtifactSmall = !isStreamFormat && size > 0 && size < 1024 * 1024;
  const key = [
    video.downloadable ? 1 : 0,
    fullVideoPriority(video),
    isArtifactSmall ? 0 : size,
    finiteNumber(video.height),
    finiteNumber(video.tbr || video.bitrate),
    formatPriority(video.format),
  ];
  if (withDuration) {
    key.push(finiteNumber(video.duration));
  }
  key.push(finiteNumber(video.lastSeen));
  return key;
}

/** Descending: bigger key first. */
function compareVariants(left: MediaCandidateLike, right: MediaCandidateLike): number {
  const leftKey = videoSortKey(left, false);
  const rightKey = videoSortKey(right, false);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return rightKey[index] - leftKey[index];
    }
  }
  return 0;
}

/** Fold a re-detection into the variant it repeats, keeping the richest field from each side. */
function mergeVariant(existing: MediaCandidateLike, next: MediaCandidateLike): MediaCandidateLike {
  const nextLadder = ladderOf(next);
  const merged: MediaCandidateLike & CandidateLadder = {
    ...existing,
    ...next,
    thumbnailUrl: next.thumbnailUrl || existing.thumbnailUrl || "",
    // The `...next` spread already carried a ladder when there was one; this is the
    // same `thumbnailUrl` fallback applied to it, so a re-detection that lost its
    // ladder cannot erase the one an earlier detection supplied (spec §1.5).
    thumbnailCandidates: nextLadder.length ? nextLadder : ladderOf(existing),
    firstSeen: existing.firstSeen || next.firstSeen,
    lastSeen: Math.max(finiteNumber(existing.lastSeen), finiteNumber(next.lastSeen)),
  };
  return merged;
}

// ── Grouped video sorting ──────────────────────────────────────────────

/** {@link videoSortKey} with duration, which only matters between whole videos. */
function groupedVideoSortKey(video: MediaCandidateLike): number[] {
  return videoSortKey(video, true);
}

function compareGroupedVideos(left: MediaCandidateLike, right: MediaCandidateLike): number {
  const leftKey = groupedVideoSortKey(left);
  const rightKey = groupedVideoSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return rightKey[index] - leftKey[index];
    }
  }
  return 0;
}

/**
 * Collapse one group into the row the UI shows: the best variant's fields, the full
 * variant list, and aggregate size/recency across every variant (the representative
 * alone is often the least informative — a 1KB `.m3u8` next to a 2GB `.mp4`).
 */
function buildGroupedVideo(group: VideoGroup): GroupedVideo {
  const variants = group.variants.map(enrichVideoVariant).sort(compareVariants);
  const representative = variants[0] || group.seed;
  const firstSeenValues = variants.map((variant) => finiteNumber(variant.firstSeen)).filter(Boolean);
  const lastSeenValues = variants.map((variant) => finiteNumber(variant.lastSeen));
  const largestSizeBytes = Math.max(...variants.map(numericVideoSize), 0);
  const thumbnailVariant = variants.find((variant) => variant.thumbnailUrl);
  const representativeLadder = ladderOf(representative);
  const grouped: GroupedVideo & CandidateLadder = {
    ...representative,
    id: group.id,
    variants,
    variantCount: variants.length,
    downloadable: variants.some((variant) => variant.downloadable),
    size: representative.size || (largestSizeBytes > 0 ? humanSize(largestSizeBytes) : ""),
    sizeBytes: numericVideoSize(representative) || largestSizeBytes || null,
    thumbnailUrl: representative.thumbnailUrl || thumbnailVariant?.thumbnailUrl || "",
    // Same representative-then-variant recovery as the line above: the best variant
    // is chosen on size and format, not on whether it brought art with it.
    thumbnailCandidates: representativeLadder.length ? representativeLadder : ladderOf(thumbnailVariant),
    firstSeen: firstSeenValues.length ? Math.min(...firstSeenValues) : representative.firstSeen || 0,
    lastSeen: lastSeenValues.length ? Math.max(...lastSeenValues) : representative.lastSeen || 0,
  };
  return grouped;
}

/** Every candidate worth offering, grouped by video and ordered best-first. */
function groupUniqueFullVideos(videos: unknown): GroupedVideo[] {
  const groups: VideoGroup[] = [];

  for (const rawVideo of Array.isArray(videos) ? videos : []) {
    if (!isLikelyFullLengthVideoCandidate(rawVideo)) {
      continue;
    }

    const video = enrichVideoVariant(rawVideo as MediaCandidateLike);
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
  videoSortKey,
  compareVariants,
  mergeVariant,
  groupedVideoSortKey,
  compareGroupedVideos,
  buildGroupedVideo,
  groupUniqueFullVideos,
};
