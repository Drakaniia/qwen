"use strict";

import * as tabState from "./tab_state.js";
import * as downloadFallbacks from "./download_fallbacks.js";
import * as downloadState from "./download_state.js";
import * as videoUtils from "./video_utils.js";
import * as headerUtils from "./header_utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const BLOCKING_DOWNLOAD_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

// ── Formatting helpers ────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
const HOST_NAME = "com.qwin.video_downloader";

// ── Download ports (shared mutable state) ────────────────────────────────

const downloadPortsById = {};

function getDownloadPortsById() {
  return downloadPortsById;
}

// ── Download update helper ───────────────────────────────────────────────

function updateDownload(jobId, patch, notifyPopupFn) {
  tabState.updateDownload(jobId, patch);
  const job = tabState.getDownload(jobId);
  if (notifyPopupFn) {
    notifyPopupFn({ type: "downloadUpdated", job });
  }
}

// ── Segmented download detection ─────────────────────────────────────────

function isSegmentedDownloadJob(job) {
  const format = String(job?.format || "").toUpperCase();
  const url = String(job?.url || "");
  return format === "M3U8" || format === "MPD" || videoUtils.HLS_RE.test(url) || videoUtils.DASH_RE.test(url);
}

// ── Download progress helpers ────────────────────────────────────────────

function normalizeDownloadProgress(jobId, percent) {
  const job = tabState.getDownload(jobId) || {};
  return downloadState.visibleDownloadProgressPercent(job.percent, percent, isSegmentedDownloadJob(job));
}

function downloadProgressMessage(percent) {
  return downloadState.downloadProgressMessage(percent);
}

function cleanProgressText(value) {
  return downloadState.cleanProgressText(value);
}

function resetDownloadProgressDetails() {
  return downloadState.resetDownloadProgressDetails();
}

function progressDetailPatchFromMessage(message) {
  return downloadState.progressDetailPatchFromMessage(message);
}

// ── Artifact helpers ─────────────────────────────────────────────────────

function artifactPatchFromMessage(message) {
  const patch = {
    filepath: message.filepath,
    artifactRoot: message.artifactRoot,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value));
}

function cleanupPatchFromMessage(message) {
  const patch = {
    artifactCleanupDeleted: Array.isArray(message.artifactCleanupDeleted) ? message.artifactCleanupDeleted : undefined,
    artifactCleanupMissing: Array.isArray(message.artifactCleanupMissing) ? message.artifactCleanupMissing : undefined,
    artifactCleanupError: cleanProgressText(message.artifactCleanupError),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== ""));
}

function clearedArtifactPatch(cleanupPatch) {
  return Array.isArray(cleanupPatch.artifactCleanupDeleted) && cleanupPatch.artifactCleanupDeleted.length
    ? { filepath: "", artifactRoot: "", artifactPaths: [] }
    : {};
}

function hasDownloadArtifacts(job) {
  return Boolean(job?.filepath || job?.artifactRoot || (Array.isArray(job?.artifactPaths) && job.artifactPaths.length));
}

async function cleanupDownloadArtifacts(jobId, job, nativeRequestFn) {
  if (!hasDownloadArtifacts(job)) {
    return {};
  }

  const requestId = `delete_${jobId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const response = await nativeRequestFn(
      {
        type: "deleteArtifacts",
        id: requestId,
        path: job.filepath || "",
        artifactRoot: job.artifactRoot || "",
        artifactPaths: job.artifactPaths || [],
        downloadFolder: job.downloadFolder || tabState.getSettings().downloadFolder || "",
      },
      30000,
    );
    return {
      artifactCleanupDeleted: response.deleted || [],
      artifactCleanupMissing: response.missing || [],
    };
  } catch (error) {
    return {
      artifactCleanupError: cleanProgressText(error && error.message ? error.message : String(error)),
    };
  }
}

// ── Fallback helpers ─────────────────────────────────────────────────────

function isHardAccessError(error) {
  return downloadFallbacks.isHardAccessError(error);
}

function isRetryableSourceError(error) {
  return downloadFallbacks.isRetryableSourceError(error);
}

function exhaustedSourcesError(error, attemptedUrls) {
  return downloadFallbacks.exhaustedSourcesError(error, attemptedUrls);
}

function userFriendlyDownloadError(error) {
  return downloadFallbacks.userFriendlyDownloadError(error);
}

// ── Fallback wrappers (accept deps to avoid closure coupling) ────────────

/**
 * Mark a video URL as unavailable. Accepts optional getVisibleVideosFn and
 * notifyPopupFn for notifying the popup of the change.
 */
async function markVideoUrlUnavailable(tabId, url, error, getVisibleVideosFn, notifyPopupFn) {
  const targetUrl = headerUtils.normalizeUrl(url);
  const changed = await tabState.patchVideo(
    tabId,
    (item) => headerUtils.normalizeUrl(item.url || "") === targetUrl && item.downloadable !== false,
    {
      downloadable: false,
      blockedReason: String(error || "The server refused this source.").slice(0, 500),
      lastSeen: Date.now(),
    },
  );
  if (changed && notifyPopupFn) {
    notifyPopupFn({ type: "videoListUpdated", tabId, videos: getVisibleVideosFn(tabId) });
  }
  return changed;
}

function downloadableVariants(video, attemptedUrls, fallbackDeps) {
  return downloadFallbacks.downloadableVariants(video, attemptedUrls || new Set(), fallbackDeps);
}

function isExtractorPageVideo(video) {
  return downloadFallbacks.isExtractorPageVideo(video);
}

function pageFallbackVideoForSource(video, attemptedUrls, fallbackDeps) {
  return downloadFallbacks.pageFallbackVideoForSource(video, attemptedUrls || new Set(), fallbackDeps);
}

function resolveMediaCandidatesForSource(tabId, sourceVideo, attemptedUrls, fallbackDeps) {
  return downloadFallbacks.resolveMediaCandidatesForSource(tabId, sourceVideo, attemptedUrls || new Set(), fallbackDeps);
}

function fallbackVideoForDownload(tabId, failedVideo, attemptedUrls, fallbackDeps) {
  return downloadFallbacks.fallbackVideoForDownload(tabId, failedVideo, attemptedUrls || new Set(), fallbackDeps);
}

// ── Variant helpers ──────────────────────────────────────────────────────

function variantsForVideo(video) {
  return Array.isArray(video.variants) && video.variants.length ? video.variants : [video];
}

function preferredNativeVideo(video) {
  const variants = variantsForVideo(video);
  return (
    variants.find((variant) => ["M3U8", "MPD"].includes(String(variant.format || "").toUpperCase())) ||
    variants[0] ||
    video
  );
}

function findGroupedVideoForAnyVariant(tabId, video, getVisibleVideosFn) {
  const ids = new Set();
  if (video && video.id) {
    ids.add(video.id);
  }
  if (video && video.groupId) {
    ids.add(video.groupId);
  }
  for (const variant of variantsForVideo(video)) {
    if (variant && variant.id) {
      ids.add(variant.id);
    }
  }

  return getVisibleVideosFn(tabId).find((item) => {
    if (ids.has(item.id)) {
      return true;
    }
    return variantsForVideo(item).some((variant) => ids.has(variant.id));
  });
}

function findGroupedVideoForVariant(tabId, variant, getVisibleVideosFn) {
  return getVisibleVideosFn(tabId).find((video) => variantsForVideo(video).some((item) => item.id === variant.id));
}

function findVariant(video, variantId) {
  if (!variantId) {
    return preferredNativeVideo(video);
  }
  return variantsForVideo(video).find((variant) => variant.id === variantId) || null;
}

// ── Fallback deps building ──────────────────────────────────────────────

function buildDownloadFallbackDeps(nativeRequestFn, addDetectedVideoFn, getVisibleVideosFn, headersFn) {
  return {
    addDetectedVideo: addDetectedVideoFn,
    detectFormat: videoUtils.detectFormat,
    findGroupedVideoForAnyVariant: (tabId, video) => findGroupedVideoForAnyVariant(tabId, video, getVisibleVideosFn),
    getVisibleVideosForTab: getVisibleVideosFn,
    hashId: videoUtils.hashId,
    isDownloadableUrl: videoUtils.isDownloadableUrl,
    nativeRequest: nativeRequestFn,
    nativeRequestHeadersForVideo: headersFn || headerUtils.nativeRequestHeadersForVideo,
    normalizeUrl: headerUtils.normalizeUrl,
    titleFromUrl: videoUtils.titleFromUrl,
    userAgent: navigator.userAgent || "",
    variantsForVideo,
  };
}

export {
  BLOCKING_DOWNLOAD_STATUSES,
  HOST_NAME,

  downloadPortsById,
  formatBytes,
  getDownloadPortsById,

  updateDownload,
  isSegmentedDownloadJob,

  normalizeDownloadProgress,
  downloadProgressMessage,
  cleanProgressText,
  resetDownloadProgressDetails,
  progressDetailPatchFromMessage,

  artifactPatchFromMessage,
  cleanupPatchFromMessage,
  clearedArtifactPatch,
  hasDownloadArtifacts,
  cleanupDownloadArtifacts,

  isHardAccessError,
  isRetryableSourceError,
  exhaustedSourcesError,
  userFriendlyDownloadError,

  markVideoUrlUnavailable,
  downloadableVariants,
  isExtractorPageVideo,
  pageFallbackVideoForSource,
  resolveMediaCandidatesForSource,
  fallbackVideoForDownload,

  variantsForVideo,
  preferredNativeVideo,
  findGroupedVideoForAnyVariant,
  findGroupedVideoForVariant,
  findVariant,

  buildDownloadFallbackDeps,
};
