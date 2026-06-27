"use strict";

/**
 * Download Queue Manager
 *
 * Manages concurrent downloads by limiting the number of simultaneously
 * active downloads based on the maxConcurrentDownloads setting.
 * Provides auto-download capability when a new video is detected
 * and autoDownload is enabled.
 *
 * Queue states:
 *   - queued: Waiting for a slot to open
 *   - running: Actively downloading
 *   - paused: Paused by user
 *   - done / error / canceled: Terminal states
 */

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_AUTO_DOWNLOAD = false;
const ACTIVE_STATUSES = new Set(["queued", "connecting", "running", "pausing", "canceling"]);

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Map<string, Object>} */
let queue = new Map();

/** @type {number} */
let maxConcurrent = DEFAULT_MAX_CONCURRENT;

/** @type {boolean} */
let autoDownload = DEFAULT_AUTO_DOWNLOAD;

/** @type {Function|null} */
let startDownloadFn = null;

/** @type {Function|null} */
let onQueueChangeFn = null;

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the queue manager with dependencies.
 *
 * @param {Object} deps
 * @param {Function} deps.startDownload - Called with (tabId, videoId, formatId, variantId, backend)
 * @param {Function} [deps.onQueueChange] - Called when queue state changes
 * @param {number} [deps.maxConcurrent] - Max concurrent downloads
 * @param {boolean} [deps.autoDownload] - Auto-download detected videos
 */
function init(deps) {
  startDownloadFn = deps.startDownload;
  onQueueChangeFn = deps.onQueueChange || null;
  if (typeof deps.maxConcurrent === "number" && deps.maxConcurrent >= 1) {
    maxConcurrent = deps.maxConcurrent;
  }
  if (typeof deps.autoDownload === "boolean") {
    autoDownload = deps.autoDownload;
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Get the current max concurrent downloads setting.
 * @returns {number}
 */
function getMaxConcurrent() {
  return maxConcurrent;
}

/**
 * Set the max concurrent downloads limit.
 * After changing, processes the queue to fill any new slots.
 *
 * @param {number} limit - Between 1 and 10
 */
function setMaxConcurrent(limit) {
  const num = Number(limit);
  const clamped = Math.max(1, Math.min(10, Number.isFinite(num) ? num : DEFAULT_MAX_CONCURRENT));
  maxConcurrent = clamped;
  processQueue();
  notifyChange();
}

/**
 * Get whether auto-download is enabled.
 * @returns {boolean}
 */
function getAutoDownload() {
  return autoDownload;
}

/**
 * Enable or disable auto-download.
 * When enabled, newly detected videos are automatically queued for download.
 *
 * @param {boolean} enabled
 */
function setAutoDownload(enabled) {
  autoDownload = Boolean(enabled);
  notifyChange();
}

// ─── Queue management ──────────────────────────────────────────────────────

/**
 * Add a download to the queue.
 * If autoDownload is enabled and a slot is available, starts immediately.
 * Otherwise, adds to the pending queue.
 *
 * @param {number} tabId - Tab ID
 * @param {string} videoId - Video ID
 * @param {Object} [options]
 * @param {string} [options.formatId] - Format ID
 * @param {string} [options.variantId] - Variant ID
 * @param {string} [options.backend] - Backend name
 * @returns {string} The job ID
 */
function enqueue(tabId, videoId, options = {}) {
  const jobId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  queue.set(jobId, {
    id: jobId,
    tabId,
    videoId,
    formatId: options.formatId || "best",
    variantId: options.variantId || "",
    backend: options.backend || "auto",
    status: "queued",
    enqueuedAt: Date.now(),
    startedAt: null,
  });

  notifyChange();
  processQueue();
  return jobId;
}

/**
 * Mark a job as completed (removed from active count).
 *
 * @param {string} jobId
 */
function markComplete(jobId) {
  const job = queue.get(jobId);
  if (!job) return;

  job.status = "done";
  notifyChange();
  processQueue(); // Start next queued job if slots available
}

/**
 * Mark a job as failed.
 *
 * @param {string} jobId
 * @param {string} [error]
 */
function markFailed(jobId, error) {
  const job = queue.get(jobId);
  if (!job) return;

  job.status = "error";
  job.error = error || "";
  notifyChange();
  processQueue();
}

/**
 * Remove a job from the queue.
 *
 * @param {string} jobId
 */
function remove(jobId) {
  queue.delete(jobId);
  notifyChange();
}

/**
 * Clear all completed/failed jobs from the queue.
 */
function clearCompleted() {
  for (const [jobId, job] of queue) {
    if (job.status === "done" || job.status === "error" || job.status === "canceled") {
      queue.delete(jobId);
    }
  }
  notifyChange();
}

/**
 * Get the number of currently active (running) downloads.
 * @returns {number}
 */
function getActiveCount() {
  let count = 0;
  for (const job of queue.values()) {
    if (job.status === "running" || job.status === "connecting") {
      count++;
    }
  }
  return count;
}

/**
 * Get the number of queued (waiting) downloads.
 * @returns {number}
 */
function getQueuedCount() {
  let count = 0;
  for (const job of queue.values()) {
    if (job.status === "queued") {
      count++;
    }
  }
  return count;
}

/**
 * Get all jobs in the queue.
 * @returns {Array<Object>}
 */
function getAllJobs() {
  return Array.from(queue.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/**
 * Get queue status info.
 * @returns {{ activeCount: number, queuedCount: number, maxConcurrent: number, autoDownload: boolean, total: number }}
 */
function getStatus() {
  return {
    activeCount: getActiveCount(),
    queuedCount: getQueuedCount(),
    maxConcurrent,
    autoDownload,
    total: queue.size,
  };
}

// ─── Queue processing ──────────────────────────────────────────────────────

/**
 * Process the queue: start queued jobs up to the concurrent limit.
 */
function processQueue() {
  if (!startDownloadFn) return;

  const activeCount = getActiveCount();
  const availableSlots = Math.max(0, maxConcurrent - activeCount);

  if (availableSlots <= 0) return;

  // Find queued jobs that can be started
  const queuedJobs = [];
  for (const job of queue.values()) {
    if (job.status === "queued") {
      queuedJobs.push(job);
    }
  }

  // Start as many as slots available
  const toStart = queuedJobs.slice(0, availableSlots);
  
  if (toStart.length > 0) {
    notifyChange();
  }
  
  for (const job of toStart) {
    job.status = "connecting";
    job.startedAt = Date.now();

    // Start the download — use deferred processing to avoid
    // recursive processQueue calls when multiple jobs fail
    startDownloadFn(job.tabId, job.videoId, job.formatId, job.variantId, job.backend)
      .then((result) => {
        if (result && result.jobId) {
          job.downloadJobId = result.jobId;
        }
        job.status = "running";
        notifyChange();
      })
      .catch((error) => {
        job.status = "error";
        job.error = error.message || String(error);
        notifyChange();
        // Defer queue processing to avoid stack growth from
        // sequential failures
        setTimeout(() => processQueue(), 0);
      });
  }
}

/**
 * Notify listeners of queue state change.
 */
function notifyChange() {
  if (onQueueChangeFn) {
    try {
      onQueueChangeFn(getStatus());
    } catch (_error) {
      // Silently ignore listener errors
    }
  }
}

// ─── Reset ─────────────────────────────────────────────────────────────────

/**
 * Reset the queue manager (for testing).
 */
function reset() {
  queue.clear();
  maxConcurrent = DEFAULT_MAX_CONCURRENT;
  autoDownload = DEFAULT_AUTO_DOWNLOAD;
  startDownloadFn = null;
  onQueueChangeFn = null;
}

export {
  init,
  getMaxConcurrent,
  setMaxConcurrent,
  getAutoDownload,
  setAutoDownload,
  enqueue,
  markComplete,
  markFailed,
  remove,
  clearCompleted,
  getActiveCount,
  getQueuedCount,
  getAllJobs,
  getStatus,
  processQueue,
  reset,
};
