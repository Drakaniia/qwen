"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as videoFilters from "../shared/video_filters.js";
import * as downloadSync from "../shared/download_sync.js";

const STORAGE_VIDEOS = "qwinVideosByTab";
const STORAGE_SETTINGS = "qwinSettings";
const STORAGE_DOWNLOADS = "qwinDownloadsById";

let videosByTab = {};
let downloadsById = {};
let settings = {
  downloadFolder: "",
  musicMode: false,
  audioFormat: "mp3",
  recordingMode: "ask",
  downloadSyncEnabled: true,
  autoDownload: false,
  maxConcurrentDownloads: 3,
};
let stateLoaded = false;
let stateLoadPromise = null;
const subscribers = [];

function callStorageGet(keys) {
  return browserApi ? browserApi.storage.get(keys) : Promise.resolve({});
}

function callStorageSet(items) {
  return browserApi ? browserApi.storage.set(items) : Promise.resolve();
}

function cleanStoredVideos(storedVideosByTab) {
  const cleaned = {};
  for (const tabId in storedVideosByTab) {
    if (!Object.prototype.hasOwnProperty.call(storedVideosByTab, tabId)) continue;
    const list = Array.isArray(storedVideosByTab[tabId]) ? storedVideosByTab[tabId] : [];
    cleaned[tabId] = list.filter(function (video) {
      return video && video.url && !videoFilters.isBlockedVideoUrl(video.url, video.contentType);
    });
  }
  return cleaned;
}

function load() {
  if (stateLoaded) {
    return Promise.resolve();
  }
  if (!stateLoadPromise) {
    stateLoadPromise = Promise.all([
      callStorageGet([STORAGE_VIDEOS, STORAGE_SETTINGS, STORAGE_DOWNLOADS]),
      loadSyncHistoryFromStorage(),
    ]).then(function (results) {
      const items = results[0];
      videosByTab = cleanStoredVideos(items[STORAGE_VIDEOS] || {});
      settings = Object.assign({}, settings, items[STORAGE_SETTINGS] || {});
      downloadsById = items[STORAGE_DOWNLOADS] || {};
      stateLoaded = true;
      return persistVideos();
    });
  }
  return stateLoadPromise;
}

function isLoaded() {
  return stateLoaded;
}

function persistVideos() {
  return callStorageSet({ [STORAGE_VIDEOS]: videosByTab });
}

function persistSettings() {
  return callStorageSet({ [STORAGE_SETTINGS]: settings });
}

function persistDownloads() {
  return callStorageSet({ [STORAGE_DOWNLOADS]: downloadsById });
}

// --- Video state ---

function getVideosForTab(tabId) {
  return videosByTab[String(tabId)] || [];
}

function getVideosByTabRef() {
  return videosByTab;
}

function setVideosForTab(tabId, videos) {
  videosByTab[String(tabId)] = videos;
  return persistVideos().then(function () {
    notify("videosChanged", { tabId: tabId });
  });
}

function removeTab(tabId) {
  delete videosByTab[String(tabId)];
  return persistVideos().then(function () {
    notify("videosChanged", { tabId: tabId });
  });
}

/** Apply a mutator function to a tab's video list, then persist. */
function mutateVideos(tabId, mutator) {
  const tabKey = String(tabId);
  const list = videosByTab[tabKey] || [];
  const changed = mutator(list, tabKey);
  if (changed !== undefined) {
    videosByTab[tabKey] = changed;
  }
  return persistVideos().then(function () {
    notify("videosChanged", { tabId: tabId });
  });
}

/** Find and update a single video by predicate, then persist. Returns true if changed. */
function patchVideo(tabId, predicate, patch) {
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
    notify("videosChanged", { tabId: tabId });
    return true;
  });
}

// --- Download state ---

function getDownload(jobId) {
  return downloadsById[jobId] || null;
}

function getAllDownloads() {
  return downloadsById;
}

function setAllDownloads(downloads) {
  downloadsById = downloads;
  return persistDownloads().then(function () {
    notify("downloadsChanged");
  });
}

function updateDownload(jobId, patch) {
  const existing = downloadsById[jobId] || { id: jobId };
  const merged = Object.assign({}, existing, patch, { updatedAt: Date.now() });
  downloadsById[jobId] = merged;

  // Sync completed/failed/canceled downloads to storage.sync history.
  // This runs asynchronously — does not block the download update.
  if (downloadSync.isSyncEnabled() && isFinalStatus(merged.status)) {
    downloadSync.addSyncedDownload(merged);
    persistSyncHistoryToStorage();
  }

  return persistDownloads().then(function () {
    notify("downloadUpdated", { job: downloadsById[jobId] });
  });
}

/**
 * Check if a status is a final/completed status that should be synced.
 * @param {string} status
 * @returns {boolean}
 */
function isFinalStatus(status) {
  return status === "done" || status === "error" || status === "canceled";
}

// ─── Sync history persistence ──────────────────────────────────────────────

/**
 * Persist the current sync history to chrome.storage.sync.
 * This saves history across browser instances.
 */
function persistSyncHistoryToStorage() {
  const json = downloadSync.persistSyncHistory();
  if (browserApi && browserApi.storage && browserApi.storage.sync) {
    browserApi.storage.sync.set({ qwinDownloadHistory: json }).catch(function () {
      // Sync persistence is best-effort
    });
  }
}

/**
 * Load sync history from storage.sync on startup.
 * Merges the loaded data with any in-memory state.
 */
function loadSyncHistoryFromStorage() {
  return callStorageSyncGet(["qwinDownloadHistory"]).then(function (items) {
    const stored = items.qwinDownloadHistory;
    if (stored) {
      downloadSync.loadSyncHistory(stored);
    }
  }).catch(function () {
    // Loading sync history is best-effort
  });
}

function callStorageSyncGet(keys) {
  if (browserApi && browserApi.storage && browserApi.storage.sync) {
    return browserApi.storage.sync.get(keys);
  }
  return Promise.resolve({});
}

// --- Settings state ---

function getSettings() {
  return settings;
}

function setSettings(nextSettings) {
  settings = nextSettings;
  return persistSettings().then(function () {
    notify("settingsChanged", { settings: settings });
  });
}

function updateSettings(patch) {
  settings = Object.assign({}, settings, patch);
  return persistSettings().then(function () {
    notify("settingsChanged", { settings: settings });
  });
}

// --- Subscription ---

function subscribe(fn) {
  subscribers.push(fn);
  return function unsubscribe() {
    const index = subscribers.indexOf(fn);
    if (index >= 0) {
      subscribers.splice(index, 1);
    }
  };
}

function notify(type, data) {
  for (let i = 0; i < subscribers.length; i += 1) {
    try {
      subscribers[i](type, data);
    } catch (_error) {
      // Don't let a subscriber break others.
    }
  }
}

export {
  load,
  isLoaded,

  // Videos
  getVideosForTab,
  getVideosByTabRef,
  setVideosForTab,
  removeTab,
  mutateVideos,
  patchVideo,

  // Downloads
  getDownload,
  getAllDownloads,
  setAllDownloads,
  updateDownload,

  // Settings
  getSettings,
  setSettings,
  updateSettings,

  // Subscriptions
  subscribe,

  // Persistence (for direct external control if needed)
  persistVideos,
  persistSettings,
  persistDownloads,

  // Sync history persistence
  persistSyncHistoryToStorage,

  // Exposed for testing
  cleanStoredVideos as _cleanStoredVideos,
};
