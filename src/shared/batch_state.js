"use strict";

/**
 * Batch Download State Module
 *
 * Manages the state of a batch/playlist download queue.
 * Supports: queue creation, sequential progress tracking,
 * error handling, pause/resume/cancel, and progress callbacks.
 */

// ─── State ──────────────────────────────────────────────────────────────────

const MAX_BATCH_SIZE = 100;

let batchState = {
  items: [], // Array of { id, url, title, format, ... }
  currentIndex: -1,
  completedItems: [],
  failedItems: [], // Array of { id, error }
  status: "idle", // "idle" | "running" | "paused" | "completed" | "canceled"
  totalItems: 0,
};

/** @type {Set<function>} */
const progressCallbacks = new Set();

function notifyProgress() {
  const info = deriveBatchInfo();
  for (const cb of progressCallbacks) {
    try {
      cb(info);
    } catch (_error) {
      // Silently ignore subscriber errors
    }
  }
}

function deriveBatchInfo() {
  const total = batchState.items.length;
  const completed = batchState.completedItems.length;
  const failed = batchState.failedItems.length;
  const currentItem =
    batchState.currentIndex >= 0 && batchState.currentIndex < total ? batchState.items[batchState.currentIndex] : null;
  const processed = completed + failed;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const label = currentItem ? `${batchState.currentIndex + 1}/${total}` : `${completed}/${total}`;

  return {
    totalItems: total,
    completedItems: completed,
    failedItems: [...batchState.failedItems],
    currentIndex: total > 0 && processed >= total ? -1 : batchState.currentIndex,
    currentItem: total > 0 && processed >= total ? null : currentItem,
    percent,
    label,
    status: batchState.status,
    isActive: batchState.items.length > 0 && batchState.status !== "completed" && batchState.status !== "canceled",
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new batch from a list of video items.
 * Resets any existing batch state.
 *
 * @param {Array<Object>} items - Array of video candidate objects
 *   Each item must have at least { id, url }.
 */
function createBatch(items) {
  const normalizedItems = Array.isArray(items) ? [...items] : [];
  if (normalizedItems.length > MAX_BATCH_SIZE) {
    normalizedItems.length = MAX_BATCH_SIZE;
  }
  batchState = {
    items: normalizedItems,
    currentIndex: normalizedItems.length > 0 ? 0 : -1,
    completedItems: [],
    failedItems: [],
    status: "idle",
    totalItems: normalizedItems.length,
  };
  notifyProgress();
}

/**
 * Start processing the batch.
 */
function startBatch() {
  if (batchState.items.length === 0) {
    return;
  }
  batchState.status = "running";
  notifyProgress();
}

/**
 * Pause the batch download.
 */
function pauseBatch() {
  if (batchState.status !== "running") {
    return;
  }
  batchState.status = "paused";
  notifyProgress();
}

/**
 * Resume a paused batch.
 */
function resumeBatch() {
  if (batchState.status !== "paused") {
    return;
  }
  batchState.status = "running";
  notifyProgress();
}

/**
 * Cancel the batch download entirely.
 */
function cancelBatch() {
  if (batchState.status === "completed" || batchState.status === "idle") {
    return;
  }
  batchState.status = "canceled";
  batchState.completedItems = [];
  notifyProgress();
}

/**
 * Reset the batch state completely.
 */
function resetBatch() {
  batchState = {
    items: [],
    currentIndex: -1,
    completedItems: [],
    failedItems: [],
    status: "idle",
    totalItems: 0,
  };
  notifyProgress();
}

/**
 * Mark the current item as completed and advance to the next.
 * If all items are done, sets status to "completed".
 *
 * @param {string} itemId - The ID of the completed item
 */
function markItemComplete(itemId) {
  if (batchState.items.length === 0) {
    return;
  }

  const item = batchState.items[batchState.currentIndex];
  if (item && item.id === itemId) {
    batchState.completedItems.push(itemId);
    advanceToNext();
  }
  notifyProgress();
}

/**
 * Mark the current item as failed with an error message.
 * The batch continues to run (doesn't advance automatically).
 *
 * @param {string} itemId - The ID of the failed item
 * @param {string} error - Error description
 */
function markItemError(itemId, error) {
  if (batchState.items.length === 0) {
    return;
  }

  const item = batchState.items[batchState.currentIndex];
  if (item && item.id === itemId) {
    batchState.failedItems.push({ id: itemId, error: String(error || "Unknown error") });
    // Don't advance — caller should call skipItem() or retry
  }
  notifyProgress();
}

/**
 * Skip the current item (after a failure) and advance.
 *
 * @param {string} itemId - The ID of the item to skip
 */
function skipItem(itemId) {
  if (batchState.items.length === 0) {
    return;
  }

  const item = batchState.items[batchState.currentIndex];
  if (item && item.id === itemId) {
    advanceToNext();
  }
  notifyProgress();
}

/**
 * Advance the current index by one.
 * If the batch is done, sets status to "completed".
 */
function advanceToNext() {
  const total = batchState.items.length;
  const processed = batchState.completedItems.length + batchState.failedItems.length;

  if (processed >= total) {
    batchState.currentIndex = -1;
    batchState.status = "completed";
  } else {
    // Find the next unprocessed item
    const processedIds = new Set([...batchState.completedItems, ...batchState.failedItems.map((f) => f.id)]);
    let nextIndex = batchState.currentIndex + 1;
    while (nextIndex < total && processedIds.has(batchState.items[nextIndex].id)) {
      nextIndex++;
    }
    batchState.currentIndex = nextIndex < total ? nextIndex : -1;
    if (batchState.currentIndex === -1) {
      batchState.status = "completed";
    }
  }
}

/**
 * Check if a batch is currently active (running or paused).
 *
 * @returns {boolean}
 */
function isBatchActive() {
  return batchState.items.length > 0 && batchState.status !== "completed" && batchState.status !== "canceled";
}

/**
 * Get the overall batch progress as a percentage (0–100).
 *
 * @returns {number}
 */
function getBatchProgress() {
  const total = batchState.items.length;
  if (total === 0) {
    return 0;
  }
  if (batchState.status === "canceled") {
    return 0;
  }
  return Math.round((batchState.completedItems.length / total) * 100);
}

/**
 * Get the full batch info object for UI rendering.
 *
 * @returns {Object} - { totalItems, completedItems, failedItems, currentIndex,
 *                       currentItem, percent, label, status, isActive }
 */
function getBatchInfo() {
  return deriveBatchInfo();
}

/**
 * Get the list of item IDs in the batch queue.
 *
 * @returns {string[]}
 */
function getItemIds() {
  return batchState.items.map((item) => item.id);
}

/**
 * Subscribe to batch progress updates.
 *
 * @param {function} callback - Called with batch info object on each state change
 * @returns {function} - Unsubscribe function
 */
function onProgress(callback) {
  progressCallbacks.add(callback);
  return function unsubscribe() {
    progressCallbacks.delete(callback);
  };
}

export {
  createBatch,
  startBatch,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  resetBatch,
  markItemComplete,
  markItemError,
  skipItem,
  isBatchActive,
  getBatchProgress,
  getBatchInfo,
  getItemIds,
  onProgress,
};
