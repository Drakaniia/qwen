import { browserApi } from "../shared/browser_api.js";
import * as videoFilters from "../shared/video_filters.js";
import * as downloadSync from "../shared/download_sync.js";
import { isActiveDownload, TERMINAL_DOWNLOAD_STATUSES } from "../shared/download_statuses.js";
// `ui/motion.ts` is where the popup's width bounds live, so the default a fresh
// install starts at is read from there rather than retyped. Safe in the service
// worker: `motion.ts`'s only import is `import type`, which erases.
import { POPUP_DEFAULT_WIDTH } from "../ui/motion.js";
import type { BackgroundSettings, DownloadJobRecord, TabId, VideoPatch, VideoRecord } from "./types.js";

const STORAGE_VIDEOS = "qwinVideosByTab";
const STORAGE_SETTINGS = "qwinSettings";
const STORAGE_DOWNLOADS = "qwinDownloadsById";

/**
 * Newest terminal jobs kept in `qwinDownloadsById`. Mirrors `MAX_SYNCED_ENTRIES`.
 *
 * The manifest requests no `unlimitedStorage`, so this map lives inside the browser's
 * `storage.local` quota and the popup now reads all of it on every open. Records only —
 * the prune never touches a file (see `pruneTerminalJobs`).
 */
const MAX_STORED_TERMINAL_JOBS = 200;

let videosByTab: Record<string, VideoRecord[]> = {};
let downloadsById: Record<string, DownloadJobRecord> = {};
let settings: BackgroundSettings = {
  downloadFolder: "",
  musicMode: false,
  audioFormat: "mp3",
  downloadSyncEnabled: true,
  overlayEnabled: true,
  popupWidth: POPUP_DEFAULT_WIDTH,
  theme: "system",
};
let stateLoaded = false;
let stateLoadPromise: Promise<unknown> | null = null;

function callStorageGet(keys: string[]): Promise<Record<string, unknown> | null> {
  return browserApi ? browserApi.storage.get(keys) : Promise.resolve({});
}

function callStorageSet(items: Record<string, unknown>): Promise<unknown> {
  return browserApi ? browserApi.storage.set(items) : Promise.resolve();
}

function cleanStoredVideos(storedVideosByTab: Record<string, unknown>): Record<string, VideoRecord[]> {
  const cleaned: Record<string, VideoRecord[]> = {};
  for (const tabId in storedVideosByTab) {
    if (!Object.prototype.hasOwnProperty.call(storedVideosByTab, tabId)) continue;
    const raw = storedVideosByTab[tabId];
    const list: VideoRecord[] = Array.isArray(raw) ? raw : [];
    cleaned[tabId] = list.filter(function (video) {
      return video && video.url && !videoFilters.isBlockedVideoUrl(video.url, video.contentType);
    });
  }
  return cleaned;
}

function load(): Promise<unknown> {
  if (stateLoaded) {
    return Promise.resolve();
  }
  if (!stateLoadPromise) {
    stateLoadPromise = Promise.all([
      callStorageGet([STORAGE_VIDEOS, STORAGE_SETTINGS, STORAGE_DOWNLOADS]),
      loadSyncHistoryFromStorage(),
    ]).then(function (results) {
      const items = (results[0] || {}) as Record<string, any>;
      videosByTab = cleanStoredVideos((items[STORAGE_VIDEOS] || {}) as Record<string, unknown>);
      settings = Object.assign({}, settings, items[STORAGE_SETTINGS] || {});
      downloadsById = (items[STORAGE_DOWNLOADS] || {}) as Record<string, DownloadJobRecord>;
      // Shrink a store that was already oversized before the retention rule existed,
      // rather than waiting for the next download to finish.
      const pruned = pruneTerminalJobs();
      stateLoaded = true;
      return Promise.all([persistVideos(), pruned ? persistDownloads() : Promise.resolve()]);
    });
  }
  return stateLoadPromise;
}

function persistVideos(): Promise<unknown> {
  return callStorageSet({ [STORAGE_VIDEOS]: videosByTab });
}

function persistSettings(): Promise<unknown> {
  return callStorageSet({ [STORAGE_SETTINGS]: settings });
}

function persistDownloads(): Promise<unknown> {
  return callStorageSet({ [STORAGE_DOWNLOADS]: downloadsById });
}

/**
 * Floor on how often a *non-terminal* patch reaches `storage.local` (spec D3/§5.2).
 *
 * `updateDownload` used to serialise the whole `downloadsById` map on every patch,
 * and the native host sends a patch per parsed line — N_m3u8DL-RE re-renders its
 * grid ~10×/sec, which is ten full-map writes per second per job. Only the write
 * coalesces: the merged job still lands in `downloadsById` synchronously, which is
 * what `download_helpers.ts:updateDownload` relies on when it reads the job straight
 * back to broadcast it. That is what keeps the bar smooth at the UI's own update rate
 * (the host's own 4/sec limiter, §5.1) while storage sees at most one write per
 * second.
 */
const DOWNLOAD_PERSIST_INTERVAL_MS = 1000;
let downloadsPersistTimer: ReturnType<typeof setTimeout> | null = null;

// --- Video state ---

function getVideosForTab(tabId: TabId): VideoRecord[] {
  return videosByTab[String(tabId)] || [];
}

function setVideosForTab(tabId: TabId, videos: VideoRecord[]): Promise<unknown> {
  videosByTab[String(tabId)] = videos;
  return persistVideos();
}

function removeTab(tabId: TabId): Promise<unknown> {
  delete videosByTab[String(tabId)];
  return persistVideos();
}

/** Apply a mutator function to a tab's video list, then persist. */
function mutateVideos(
  tabId: TabId,
  mutator: (list: VideoRecord[], tabKey: string) => VideoRecord[] | void,
): Promise<unknown> {
  const tabKey = String(tabId);
  const list = videosByTab[tabKey] || [];
  const changed = mutator(list, tabKey);
  if (changed !== undefined) {
    videosByTab[tabKey] = changed;
  }
  return persistVideos();
}

/** Find and update a single video by predicate, then persist. Returns true if changed. */
function patchVideo(tabId: TabId, predicate: (item: VideoRecord) => boolean, patch: VideoPatch): Promise<boolean> {
  const tabKey = String(tabId);
  let changed = false;
  videosByTab[tabKey] = (videosByTab[tabKey] || []).map(function (item) {
    if (!predicate(item)) {
      return item;
    }
    changed = true;
    return Object.assign({}, item, patch);
  });
  if (!changed) {
    return Promise.resolve(false);
  }
  return persistVideos().then(function () {
    return true;
  });
}

// --- Download state ---

function getDownload(jobId: string): DownloadJobRecord | null {
  return downloadsById[jobId] || null;
}

function getAllDownloads(): Record<string, DownloadJobRecord> {
  return downloadsById;
}

function setAllDownloads(downloads: Record<string, DownloadJobRecord>): Promise<unknown> {
  downloadsById = downloads;
  return persistDownloads();
}

/**
 * Coalesce the download write, except where coalescing could lose state.
 *
 * The exception is the whole point (spec §8 rates it the one thing that must not be
 * got wrong): an MV3 service worker can be evicted between any two ticks, so a
 * coalesced write means a download killed mid-flight could be restored from storage
 * still `running`, or lose its final state entirely. `done` / `error` / `canceled`
 * therefore never wait for a timer — and neither does `paused`, which is a state the
 * user chose and expects to survive a restart.
 *
 * A pending timer is *cancelled* rather than left to fire, so the flush is the last
 * write for that map. `download_operations.ts`'s `removeDownload` / `clearDownloads`
 * call `persistDownloads()` directly and are unaffected; a timer left over from
 * before them would re-serialise the same already-mutated map, which is a no-op.
 */
function scheduleDownloadsPersist(status?: string): Promise<unknown> {
  const immediate = status === "paused" || TERMINAL_DOWNLOAD_STATUSES.has(String(status));
  if (!immediate && downloadsPersistTimer !== null) {
    return Promise.resolve();
  }
  if (downloadsPersistTimer !== null) {
    clearTimeout(downloadsPersistTimer);
    downloadsPersistTimer = null;
  }
  if (immediate) {
    return persistDownloads();
  }
  downloadsPersistTimer = setTimeout(() => {
    downloadsPersistTimer = null;
    void persistDownloads();
  }, DOWNLOAD_PERSIST_INTERVAL_MS);
  return Promise.resolve();
}

/**
 * Drop terminal jobs past the newest {@link MAX_STORED_TERMINAL_JOBS}. Records only.
 *
 * Three things it deliberately does not do:
 *
 * - **Never consider an active job.** `isActiveDownload` reads a missing status as
 *   `"queued"`, so a malformed record is kept rather than dropped — losing a running job
 *   is far worse than keeping one extra.
 * - **Never delete a file.** Deleting from disk is exclusively the per-row *Remove*
 *   action's job. A prune that took a user's finished videos would be a data-loss bug.
 * - **Never broadcast.** The removed jobs are already terminal and older than anything on
 *   screen; a `downloadRemoved` per id is N messages for a list no open surface is showing.
 *   The next `load()` / `getVideos` reads the pruned map.
 *
 * @returns whether anything was dropped, so `load()` knows to write the map back.
 */
function pruneTerminalJobs(): boolean {
  const terminal = Object.keys(downloadsById)
    .filter((jobId) => !isActiveDownload(downloadsById[jobId]))
    .sort((left, right) => Number(downloadsById[right].updatedAt || 0) - Number(downloadsById[left].updatedAt || 0));

  const dropped = terminal.slice(MAX_STORED_TERMINAL_JOBS);
  for (const jobId of dropped) {
    delete downloadsById[jobId];
  }
  return dropped.length > 0;
}

function updateDownload(jobId: string, patch: VideoPatch): Promise<unknown> {
  const existing = downloadsById[jobId] || { id: jobId };
  const merged: DownloadJobRecord = Object.assign({}, existing, patch, { updatedAt: Date.now() });
  downloadsById[jobId] = merged;

  // Sync completed/failed/canceled downloads to storage.sync history.
  // This runs asynchronously — does not block the download update.
  if (downloadSync.isSyncEnabled() && isFinalStatus(merged.status)) {
    downloadSync.addSyncedDownload(merged);
    persistSyncHistoryToStorage();
    // Before the persist below, so the write that leaves here is already the pruned map —
    // a terminal status makes `scheduleDownloadsPersist` write immediately, so there is no
    // second write.
    pruneTerminalJobs();
  }

  return scheduleDownloadsPersist(merged.status);
}

/**
 * Check if a status is a final/completed status that should be synced.
 */
function isFinalStatus(status?: string): boolean {
  return status === "done" || status === "error" || status === "canceled";
}

// ─── Sync history persistence ──────────────────────────────────────────────

/**
 * Persist the current sync history to chrome.storage.sync.
 * This saves history across browser instances.
 */
function persistSyncHistoryToStorage(): void {
  const json = downloadSync.persistSyncHistory();
  if (browserApi && browserApi.storage && browserApi.storage.sync) {
    browserApi.storage.sync.set({ qwinDownloadHistory: json }).catch(function () {
      // Sync persistence is best-effort
    });
  }
}

function callStorageSyncGet(keys: string[]): Promise<Record<string, any>> {
  if (browserApi && browserApi.storage && browserApi.storage.sync) {
    return browserApi.storage.sync.get(keys);
  }
  return Promise.resolve({});
}

/**
 * Load sync history from storage.sync on startup.
 * Merges the loaded data with any in-memory state.
 */
function loadSyncHistoryFromStorage(): Promise<void> {
  return callStorageSyncGet(["qwinDownloadHistory"])
    .then(function (items) {
      const stored = items.qwinDownloadHistory;
      if (stored) {
        downloadSync.loadSyncHistory(stored);
      }
    })
    .catch(function () {
      // Loading sync history is best-effort
    });
}

// --- Settings state ---

function getSettings(): BackgroundSettings {
  return settings;
}

function setSettings(nextSettings: BackgroundSettings): Promise<unknown> {
  settings = nextSettings;
  return persistSettings();
}

function updateSettings(patch: Partial<BackgroundSettings>): Promise<unknown> {
  settings = Object.assign({}, settings, patch);
  return persistSettings();
}

export {
  load,

  // Videos
  getVideosForTab,
  setVideosForTab,
  removeTab,
  mutateVideos,
  patchVideo,

  // Downloads
  getDownload,
  getAllDownloads,
  setAllDownloads,
  updateDownload,
  pruneTerminalJobs,
  MAX_STORED_TERMINAL_JOBS,

  // Settings
  getSettings,
  setSettings,
  updateSettings,

  // Persistence (for direct external control if needed)
  persistVideos,
  persistSettings,
  persistDownloads,

  // Sync history persistence
  persistSyncHistoryToStorage,
};
