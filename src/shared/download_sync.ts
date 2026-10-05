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
 *
 * The in-memory list is the whole store: the background loads it from `storage.sync`
 * at startup and persists it back, so nothing here touches chrome APIs itself.
 */

import type { DownloadJob, SyncedDownloadEntry } from "./contracts.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SYNCED_ENTRIES = 200;
const SYNCABLE_STATUSES: ReadonlySet<string> = new Set(["done", "error", "canceled"]);

// ─── State ───────────────────────────────────────────────────────────────────

let syncedHistory: SyncedDownloadEntry[] = [];

let syncEnabled = true;

let lastSyncTimestamp: number | null = null;

/** Nothing here is concurrent — the flag exists because the state snapshot reports it. */
const isSyncing = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the hostname from a URL string.
 */
function extractHostname(url: string): string {
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
 */
function isSyncableStatus(status: string | undefined): boolean {
  return SYNCABLE_STATUSES.has(status || "");
}

/**
 * Create a compact synced entry from a download job.
 * Only includes fields needed for history display.
 *
 * Returns null for a job that is not in a final state or has no id.
 */
function createSyncedEntry(job: DownloadJob): SyncedDownloadEntry | null {
  if (!job || !job.id || !isSyncableStatus(job.status)) {
    return null;
  }

  return {
    id: job.id,
    url: job.url || "",
    title: job.title || "Unknown",
    format: job.format || "",
    status: job.status || "",
    filepath: job.filepath || "",
    totalSize: job.totalSize || "",
    // `pageUrl` first, not `url`: the media URL is a CDN host per video, so the Source facet
    // on `downloads.html` used to list `googlevideo.com` instead of the site the user was
    // actually on. `ui/filter.ts`'s `sourceHostOf` uses the same precedence.
    sourceHost: extractHostname(job.pageUrl || job.url || ""),
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
 * @returns Whether the entry was added to sync history
 */
function addSyncedDownload(job: DownloadJob): boolean {
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
 */
function getSyncedHistory(): SyncedDownloadEntry[] {
  return [...syncedHistory];
}

/**
 * Clear all synced download history.
 */
function clearSyncedHistory(): void {
  syncedHistory = [];
  lastSyncTimestamp = null;
}

/** Counts and flags for the Downloads page's "history is off" line. */
interface SyncInfo {
  totalCount: number;
  lastSyncTimestamp: number | null;
  isSyncing: boolean;
  syncEnabled: boolean;
}

/**
 * Get information about the current sync state.
 */
function getSyncInfo(): SyncInfo {
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
 * @param json — JSON string of synced download entries
 */
function loadSyncHistory(json: string): void {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      syncedHistory = parsed
        .filter(
          (entry): entry is SyncedDownloadEntry =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as SyncedDownloadEntry).id === "string" &&
            typeof (entry as SyncedDownloadEntry).url === "string" &&
            typeof (entry as SyncedDownloadEntry).status === "string",
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
 */
function persistSyncHistory(): string {
  return JSON.stringify(syncedHistory);
}

/**
 * Check whether sync is currently enabled.
 */
function isSyncEnabled(): boolean {
  return syncEnabled;
}

/**
 * Enable or disable download history sync.
 *
 * @param enabled
 */
function setSyncEnabled(enabled: boolean): void {
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
  persistSyncHistory,
  setSyncEnabled,
};

export type { SyncInfo };
