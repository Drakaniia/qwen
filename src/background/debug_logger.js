"use strict";

/**
 * Debug logger module — buffers debug log entries from the extension and
 * periodically flushes them to disk via the native host.
 *
 * This module is initialized by background.js with a bound nativeRequest
 * function. It receives log entries (typically downloadDebugLog messages)
 * and batches them for efficient file-based logging.
 *
 * The log buffer auto-flushes when:
 *   1. The buffer reaches LOG_BUFFER_MAX entries (immediate)
 *   2. FLUSH_INTERVAL_MS has passed since the last entry
 *
 * File output goes to <native-host>/../logs/debug.log (project root in dev,
 * or next to the native host in production).
 */

const LOG_BUFFER_MAX = 50;
const FLUSH_INTERVAL_MS = 10000;

let logBuffer = [];
let flushTimer = null;
let nativeRequestFn = null;

/**
 * Initialize the debug logger with a nativeRequest wrapper.
 * @param {Function} requestFn - async fn(payload) that sends a native messaging request
 */
function init(requestFn) {
  nativeRequestFn = requestFn;
}

/**
 * Queue a debug log entry for file output.
 * @param {Object} entry - { level, message, details }
 */
function log(entry) {
  if (!nativeRequestFn) {
    return; // Silent fail if not initialized
  }

  logBuffer.push({
    timestamp: Date.now(),
    level: String(entry.level || "info"),
    message: String(entry.message || "").substring(0, 500),
    details: String(entry.details || "").substring(0, 2000),
  });

  if (logBuffer.length >= LOG_BUFFER_MAX) {
    scheduleFlush(0);
  } else if (!flushTimer) {
    scheduleFlush(FLUSH_INTERVAL_MS);
  }
}

function scheduleFlush(delay) {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(doFlush, delay);
}

async function doFlush() {
  flushTimer = null;
  if (logBuffer.length === 0) {
    return;
  }

  const entries = logBuffer.splice(0);
  try {
    await nativeRequestFn({ type: "debugLog", id: `dbg_${Date.now()}`, entries });
  } catch (_err) {
    // Flush failed (e.g. native host not connected, not installed).
    // Re-queue entries so they're not lost — the next successful flush or
    // buffer overflow will retry them.
    entries.unshift.apply(entries, logBuffer);
    logBuffer = entries;
  }
}

export { init, log };
