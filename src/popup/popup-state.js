"use strict";

// Statuses that indicate an active (in-progress) download.
const ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

/**
 * Filter an array of download jobs to only those with active status.
 * @param {Array} downloads
 * @returns {Array}
 */
function activeDownloadJobs(downloads) {
  return (downloads || []).filter((job) => ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued"));
}

/**
 * Check if a response error is the stale-background "Unknown message type" error.
 * @param {Object|null|undefined} response
 * @returns {boolean}
 */
function isUnknownMessageTypeError(response) {
  return /unknown message type/i.test(String(response?.error || ""));
}

export { ACTIVE_DOWNLOAD_STATUSES, activeDownloadJobs, isUnknownMessageTypeError };
