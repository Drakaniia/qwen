"use strict";

/**
 * Download History Sync Module
 *
 * Syncs completed download history across browser instances using
 * Chrome's storage.sync API (or Firefox's equivalent).
 *
 * Design:
 * - Only final-state downloads (done, error, canceled) are synced
 * - Entries are compact to stay within storage.sync limits (~100KB total)
 * - Max 200 entries, capped by recency (newest kept)
 * - Deduplication by job ID
 * - sourceHost extracted from URL for filtering / display
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "qwinDownloadHistory";
const MAX_SYNCED_ENTRIES = 200;
const SYNCABLE_STATUSES = new Set(["done", "error", "canceled"]);

// Active statuses that should NEVER be synced
const ACTIVE_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {Array<import("./download_sync").SyncedDownloadEntry>} */
let syncedHistory = [];

/** @type {boolean} */
let syncEnabled = true;

/** @type {number|null} */
let lastSyncTimestamp = null;

/** @type {boolean} */
let isSyncing = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the hostname from a URL string.
 * @param {string} url
 * @returns {string}
 */
function extractHostname(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname || "";
  } catch (_error) {
    return "";
  }
}

/**
 * Check if a download status represents a completed/final state.
 * @param {string} status
 * @returns {boolean}
 */
function isSyncableStatus(status) {
  return SYNCABLE_STATUSES.has(status || "");
}

/**
 * Check if a download status represents an in-progress state.
 * @param {string} status
 * @returns {boolean}
 */
function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status || "");
}

/**
 * Create a compact synced entry from a download job.
 * Only includes fields needed for history display.
 *
 * @param {Object} job - The download job object from tab state
 * @returns {import("./download_sync").SyncedDownloadEntry|null}
 */
function createSyncedEntry(job) {
  if (!job || !job.id || !isSyncableStatus(job.status)) {
    return null;
  }

  return {
    id: job.id,
    url: job.url || "",
    title: job.title || "Unknown",
    format: job.format || "",
    status: job.status,
    filepath: job.filepath || "",
    totalSize: job.totalSize || "",
    sourceHost: extractHostname(job.url || ""),
    createdAt: typeof job.createdAt === "number" ? job.createdAt : Date.now(),
    completedAt: typeof job.updatedAt === "number" ? job.updatedAt : Date.now(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Add a completed download to the sync history.
 * Deduplicates by job ID (updates existing entry).
 * Capped to MAX_SYNCED_ENTRIES (newest kept).
 *
 * @param {Object} job - Download job object from tab state
 * @returns {boolean} Whether the entry was added to sync history
 */
function addSyncedDownload(job) {
  if (!syncEnabled) {
    return false;
  }

  const entry = createSyncedEntry(job);
  if (!entry) {
    return false;
  }

  // Deduplicate: replace existing entry with same id
  const existingIndex = syncedHistory.findIndex((e) => e.id === entry.id);
  if (existingIndex >= 0) {
    syncedHistory[existingIndex] = entry;
  } else {
    syncedHistory.push(entry);
  }

  // Sort by completedAt descending (newest first)
  syncedHistory.sort((a, b) => b.completedAt - a.completedAt);

  // Cap to max entries
  if (syncedHistory.length > MAX_SYNCED_ENTRIES) {
    syncedHistory = syncedHistory.slice(0, MAX_SYNCED_ENTRIES);
  }

  lastSyncTimestamp = Date.now();
  return true;
}

/**
 * Get all synced download history entries.
 * Returns a shallow copy sorted newest-first.
 *
 * @returns {Array<import("./download_sync").SyncedDownloadEntry>}
 */
function getSyncedHistory() {
  return [...syncedHistory];
}

/**
 * Clear all synced download history.
 */
function clearSyncedHistory() {
  syncedHistory = [];
  lastSyncTimestamp = null;
}

/**
 * Get information about the current sync state.
 *
 * @returns {{ totalCount: number, lastSyncTimestamp: number|null, isSyncing: boolean, syncEnabled: boolean }}
 */
function getSyncInfo() {
  return {
    totalCount: syncedHistory.length,
    lastSyncTimestamp,
    isSyncing,
    syncEnabled,
  };
}

/**
 * Load synced history from a JSON string (deserialized from storage).
 * Replaces the current in-memory state.
 *
 * @param {string} json - JSON string of synced download entries
 */
function loadSyncHistory(json) {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      syncedHistory = parsed
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            typeof entry.url === "string" &&
            typeof entry.status === "string",
        )
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, MAX_SYNCED_ENTRIES);
    }
  } catch (_error) {
    // Invalid JSON — keep current state
  }
}

/**
 * Serialize the current synced history to a JSON string.
 *
 * @returns {string}
 */
function persistSyncHistory() {
  return JSON.stringify(syncedHistory);
}

/**
 * Merge external synced history (from another browser instance) with local state.
 * External entries with the same ID overwrite local entries.
 * Result is capped to MAX_SYNCED_ENTRIES and sorted by completedAt descending.
 *
 * @param {string} json - JSON string of external synced download entries
 */
function mergeSyncedHistory(json) {
  let externalEntries;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return;
    externalEntries = parsed;
  } catch (_error) {
    return;
  }

  // Build a map of existing entries by ID
  const mergedMap = new Map();
  for (const entry of syncedHistory) {
    if (entry && entry.id) {
      mergedMap.set(entry.id, entry);
    }
  }

  // External entries overwrite local entries with same ID
  for (const entry of externalEntries) {
    if (entry && entry.id && typeof entry.id === "string") {
      mergedMap.set(entry.id, entry);
    }
  }

  syncedHistory = Array.from(mergedMap.values())
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, MAX_SYNCED_ENTRIES);

  lastSyncTimestamp = Date.now();
}

/**
 * Check whether sync is currently enabled.
 *
 * @returns {boolean}
 */
function isSyncEnabled() {
  return syncEnabled;
}

/**
 * Enable or disable download history sync.
 *
 * @param {boolean} enabled
 */
function setSyncEnabled(enabled) {
  syncEnabled = Boolean(enabled);
  if (!syncEnabled) {
    // When disabling, clear the in-memory state so disabled-sync entries
    // are not accidentally persisted on re-enable.
    syncedHistory = [];
    lastSyncTimestamp = null;
  }
}

export {
  addSyncedDownload,
  clearSyncedHistory,
  getSyncedHistory,
  getSyncInfo,
  isSyncEnabled,
  loadSyncHistory,
  mergeSyncedHistory,
  persistSyncHistory,
  setSyncEnabled,
};
