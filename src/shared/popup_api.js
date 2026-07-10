"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const isPromiseApi = typeof browser !== "undefined";

/**
 * Send a runtime message to the background script.
 * Handles both promise-based (Firefox) and callback-based (Chrome) APIs.
 * @param {Object} message
 * @returns {Promise<Object|null>}
 */
function runtimeMessage(message) {
  if (isPromiseApi) {
    return api.runtime.sendMessage(message);
  }
  return new Promise((resolve) => {
    api.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Query active tabs in the current window.
 * @returns {Promise<Array>}
 */
function tabsQuery() {
  if (isPromiseApi) {
    return api.tabs.query({ active: true, currentWindow: true });
  }
  return new Promise((resolve) => api.tabs.query({ active: true, currentWindow: true }, resolve));
}

// ─── Video queries ────────────────────────────────────────────────────────

/** @param {number} tabId */
function getVideos(tabId) {
  return runtimeMessage({ type: "getVideos", tabId });
}

/** @param {number} tabId @param {string} videoId */
function getVideoFormats(tabId, videoId) {
  return runtimeMessage({ type: "getVideoFormats", tabId, videoId });
}

/** @param {number} tabId @param {Object} video */
function getFormatsForUrl(tabId, video) {
  return runtimeMessage({ type: "getFormatsForUrl", tabId, video });
}

// ─── Tab scanning ─────────────────────────────────────────────────────────

/** @param {number} tabId */
function rescanTab(tabId) {
  return runtimeMessage({ type: "rescanTab", tabId });
}

/** @param {number} tabId */
function clearVideos(tabId) {
  return runtimeMessage({ type: "clearVideos", tabId });
}

/** @param {number} tabId */
function clearDownloads(tabId) {
  return runtimeMessage({ type: "clearDownloads", tabId });
}

// ─── Download actions ─────────────────────────────────────────────────────

/** @param {number} tabId @param {string} videoId @param {string} formatId @param {string} [variantId] @param {string} [backend] */
function downloadVideo(tabId, videoId, formatId, variantId, backend) {
  return runtimeMessage({
    type: "downloadVideo",
    tabId,
    videoId,
    formatId,
    variantId: variantId || "",
    backend: backend || "auto",
  });
}

/** @param {number} tabId @param {string} jobId */
function pauseDownload(tabId, jobId) {
  return runtimeMessage({ type: "pauseDownload", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function resumeDownload(tabId, jobId) {
  return runtimeMessage({ type: "resumeDownload", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function cancelDownload(tabId, jobId) {
  return runtimeMessage({ type: "cancelDownload", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function retryDownload(tabId, jobId) {
  return runtimeMessage({ type: "retryDownload", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function openDownloadedFile(tabId, jobId) {
  return runtimeMessage({ type: "openDownloadedFile", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function showDownloadedFile(tabId, jobId) {
  return runtimeMessage({ type: "showDownloadedFile", tabId, jobId });
}

/** @param {number} tabId @param {string} jobId */
function removeDownload(tabId, jobId) {
  return runtimeMessage({ type: "removeDownload", tabId, jobId });
}

// ─── Settings / misc ──────────────────────────────────────────────────────

/**
 * @param {Object} settings
 * @param {string} [settings.downloadFolder]
 * @param {boolean} [settings.musicMode]
 * @param {string} [settings.audioFormat]
 */
function saveSettings(settings) {
  return runtimeMessage({ type: "saveSettings", settings });
}

function chooseDownloadFolder() {
  return runtimeMessage({ type: "chooseDownloadFolder" });
}

function pingNativeHost() {
  return runtimeMessage({ type: "pingNativeHost" });
}

/**
 * Get the cached native helper status from the background.
 * Returns { connected, version, dependencies, lastChecked }.
 * @returns {Promise<{ok: boolean, connected: boolean, version: string, dependencies: Object, lastChecked: number}>}
 */
function getHelperStatus() {
  return runtimeMessage({ type: "getHelperStatus" });
}

// ─── Download History Sync ────────────────────────────────────────────────

/**
 * Get the synced download history from storage.sync.
 * @returns {Promise<{ok: boolean, history: Array, syncInfo: Object}>}
 */
function getDownloadSyncHistory() {
  return runtimeMessage({ type: "getDownloadSyncHistory" });
}

/**
 * Set whether download history syncing is enabled.
 * @param {boolean} enabled
 * @returns {Promise<{ok: boolean}>}
 */
function setDownloadSyncEnabled(enabled) {
  return runtimeMessage({ type: "setDownloadSyncEnabled", enabled });
}

/**
 * Clear the synced download history.
 * @returns {Promise<{ok: boolean}>}
 */
function clearDownloadSyncHistory() {
  return runtimeMessage({ type: "clearDownloadSyncHistory" });
}

export {
  runtimeMessage,
  tabsQuery,
  getVideos,
  getVideoFormats,
  getFormatsForUrl,
  rescanTab,
  clearVideos,
  clearDownloads,
  downloadVideo,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  openDownloadedFile,
  showDownloadedFile,
  removeDownload,
  saveSettings,
  chooseDownloadFolder,
  pingNativeHost,
  getHelperStatus,
  // Download History Sync
  getDownloadSyncHistory,
  setDownloadSyncEnabled,
  clearDownloadSyncHistory,
};
