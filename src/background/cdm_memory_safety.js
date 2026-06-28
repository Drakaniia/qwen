"use strict";

/**
 * CDM Memory Safety Module
 *
 * Rate limiting and memory protection for captured Widevine license exchanges.
 * Extracted from cdm_network_intercept.js.
 */

// ─── Rate Limiting ──────────────────────────────────────────────────────────

/**
 * Rate limiter for getCapturedExchanges() to prevent exfiltration.
 * Limits to RATE_LIMIT_MAX_CALLS calls per RATE_LIMIT_WINDOW_MS window.
 */
const RATE_LIMIT_WINDOW_MS = 30000; // 30 seconds
const RATE_LIMIT_MAX_CALLS = 5; // max 5 calls per window

/** @type {number[]} */
let _callTimestamps = [];

/**
 * Check if the current call is within the rate limit.
 * @returns {boolean} True if the call is allowed
 */
function checkRateLimit() {
  const now = Date.now();
  // Purge expired timestamps outside the window
  _callTimestamps = _callTimestamps.filter(function (t) {
    return now - t < RATE_LIMIT_WINDOW_MS;
  });
  if (_callTimestamps.length >= RATE_LIMIT_MAX_CALLS) {
    return false;
  }
  _callTimestamps.push(now);
  return true;
}

/**
 * Reset the rate limiter (for testing or session end).
 */
function resetRateLimit() {
  _callTimestamps = [];
}

// ─── Memory Protection for Captured License Data ────────────────────────────

/**
 * Maximum age (ms) for a completed exchange before it is auto-pruned.
 * Exchanges older than this are automatically removed from memory to limit
 * the window of exposure for DRM key material.
 */
const EXCHANGE_MAX_AGE_MS = 300000; // 5 minutes

/**
 * Prune completed exchanges that have exceeded the maximum age.
 * Also removes any timed-out pending tracked requests.
 *
 * @param {Map<string, Object>} trackedRequests - Map of tracked requests
 * @param {Array<Object>} completedExchanges - Array of completed exchanges
 */
function pruneStaleExchanges(trackedRequests, completedExchanges) {
  const now = Date.now();

  // Prune completed exchanges
  for (let i = completedExchanges.length - 1; i >= 0; i--) {
    if (now - completedExchanges[i].completedAt > EXCHANGE_MAX_AGE_MS) {
      // Overwrite sensitive data before removing reference
      completedExchanges[i].responseBody = "";
      completedExchanges[i].postData = "";
      completedExchanges.splice(i, 1);
    }
  }

  // Prune stale pending tracked requests (older than 2x the max age)
  for (const [requestId, tracked] of trackedRequests) {
    if (tracked.status === "pending" && now - tracked.capturedAt > EXCHANGE_MAX_AGE_MS * 2) {
      trackedRequests.delete(requestId);
    }
  }
}

/**
 * Overwrite sensitive fields (responseBody, postData) on all stored exchanges
 * with empty strings before removing references. This reduces the window during
 * which key material exists in memory.
 *
 * @param {Array<Object>} completedExchanges - Array of completed exchanges
 * @param {Map<string, Object>} trackedRequests - Map of tracked requests
 */
function wipeSensitiveData(completedExchanges, trackedRequests) {
  for (const exchange of completedExchanges) {
    exchange.responseBody = "";
    exchange.postData = "";
  }
  for (const tracked of trackedRequests.values()) {
    tracked.responseBody = "";
    tracked.postData = "";
  }
}

export {
  checkRateLimit,
  resetRateLimit,
  EXCHANGE_MAX_AGE_MS,
  pruneStaleExchanges,
  wipeSensitiveData,
};
