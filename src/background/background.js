"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as videoFilters from "../shared/video_filters.js";
import * as tabState from "./tab_state.js";
import * as nativeRequestsMod from "./native_requests.js";
import * as cdpRelay from "./cdp_relay.js";
import * as cdpExtraction from "./cdp/index.js";
import * as cdmNetworkIntercept from "./cdm_network_intercept.js";
import * as segmentCapture from "./segment_capture.js";
import * as batchOrchestration from "./batch_orchestration.js";
import * as downloadSync from "../shared/download_sync.js";
import * as downloadQueue from "./download_queue.js";
import { create as createMessageRouter } from "./message_router.js";
import { create as createDownloadOrchestration } from "./download/index.js";

// ── Extracted modules ────────────────────────────────────────────────────

import * as headerUtils from "./header_utils.js";
import * as videoUtils from "./video_utils.js";
import * as filterIntegration from "./filter_integration.js";
import * as sizeProbe from "./size_probe.js";
import * as downloadHelpers from "./download_helpers.js";
import * as formatHelpers from "./format_helpers.js";
import * as recording from "./recording.js";

// ── Newly extracted modules ──────────────────────────────────────────────

import { initWebRequestHandlers, isExtensionPageSender } from "./background_webrequest.js";
import { registerAllHandlers } from "./message-handlers/index.js";
import { runInit } from "./background_init.js";
import * as cloudflareSolver from "./cloudflare_solver.js";
import * as swRelay from "./sw_relay.js";
import * as debugLogger from "./debug_logger.js";

// ── Re-exports for message handlers ──────────────────────────────────────

const {
  normalizeUrl,
  nativeRequestHeadersForVideo,
} = headerUtils;

const {
  hashId,
  detectFormat,
  contentTypeFromHeaders,
  contentLengthFromHeaders,
  isDownloadableUrl,
  isLikelyVideoRequest,
  VIDEO_EXTENSION_RE,
  HLS_RE,
  CDN_HINT_RE,
} = videoUtils;

const {
  isBlockedUrlWithFilters,
} = filterIntegration;

const {
  updateDownload,
  normalizeDownloadProgress,
  downloadProgressMessage,
  resetDownloadProgressDetails,
  progressDetailPatchFromMessage,
  artifactPatchFromMessage,
  cleanupPatchFromMessage,
  clearedArtifactPatch,
  cleanupDownloadArtifacts,
  isHardAccessError,
  isRetryableSourceError,
  exhaustedSourcesError,
  userFriendlyDownloadError,
  markVideoUrlUnavailable,
  variantsForVideo,
  findVariant,
  pageFallbackVideoForSource,
  fallbackVideoForDownload,
  buildDownloadFallbackDeps,
} = downloadHelpers;

// formatHelpers destructured directly at usage sites

// ── Raw API object for native_requests.js ────────────────────────────────

const api = browserApi.raw;
const messageRouter = createMessageRouter();
const downloadOrchestrationModule = { create: createDownloadOrchestration };
const nativeRequests = { nativeRequest: nativeRequestsMod.nativeRequest };

const HOST_NAME = downloadHelpers.HOST_NAME;

// Initialize file-based debug logger with a nativeRequest wrapper
debugLogger.init((payload) => nativeRequestsMod.nativeRequest(api, HOST_NAME, payload, 30000));

// ── State ────────────────────────────────────────────────────────────────

const pageTitlesByTab = {};

function setPageTitle(tabId, title) {
  if (title) pageTitlesByTab[tabId] = title;
}

headerUtils.setBlockedUrlCheck(isBlockedUrlWithFilters);

// ── Popup notification ───────────────────────────────────────────────────

function notifyPopup(message) {
  browserApi.runtime.sendMessage(message).catch(() => {});

  // Also buffer debug log entries for file output via native host
  if (message && message.type === "downloadDebugLog") {
    debugLogger.log(message);
  }
}

// ── Visible video helpers ────────────────────────────────────────────────

function getVisibleVideosForTab(tabId) {
  return videoFilters.groupUniqueFullVideos(tabState.getVideosForTab(tabId));
}

// ── Core video detection ─────────────────────────────────────────────────

async function addDetectedVideo(tabId, input, notify = true) {
  if (!Number.isInteger(tabId) || tabId < 0 || !input || !input.url) {
    return null;
  }

  await tabState.load();

  const normalizedUrl = normalizeUrl(input.url);
  if (isBlockedUrlWithFilters(normalizedUrl, input.contentType)) {
    return null;
  }

  const format = input.format || detectFormat(normalizedUrl, input.contentType);
  const id = hashId(normalizedUrl);
  const now = Date.now();
  const existing = tabState.getVideosForTab(tabId);
  const current = existing.find((item) => item.id === id);
  const width = Number(input.width || 0);
  const height = Number(input.height || 0);
  const duration = Number(input.duration || 0);
  const bitrate = Number(input.bitrate || input.tbr || 0);
  const isPlaylist = videoUtils.isPlaylistVideo({ url: normalizedUrl, format, contentType: input.contentType || "" });
  const sizeBytes = isPlaylist ? 0 : Number(input.sizeBytes || input.filesize || 0);

  const inputTitle = input.title || "";
  const currentTitle = current?.title || "";
  const isGenericInput = videoFilters.isGenericTitle(inputTitle);
  const isGenericCurrent = videoFilters.isGenericTitle(currentTitle);

  const urlDerivedTitle = videoUtils.titleFromUrl(normalizedUrl);
  const finalTitle = (function () {
    const candidate =
      (!isGenericInput && inputTitle) || (!isGenericCurrent && currentTitle) || inputTitle || urlDerivedTitle;
    if (
      videoFilters.isGenericTitle(candidate) ||
      (candidate === urlDerivedTitle && videoUtils.looksLikeServerToken(urlDerivedTitle))
    ) {
      const pageTitle = pageTitlesByTab[tabId];
      if (pageTitle && !videoFilters.isGenericTitle(pageTitle)) {
        return pageTitle;
      }
    }
    return candidate;
  })();

  const nextVideo = {
    id,
    url: normalizedUrl,
    format,
    source: input.source || "network",
    title: finalTitle,
    pageUrl: input.pageUrl || input.frameUrl || "",
    frameUrl: input.frameUrl || "",
    contentType: input.contentType || "",
    downloadable: current?.downloadable === false ? false : isDownloadableUrl(normalizedUrl, input.contentType),
    width: Number.isFinite(width) && width > 0 ? width : current?.width || null,
    height: Number.isFinite(height) && height > 0 ? height : current?.height || null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : current?.duration || null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : current?.bitrate || null,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : current?.sizeBytes || null,
    thumbnailUrl: input.thumbnailUrl || current?.thumbnailUrl || "",
    firstSeen: current ? current.firstSeen : now,
    lastSeen: now,
  };

  if (!videoFilters.isLikelyFullLengthVideoCandidate(nextVideo)) {
    await tabState.setVideosForTab(
      tabId,
      existing.filter((item) => item.id !== id),
    );
    if (notify) {
      notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    }
    return null;
  }

  let nextList;
  if (current) {
    nextList = existing.map((item) => (item.id === id ? { ...item, ...nextVideo } : item));
  } else {
    nextList = [nextVideo, ...existing];
  }

  await tabState.setVideosForTab(
    tabId,
    nextList.sort((left, right) => right.lastSeen - left.lastSeen).slice(0, videoUtils.MAX_VIDEOS_PER_TAB),
  );

  if (notify) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  sizeProbe.scheduleVideoSizeProbe(tabId, nextVideo);
  return nextVideo;
}

// ── Tab management ───────────────────────────────────────────────────────

async function clearTab(tabId) {
  delete pageTitlesByTab[tabId];
  await tabState.load();
  await tabState.removeTab(tabId);
  notifyPopup({ type: "videoListUpdated", tabId, videos: [] });
}

async function getTabVideos(tabId) {
  await tabState.load();
  sizeProbe.scheduleMissingSizeProbes(tabId);
  return getVisibleVideosForTab(tabId);
}

async function getTabDownloads(tabId) {
  await tabState.load();
  const allDownloads = Object.values(tabState.getAllDownloads());
  // Filter downloads to only show jobs for the current tab.
  // This prevents old downloads from other tabs/sites from cluttering the
  // download list when the user navigates to a new site.
  return allDownloads
    .filter((job) => !job.tabId || job.tabId === tabId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

// ── Fallback deps (closure over background functions) ────────────────────

function downloadFallbackDeps() {
  return buildDownloadFallbackDeps(nativeRequest, addDetectedVideo, getVisibleVideosForTab, nativeRequestHeadersForVideo);
}

// ── Sender tab ID helper ─────────────────────────────────────────────────

function senderTabId(message, sender) {
  return message.tabId || (sender.tab && sender.tab.id);
}

// ── Native request wrapper ───────────────────────────────────────────────

function nativeRequest(payload, timeoutMs = 60000) {
  return nativeRequests.nativeRequest(api, HOST_NAME, payload, timeoutMs);
}

// ── Download orchestration wiring ────────────────────────────────────────

function downloadOrchestrationDeps() {
  return {
    api,
    artifactPatchFromMessage,
    blockingDownloadStatuses: downloadHelpers.BLOCKING_DOWNLOAD_STATUSES,
    callTabsQuery: browserApi.tabs.query,
    cleanupDownloadArtifacts: (jobId, job) => cleanupDownloadArtifacts(jobId, job, nativeRequest),
    cleanupPatchFromMessage,
    clearedArtifactPatch,
    detectFormat,
    downloadPortsById: downloadHelpers.downloadPortsById,
    downloadProgressMessage,
    ensureStateLoaded: tabState.load,
    exhaustedSourcesError,
    fallbackVideoForDownload: (tabId, failedVideo, attemptedUrls) =>
      fallbackVideoForDownload(tabId, failedVideo, attemptedUrls, downloadFallbackDeps()),
    findVariant,
    getDownloadsById: () => tabState.getAllDownloads(),
    getSettings: () => tabState.getSettings(),
    getTabVideos,
    hashId,
    hostName: HOST_NAME,
    isHardAccessError,
    isRetryableSourceError,
    markVideoUrlUnavailable,
    nativeRequest,
    nativeRequestHeadersForVideo,
    normalizeDownloadProgress,
    normalizeUrl,
    notifyPopup,
    pageFallbackVideoForSource: (video, attemptedUrls) =>
      pageFallbackVideoForSource(video, attemptedUrls, downloadFallbackDeps()),
    persistDownloads: tabState.persistDownloads,
    persistSettings: tabState.persistSettings,
    progressDetailPatchFromMessage,
    resetDownloadProgressDetails,
    setDownloadsById(nextDownloadsById) {
      tabState.setAllDownloads(nextDownloadsById);
    },
    setSettings(nextSettings) {
      tabState.setSettings(nextSettings);
    },
    titleFromUrl: videoUtils.titleFromUrl,
    updateDownload: (jobId, patch) => updateDownload(jobId, patch, notifyPopup),
    userAgent: () => navigator.userAgent || "",
    userFriendlyDownloadError,
    variantsForVideo,
    videoFilters,
  };
}

let downloadOrchestration = null;
function getDownloadOrchestration() {
  if (!downloadOrchestration) {
    downloadOrchestration = downloadOrchestrationModule.create(downloadOrchestrationDeps());
  }
  return downloadOrchestration;
}

async function startNativeDownload(tabId, videoId, formatId = "best", variantId = "", backend = "auto") {
  return getDownloadOrchestration().startNativeDownload(tabId, videoId, formatId, variantId, backend);
}

async function startNativeDownloadForUrl(tabId, input) {
  return getDownloadOrchestration().startNativeDownloadForUrl(tabId, input);
}

async function getBestDownloadableVideo(tabId) {
  return getDownloadOrchestration().getBestDownloadableVideo(tabId);
}

async function startBestNativeDownload(tabId, formatId = "best", variantId = "") {
  return getDownloadOrchestration().startBestNativeDownload(tabId, formatId, variantId);
}

function controlActiveDownload(jobId, nativeType) {
  return getDownloadOrchestration().controlActiveDownload(jobId, nativeType);
}

async function resumeDownload(tabId, jobId) {
  return getDownloadOrchestration().resumeDownload(tabId, jobId);
}

async function cancelDownload(tabId, jobId) {
  return getDownloadOrchestration().cancelDownload(tabId, jobId);
}

async function retryDownload(tabId, jobId) {
  return getDownloadOrchestration().retryDownload(tabId, jobId);
}

async function openDownloadedPath(jobId, nativeType) {
  return getDownloadOrchestration().openDownloadedPath(jobId, nativeType);
}

async function chooseDownloadFolder() {
  return getDownloadOrchestration().chooseDownloadFolder();
}

async function removeDownload(jobId) {
  return getDownloadOrchestration().removeDownload(jobId);
}

async function clearDownloads() {
  return getDownloadOrchestration().clearDownloads();
}

// ── Imported helper-ping module ────────────────────────────────────────

import { cachedHelperStatus, HELPER_PING_INTERVAL_MS, refreshCachedHelperStatus, pingNativeHost } from "./background_helper_ping.js";

// ── CDP relay init ───────────────────────────────────────────────────────

cdpRelay.init();

// ── SW capture relay init ────────────────────────────────────────────────

swRelay.init();

// ── Recording progress updates ───────────────────────────────────────────

recording.startRecordingProgressUpdates(recording.getActiveRecordingsRef());

// ── Wire webRequest handlers ─────────────────────────────────────────────

initWebRequestHandlers({
  clearTab,
  addDetectedVideo,
  detectFormat,
  isLikelyVideoRequest,
  VIDEO_EXTENSION_RE,
  HLS_RE,
  CDN_HINT_RE,
  contentTypeFromHeaders,
  contentLengthFromHeaders,
});

// ── Wire message handlers ────────────────────────────────────────────────

registerAllHandlers(messageRouter, {
  // Core helpers
  senderTabId,
  notifyPopup,
  getVisibleVideosForTab,
  addDetectedVideo,
  clearTab,
  getTabVideos,
  getTabDownloads,
  isExtensionPageSender,

  // Download orchestration
  nativeRequest,
  startNativeDownload,
  startNativeDownloadForUrl,
  getBestDownloadableVideo,
  startBestNativeDownload,
  controlActiveDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  openDownloadedPath,
  chooseDownloadFolder,
  removeDownload,
  clearDownloads,
  downloadOrchestrationDeps,

  // Imported modules
  downloadQueue,
  batchOrchestration,
  cdpRelay,
  cdpExtraction,
  cdmNetworkIntercept,
  segmentCapture,
  recording,
  downloadSync,
  tabState,
  browserApi,
  videoUtils,
  downloadHelpers,
  formatHelpers,

  // Page title management
  setPageTitle,

  // Background helper ping exports
  cachedHelperStatus,
  HELPER_PING_INTERVAL_MS,
  refreshCachedHelperStatus,
  pingNativeHost,

  // Shared constants
  HOST_NAME,
  videoFilters,
  normalizeUrl,
  nativeRequestHeadersForVideo,
});

// ── Wire message router to runtime ───────────────────────────────────────

browserApi.onMessage((message, sender, sendResponse) => {
  return messageRouter.dispatch(message, sender, sendResponse);
});

// Tab lifecycle
browserApi.onTabRemoved((tabId) => {
  tabState.removeTab(tabId);
});

browserApi.onTabUpdated((tabId, changeInfo) => {
  if (changeInfo.title) {
    pageTitlesByTab[tabId] = changeInfo.title;
  }
  if (changeInfo.status === "loading") {
    clearTab(tabId);
    delete pageTitlesByTab[tabId];
  }
});

// ── Initialize background service worker ─────────────────────────────────

runInit({ notifyPopup, HOST_NAME });
