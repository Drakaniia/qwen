"use strict";

/**
 * Batch Orchestration Module
 *
 * Coordinates batch/playlist downloads between the background service worker,
 * the native host, and the popup UI. Manages the lifecycle of enumerating
 * playlist items, creating batch queues, and driving sequential downloads.
 */

import * as BatchState from "../shared/batch_state.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BatchOrchestrationDeps
 * @property {Function} nativeRequest - Native messaging request wrapper
 * @property {Function} startNativeDownload - Start a single video download
 * @property {Function} startNativeDownloadForUrl - Start download from a URL
 * @property {Function} addDetectedVideo - Add a detected video to the tab state
 * @property {Function} notifyPopup - Send a message to the popup
 * @property {Function} normalizeUrl - Normalize a URL for comparison
 * @property {Function} getTabVideos - Get visible videos for a tab
 * @property {Function} updateDownload - Update a download job state
 * @property {Function} nativeRequestHeadersForVideo - Get request headers for a video
 * @property {string} userAgent - Browser user agent string
 */

// ─── Module state ───────────────────────────────────────────────────────────

/** @type {BatchOrchestrationDeps|null} */
let deps = null;

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize the batch orchestration module with dependencies.
 *
 * @param {BatchOrchestrationDeps} dependencies
 */
function init(dependencies) {
  deps = dependencies;
}

// ─── Playlist enumeration ───────────────────────────────────────────────────

/**
 * Enumerate items in a playlist URL via the native host.
 *
 * @param {string} url - Playlist URL to enumerate
 * @param {Object} [options]
 * @param {string} [options.pageUrl] - Page URL context
 * @returns {Promise<{ok: boolean, items: Array, playlistTitle: string, totalItems: number, error?: string}>}
 */
async function enumeratePlaylist(url, options = {}) {
  if (!deps) {
    return { ok: false, items: [], playlistTitle: "", totalItems: 0, error: "Batch orchestration not initialized." };
  }

  const requestId = `enumerate_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const pageUrl = options.pageUrl || url;

  try {
    const response = await deps.nativeRequest(
      {
        type: "enumeratePlaylist",
        id: requestId,
        url,
        pageUrl,
        userAgent: deps.userAgent,
        requestHeaders: await deps.nativeRequestHeadersForVideo(url, pageUrl),
      },
      120000, // 2 minute timeout for playlist enumeration
    );

    if (response && response.ok !== false && Array.isArray(response.items)) {
      return {
        ok: true,
        items: response.items,
        playlistTitle: response.playlistTitle || "",
        totalItems: response.totalItems || response.items.length,
      };
    }

    return {
      ok: false,
      items: [],
      playlistTitle: "",
      totalItems: 0,
      error: (response && response.error) || "Failed to enumerate playlist items.",
    };
  } catch (error) {
    return {
      ok: false,
      items: [],
      playlistTitle: "",
      totalItems: 0,
      error: error.message || String(error),
    };
  }
}

// ─── Batch download from list of videos ─────────────────────────────────────

/**
 * Start downloading a batch of videos sequentially.
 * Each video is downloaded one at a time; the queue advances
 * automatically on completion or error.
 *
 * @param {number} tabId - Active tab ID
 * @param {Array<Object>} videos - Array of video candidate objects
 *   Each item must have at least { id, url }.
 * @returns {Object} - { ok, batchInfo }
 */
async function startBatchDownload(tabId, videos) {
  if (!deps || !videos || !videos.length) {
    return { ok: false, error: "No videos provided for batch download." };
  }

  // Create the batch state
  BatchState.createBatch(videos);
  BatchState.startBatch();

  // Notify the popup about the new batch
  deps.notifyPopup({
    type: "batchUpdated",
    batchInfo: BatchState.getBatchInfo(),
  });

  // Start processing the queue in the background
  processBatchQueue(tabId).catch(() => {
    // Errors during batch processing are handled internally
    // via markItemError / cancelBatch
  });

  return { ok: true, batchInfo: BatchState.getBatchInfo() };
}

// ─── Batch queue processor ──────────────────────────────────────────────────

/**
 * Process the batch queue sequentially. Downloads one item at a time,
 * advancing through the queue on completion.
 *
 * @param {number} tabId - Active tab ID
 */
async function processBatchQueue(tabId) {
  if (!deps) {
    return;
  }

  while (BatchState.isBatchActive() && BatchState.getBatchInfo().currentItem) {
    const info = BatchState.getBatchInfo();
    const item = info.currentItem;

    if (!item) {
      break;
    }

    // Check if we should pause or cancel
    if (info.status === "paused") {
      await waitForResume();
      if (BatchState.getBatchInfo().status !== "running") {
        break;
      }
      continue;
    }

    if (info.status === "canceled") {
      break;
    }

    // Download the current item
    try {
      await downloadBatchItem(tabId, item);
      BatchState.markItemComplete(item.id);
    } catch (error) {
      BatchState.markItemError(item.id, error.message || String(error));
      // Skip the failed item and continue
      BatchState.skipItem(item.id);
    }

    // Notify popup of progress update
    deps.notifyPopup({
      type: "batchUpdated",
      batchInfo: BatchState.getBatchInfo(),
    });
  }

  // Batch is complete or canceled — notify popup
  const finalInfo = BatchState.getBatchInfo();
  deps.notifyPopup({
    type: "batchUpdated",
    batchInfo: finalInfo,
  });

  if (finalInfo.status === "completed" && finalInfo.failedItems.length > 0) {
    deps.notifyPopup({
      type: "batchComplete",
      batchInfo: finalInfo,
      message: `Downloaded ${finalInfo.completedItems} of ${finalInfo.totalItems} items. ${finalInfo.failedItems.length} failed.`,
    });
  } else if (finalInfo.status === "completed") {
    deps.notifyPopup({
      type: "batchComplete",
      batchInfo: finalInfo,
      message: `All ${finalInfo.totalItems} items downloaded successfully.`,
    });
  }
}

/**
 * Wait for a paused batch to be resumed or canceled.
 *
 * @returns {Promise<boolean>} - True if resumed, false if canceled
 */
async function waitForResume() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const info = BatchState.getBatchInfo();
      if (info.status === "running") {
        clearInterval(checkInterval);
        resolve(true);
      } else if (info.status === "canceled") {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 200);
  });
}

/**
 * Download a single item from the batch queue.
 *
 * @param {number} tabId - Active tab ID
 * @param {Object} item - Video item to download
 * @returns {Promise<Object>} - Download result
 */
async function downloadBatchItem(tabId, item) {
  if (!deps) {
    throw new Error("Batch orchestration not initialized.");
  }

  // Add the video to tab state so it appears in the download list and
  // is visible to the user during sequential batch processing.
  const detected = await deps.addDetectedVideo(
    tabId,
    {
      url: item.url,
      title: item.title || "Batch item",
      format: item.format || "",
      source: "batch",
      pageUrl: item.pageUrl || "",
      downloadable: true,
    },
    false,
  );

  if (!detected || !detected.id) {
    throw new Error(`Could not register batch item for download: ${item.url || item.title || "unknown"}`);
  }

  // Use the detected video's ID to start the download directly,
  // bypassing startNativeDownloadForUrl (which calls addDetectedVideo again).
  // This avoids a duplicate detection call and preserves the "batch" source label.
  return deps.startNativeDownload(
    tabId,
    detected.id,
    item.formatId || "best",
    "",
    "auto",
  );
}

// ─── Batch control ──────────────────────────────────────────────────────────

/**
 * Pause the current batch download.
 */
function pauseBatch() {
  BatchState.pauseBatch();
  if (deps) {
    deps.notifyPopup({
      type: "batchUpdated",
      batchInfo: BatchState.getBatchInfo(),
    });
  }
}

/**
 * Resume a paused batch download.
 */
function resumeBatch() {
  BatchState.resumeBatch();
  if (deps) {
    deps.notifyPopup({
      type: "batchUpdated",
      batchInfo: BatchState.getBatchInfo(),
    });
  }
}

/**
 * Cancel the current batch download.
 */
function cancelBatch() {
  BatchState.cancelBatch();
  if (deps) {
    deps.notifyPopup({
      type: "batchUpdated",
      batchInfo: BatchState.getBatchInfo(),
    });
  }
}

/**
 * Get the current batch info.
 *
 * @returns {Object}
 */
function getBatchInfo() {
  return BatchState.getBatchInfo();
}

/**
 * Check if a batch is currently active.
 *
 * @returns {boolean}
 */
function isBatchActive() {
  return BatchState.isBatchActive();
}

// ─── Multi-select batch helpers ─────────────────────────────────────────────

/**
 * Create a batch from selected video IDs.
 *
 * @param {number} tabId - Active tab ID
 * @param {Array<string>} videoIds - Array of video IDs to include
 * @returns {Promise<Object>} - { ok, batchInfo, error? }
 */
async function startSelectedDownload(tabId, videoIds) {
  if (!deps) {
    return { ok: false, error: "Batch orchestration not initialized." };
  }

  const videos = await deps.getTabVideos(tabId);
  const selected = videos.filter((v) => videoIds.includes(v.id));

  if (selected.length === 0) {
    return { ok: false, error: "No valid videos selected." };
  }

  // Build the batch items from selected videos
  const items = selected.map((video) => ({
    id: video.id,
    url: video.url,
    title: video.title || "Video",
    format: video.format || "",
    pageUrl: video.pageUrl || "",
    source: video.source || "selected",
    sizeBytes: video.sizeBytes || 0,
  }));

  return startBatchDownload(tabId, items);
}

// ─── Exports ────────────────────────────────────────────────────────────────

export {
  init,
  enumeratePlaylist,
  startBatchDownload,
  startSelectedDownload,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  getBatchInfo,
  isBatchActive,
};
