"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as mediaCandidates from "../shared/media_candidates.js";
import * as videoFilters from "../shared/video_filters.js";
import * as downloadState from "./download_state.js";
import * as tabState from "./tab_state.js";
import * as nativeRequestsMod from "./native_requests.js";
import * as downloadFallbacks from "./download_fallbacks.js";
import * as cdpRelay from "./cdp_relay.js";
import * as cdpExtraction from "./cdp_extraction.js";
import * as cdmNetworkIntercept from "./cdm_network_intercept.js";
import * as segmentCapture from "./segment_capture.js";
import * as batchOrchestration from "./batch_orchestration.js";
import * as playlistDetection from "../shared/playlist_detection.js";
import * as downloadSync from "../shared/download_sync.js";
import { create as createMessageRouter } from "./message_router.js";
import { create as createDownloadOrchestration } from "./download_orchestration.js";

// ── Extracted modules ────────────────────────────────────────────────────

import * as headerUtils from "./header_utils.js";
import * as videoUtils from "./video_utils.js";
import * as filterIntegration from "./filter_integration.js";
import * as sizeProbe from "./size_probe.js";
import * as downloadHelpers from "./download_helpers.js";
import * as formatHelpers from "./format_helpers.js";
import * as recording from "./recording.js";

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
  cleanProgressText,
  resetDownloadProgressDetails,
  progressDetailPatchFromMessage,
  artifactPatchFromMessage,
  cleanupPatchFromMessage,
  clearedArtifactPatch,
  hasDownloadArtifacts,
  cleanupDownloadArtifacts,
  isHardAccessError,
  isRetryableSourceError,
  exhaustedSourcesError,
  userFriendlyDownloadError,
  markVideoUrlUnavailable,
  variantsForVideo,
  preferredNativeVideo,
  findGroupedVideoForAnyVariant,
  findGroupedVideoForVariant,
  findVariant,
  downloadableVariants,
  isExtractorPageVideo,
  pageFallbackVideoForSource,
  resolveMediaCandidatesForSource,
  fallbackVideoForDownload,
  buildDownloadFallbackDeps,
} = downloadHelpers;

const {
  detectedVariantOption,
  normalizeNativeFormatOption,
  getNativeFormatsForVideo,
} = formatHelpers;

// ── Raw API object for native_requests.js ────────────────────────────────

const api = browserApi.raw;
const messageRouter = createMessageRouter();
const downloadOrchestrationModule = { create: createDownloadOrchestration };
const nativeRequests = { nativeRequest: nativeRequestsMod.nativeRequest };

const HOST_NAME = downloadHelpers.HOST_NAME;

// ── State ────────────────────────────────────────────────────────────────

const pageTitlesByTab = {};

headerUtils.setBlockedUrlCheck(isBlockedUrlWithFilters);

// ── Popup notification ───────────────────────────────────────────────────

function notifyPopup(message) {
  browserApi.runtime.sendMessage(message).catch(() => {});
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

async function getTabDownloads(_tabId) {
  await tabState.load();
  return Object.values(tabState.getAllDownloads()).sort((left, right) => right.updatedAt - left.updatedAt);
}

// ── Fallback deps (closure over background functions) ────────────────────

function downloadFallbackDeps() {
  return buildDownloadFallbackDeps(nativeRequest, addDetectedVideo, getVisibleVideosForTab, nativeRequestHeadersForVideo);
}

// ── WebSocket & Service Worker detection ─────────────────────────────────

/**
 * Pattern to detect Service Worker script URLs used as request initiators.
 */
const SERVICE_WORKER_SCOPE_RE = /(?:^|[/?#._-])(?:sw(?:\.js|\b)|serviceworker(?:\.js|\b)|service-worker(?:\.js|\b)|worker\.js)(?:$|[?#])/i;

/**
 * Check if a URL corresponds to a Service Worker script scope.
 *
 * @param {string} url - The initiator URL to check.
 * @returns {boolean} True if the URL looks like a Service Worker script.
 */
function isServiceWorkerScopeUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  return SERVICE_WORKER_SCOPE_RE.test(url);
}

/**
 * Handle WebSocket upgrade requests detected via webRequest.
 *
 * Some streaming platforms deliver video through WebSocket connections.
 * When a WebSocket is detected, we add a placeholder candidate so the
 * user knows the tab has WebSocket activity and can investigate.
 */
function handleWebSocketRequest(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }
  if (!isWebSocketDeliveryUrl(details.url)) {
    return;
  }

  // Flag the tab as having WebSocket activity (stored in tab state)
  // The tab flag is checked by the UI to show WebSocket activity indicators.
  // We do NOT call addDetectedVideo here because WebSocket URLs (ws:///wss://)
  // fail isHttpUrl checks in the video pipeline — the tab flag is sufficient.
  tabState.setTabFlag(details.tabId, "websocket", details.url);
}

// ── Web request handlers ─────────────────────────────────────────────────

function handleBeforeRequest(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }

  if (details.type === "main_frame") {
    clearTab(details.tabId);
    return;
  }

  if (!isLikelyVideoRequest(details.url, details.type)) {
    return;
  }
  if (!VIDEO_EXTENSION_RE.test(details.url)) {
    return;
  }

  addDetectedVideo(details.tabId, {
    url: details.url,
    format: detectFormat(details.url),
    source: HLS_RE.test(details.url) ? "hls-network" : "network",
    pageUrl: details.documentUrl || details.initiator || "",
  });
}

function handleBeforeSendHeaders(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }
  if (details.type !== "media" && !VIDEO_EXTENSION_RE.test(details.url) && !CDN_HINT_RE.test(details.url)) {
    return;
  }
  headerUtils.rememberRequestHeaders(details);
}

function handleHeadersReceived(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }

  const contentType = contentTypeFromHeaders(details.responseHeaders);
  if (!isLikelyVideoRequest(details.url, details.type, contentType)) {
    return;
  }

  // Determine the source based on whether this request was initiated by
  // a Service Worker script (which may proxy/cache video segments).
  const initiator = details.initiator || details.documentUrl || "";
  const source = isServiceWorkerScopeUrl(initiator) ? "service-worker" : (contentType ? "headers" : "network");

  addDetectedVideo(details.tabId, {
    url: details.url,
    format: detectFormat(details.url, contentType),
    source,
    pageUrl: details.documentUrl || details.initiator || "",
    contentType,
    sizeBytes: contentLengthFromHeaders(details.responseHeaders),
  });
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
import { cachedHelperStatus, HELPER_PING_INTERVAL_MS, refreshCachedHelperStatus, startHelperPing, pingNativeHost } from "./background-helper-ping.js";

// ── Video URL patterns for webRequest listeners ────────────────────────

/**
 * Narrow URL patterns to avoid using "<all_urls>" for webRequest listeners.
 *
 * Covers common video file extensions and CDN URL patterns.
 * This prevents the extension from intercepting headers and request bodies
 * for every single HTTP request (images, fonts, scripts, API calls, etc.),
 * significantly reducing the attack surface for compromised content scripts.
 *
 * SECURITY NOTE: The `extraHeaders` permission used in onBeforeSendHeaders
 * exposes Authorization and Cookie headers for matching requests. By narrowing
 * to these video/CDN patterns, we minimize exposure to only video-related
 * traffic rather than all web browsing. The captured headers are stored in
 * header_utils.js's requestHeadersByUrl with a cap of 250 entries and are
 * only used to provide download context to yt-dlp/aria2c.
 */
const VIDEO_REQUEST_PATTERNS = [
  "*://*/*.mp4*",
  "*://*/*.m3u8*",
  "*://*/*.ts*",
  "*://*/*.webm*",
  "*://*/*.mkv*",
  "*://*/*.avi*",
  "*://*/*.mov*",
  "*://*/*.flv*",
  "*://*/*.wmv*",
  "*://*/*.m4s*",
  "*://*/*.mpd*",
  "*://*/*.key*",
  "*://*/*videoplayback*",
  "*://*/*dash*",
  "*://*/*hls*",
  "*://*/*segment*",
  "*://*/*media*",
  "*://*/*stream*",
  "*://*/*cdn*",
];

// ── WebRequest listener registration ─────────────────────────────────────

// Tab clearing on main_frame navigation — still needs <all_urls>
browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, {
  urls: ["<all_urls>"],
  types: ["main_frame"],
});

// Video detection — narrow patterns only
browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, {
  urls: VIDEO_REQUEST_PATTERNS,
});

// WebSocket stream detection — <all_urls> required because WebSocket URLs use ws:///wss://
browserApi.webRequest.onBeforeRequest.addListener(handleWebSocketRequest, {
  urls: ["<all_urls>"],
  types: ["websocket"],
});

// Request headers for video download context — narrow patterns + extraHeaders
browserApi.webRequest.onBeforeSendHeaders.addListener(
  handleBeforeSendHeaders,
  { urls: VIDEO_REQUEST_PATTERNS },
  ["requestHeaders", "extraHeaders"],
);

// Response headers for video detection — narrow patterns only
browserApi.webRequest.onHeadersReceived.addListener(handleHeadersReceived, { urls: VIDEO_REQUEST_PATTERNS }, [
  "responseHeaders",
]);

// ── Sender validation helpers ────────────────────────────────────────────

/**
 * Check that the message sender is from an extension page (popup, options, etc.)
 * rather than a web page content script.
 *
 * Blocks compromised content scripts while allowing extension UI pages to
 * invoke sensitive operations (CDM, debugger, recording).
 *
 * @param {Object} sender - The sender from onMessage
 * @returns {boolean}
 */
function isExtensionPageSender(sender) {
  if (!sender || !sender.url) {
    return false;
  }
  // Extension pages have chrome-extension:// or moz-extension:// origins.
  return /^(chrome|moz)-extension:\/\//i.test(sender.url);
}

// ── CDP relay init ───────────────────────────────────────────────────────

cdpRelay.init();

// ── Recording progress updates ───────────────────────────────────────────

recording.startRecordingProgressUpdates(recording.getActiveRecordingsRef());

// ── MSE segment forwarding ───────────────────────────────────────────────

function senderTabId(message, sender) {
  return message.tabId || (sender.tab && sender.tab.id);
}

// ── Message handler: MSE captured segments ───────────────────────────────

messageRouter.handle("mseCapturedSegments", async (message, sender) => {
  const result = recording.handleMseCapturedSegments(message, sender, senderTabId);
  if (result) {
    notifyPopup({
      type: "mseCaptureComplete",
      tabId: result.tabId,
      totalSegments: result.totalSegments,
      streams: result.streams,
    });
  }

  const tabId = senderTabId(message, sender);
  if (tabId && Array.isArray(message.segments) && message.segments.length > 0) {
    const captureStatus = segmentCapture.getStatus(tabId);
    if (captureStatus.active) {
      segmentCapture.addSegments(tabId, message.segments);
    }
  }
  return { ok: true };
});

// ── Message handler: content detected videos ─────────────────────────────

messageRouter.handle("contentDetectedVideos", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const videos = Array.isArray(message.videos) ? message.videos : [];

  if (sender?.tab?.title) {
    pageTitlesByTab[tabId] = sender.tab.title;
  }

  await tabState.load();
  let changed = false;

  for (const video of videos) {
    const added = await addDetectedVideo(
      tabId,
      {
        ...video,
        source: video.source || "dom",
        pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
        frameUrl: video.frameUrl || sender.url || "",
      },
      false,
    );
    if (added) {
      changed = true;
    }
  }

  if (changed) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  return { ok: true };
});

// ── Message handler: get videos ──────────────────────────────────────────

messageRouter.handle("getVideos", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    videos: await getTabVideos(tabId),
    downloads: await getTabDownloads(tabId),
    settings: tabState.getSettings(),
  };
});

// ── Message handler: download video ──────────────────────────────────────

messageRouter.handle("downloadVideo", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    ...(await startNativeDownload(
      tabId,
      message.videoId,
      message.formatId || "best",
      message.variantId || "",
      message.backend || "auto",
    )),
  };
});

// ── Message handlers: download control ───────────────────────────────────

messageRouter.handle("pauseDownload", async (message) => {
  return { ok: true, ...controlActiveDownload(message.jobId, "pause") };
});

messageRouter.handle("resumeDownload", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return { ok: true, ...(await resumeDownload(tabId, message.jobId)) };
});

messageRouter.handle("cancelDownload", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return { ok: true, ...(await cancelDownload(tabId, message.jobId)) };
});

messageRouter.handle("retryDownload", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return { ok: true, ...(await retryDownload(tabId, message.jobId)) };
});

messageRouter.handle("openDownloadedFile", async (message) => {
  return { ok: true, ...(await openDownloadedPath(message.jobId, "openFile")) };
});

messageRouter.handle("showDownloadedFile", async (message) => {
  return { ok: true, ...(await openDownloadedPath(message.jobId, "showFile")) };
});

messageRouter.handle("removeDownload", async (message) => {
  return { ok: true, ...(await removeDownload(message.jobId)) };
});

messageRouter.handle("clearDownloads", async () => {
  return { ok: true, ...(await clearDownloads()) };
});

// ── Message handler: get video formats ───────────────────────────────────

messageRouter.handle("getVideoFormats", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const videos = await getTabVideos(tabId);
  const video = videos.find(
    (item) => item.id === message.videoId || variantsForVideo(item).some((variant) => variant.id === message.videoId),
  );
  if (!video) {
    throw new Error("That video URL is no longer in the detected list.");
  }
  return {
    ok: true,
    ...(await getNativeFormatsForVideo(
      tabId,
      video,
      getVisibleVideosForTab,
      notifyPopup,
      nativeRequest,
      addDetectedVideo,
    )),
  };
});

// ── Message handler: download URL ────────────────────────────────────────

messageRouter.handle("downloadUrl", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    ...(await startNativeDownloadForUrl(tabId, {
      ...(message.video || {}),
      pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
      frameUrl: sender.url || "",
      formatId: message.formatId || "best",
      variantId: message.variantId || "",
    })),
  };
});

// ── Message handler: download best video ─────────────────────────────────

messageRouter.handle("downloadBestVideo", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
  };
});

// ── Message handler: get formats for URL ─────────────────────────────────

messageRouter.handle("getFormatsForUrl", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const video = await addDetectedVideo(tabId, {
    ...(message.video || {}),
    pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
    frameUrl: sender.url || "",
    source: (message.video && message.video.source) || "overlay",
  });
  if (!video) {
    throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
  }
  const groupedVideo = findGroupedVideoForVariant(tabId, video, getVisibleVideosForTab) || video;
  return {
    ok: true,
    videoId: groupedVideo.id,
    ...(await getNativeFormatsForVideo(tabId, groupedVideo, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
  };
});

// ── Message handler: get best video formats ──────────────────────────────

messageRouter.handle("getBestVideoFormats", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const video = await getBestDownloadableVideo(tabId);
  return {
    ok: true,
    videoId: video.id,
    ...(await getNativeFormatsForVideo(tabId, video, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
  };
});

// ── Message handler: save/get settings ───────────────────────────────────

messageRouter.handle("saveSettings", async (message) => {
  await tabState.updateSettings(message.settings || {});
  return { ok: true, settings: tabState.getSettings() };
});

messageRouter.handle("getSettings", async () => {
  return { ok: true, settings: tabState.getSettings() };
});

// ── Folder picker (multiple aliases) ─────────────────────────────────────

function chooseFolderHandler() {
  return chooseDownloadFolder().then((result) => ({ ok: true, ...result }));
}

messageRouter.handle("chooseDownloadFolder", chooseFolderHandler);
messageRouter.handle("chooseFolder", chooseFolderHandler);
messageRouter.handle("selectDownloadFolder", chooseFolderHandler);
messageRouter.handle("browseDownloadFolder", chooseFolderHandler);

// ── Open popup ───────────────────────────────────────────────────────────

messageRouter.handle("openPopup", async () => {
  await browserApi.action.openPopup();
  return { ok: true };
});

// ── Magnet download ──────────────────────────────────────────────────────

messageRouter.handle("downloadMagnet", async (message) => {
  return recording.downloadMagnet(message, notifyPopup, nativeRequest, () => {
    return browserApi.runtime.connectNative(HOST_NAME);
  });
});

// ── Recording handlers ───────────────────────────────────────────────────

messageRouter.handle("startRecording", async (message) => {
  const tabId = Number(message.tabId) || 0;
  const options = message.options || {};
  const jobId = options.jobId || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  if (!tabId) {
    return { ok: false, error: "No tab ID provided for recording." };
  }

  const recordingJob = {
    id: jobId,
    tabId,
    title: options.title || "Screen recording",
    format: "RECORDING",
    status: "connecting",
    message: "Starting screen recording...",
    url: options.url || "",
    videoId: jobId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: "recording",
    isRecording: true,
    recordingDuration: 0,
    recordingSizeBytes: 0,
    recordingFps: 0,
    recordingDroppedFrames: 0,
    percent: null,
  };

  tabState.updateDownload(jobId, recordingJob);

  try {
    const nativeResponse = await nativeRequest(
      {
        type: "startRecording",
        id: `rec_start_${Date.now()}`,
        tabId,
        jobId,
        outputPath: "",
        quality: "best",
      },
      15000,
    );

    if (nativeResponse && nativeResponse.ok) {
      recording.addActiveRecording(jobId, tabId, nativeResponse.filepath || "");
      tabState.updateDownload(jobId, {
        status: "running",
        message: nativeResponse.message || "Recording started.",
        filepath: nativeResponse.filepath || "",
      });
      return { ok: true, jobId };
    }

    recording.addActiveRecording(jobId, tabId, "");
    tabState.updateDownload(jobId, {
      status: "running",
      message: "Recording... (native capture not yet available, placeholder mode)",
    });
    return { ok: true, jobId };
  } catch (error) {
    tabState.updateDownload(jobId, {
      status: "running",
      message: "Recording... (native capture not yet available, placeholder mode)",
    });
    return { ok: true, jobId };
  }
});

messageRouter.handle("stopRecording", async (message) => {
  const jobId = message.jobId;
  const rec = recording.removeActiveRecording(jobId);

  if (!rec) {
    return { ok: false, error: "Recording job not found." };
  }

  try {
    await nativeRequest(
      {
        type: "stopRecording",
        id: `rec_stop_${Date.now()}`,
        jobId,
      },
      10000,
    );
  } catch (_error) {}

  const durationSec = Math.round((Date.now() - rec.startTime) / 1000);
  const durationStr = recording.formatDuration(durationSec);

  tabState.updateDownload(jobId, {
    status: "done",
    stage: "done",
    isRecording: false,
    recordingDuration: durationSec,
    message: `Recording complete. Duration: ${durationStr}.`,
    percent: 100,
  });

  return { ok: true, jobId };
});

messageRouter.handle("getRecordingStatus", async () => {
  const jobs = recording.getActiveRecordings().map((rec) => ({
    jobId: rec.jobId,
    tabId: rec.tabId,
    elapsedSec: rec.elapsedSec,
    elapsedFormatted: rec.elapsedFormatted,
  }));
  return { ok: true, activeRecordings: jobs };
});

// ── CDP relay handlers ───────────────────────────────────────────────────

messageRouter.handle("cdpCommand", async (message) => {
  return cdpRelay.handleCdpCommand(message);
});

messageRouter.handle("cdpAttach", async (message) => {
  return cdpRelay.handleCdpAttach(message);
});

messageRouter.handle("cdpDetach", async (message) => {
  return cdpRelay.handleCdpDetach(message);
});

messageRouter.handle("cdpStatus", async () => {
  return cdpRelay.handleCdpStatus();
});

// ── CDP extraction handler ───────────────────────────────────────────────

messageRouter.handle("cdpExtractVideos", async (message, sender) => {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, videos: [], error: "No tabId provided for CDP extraction." };
  }

  const extractionResult = await cdpExtraction.extractVideosFromTab(tabId, {
    timeout: message.timeout || 15000,
  });

  const pageUrl = message.pageUrl || sender?.tab?.url || "";
  let integratedCount = 0;

  if (extractionResult.ok && Array.isArray(extractionResult.videos)) {
    for (const video of extractionResult.videos) {
      if (!video.url) continue;
      if (video.url.startsWith("blob:") || video.url.startsWith("data:")) continue;

      const added = await addDetectedVideo(
        tabId,
        {
          url: video.url,
          format: detectFormat(video.url, video.type || ""),
          source: "cdp-" + (video.source || "extraction"),
          pageUrl: pageUrl,
          contentType: video.type || "",
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          duration: Number(video.duration) || 0,
        },
        false,
      );
      if (added) integratedCount++;
    }
  }

  return {
    ok: true,
    videos: extractionResult.videos || [],
    tabVideos: getVisibleVideosForTab(tabId),
    integrated: integratedCount,
    error: extractionResult.error || "",
  };
});

// ── CDM capture handlers (sender-restricted) ─────────────────────────────

messageRouter.handle("startCdmCapture", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may start CDM capture." };
  }
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "No tabId provided for CDM capture." };
  }
  return cdmNetworkIntercept.initIntercept(tabId);
});

messageRouter.handle("stopCdmCapture", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may stop CDM capture." };
  }
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "No tabId provided." };
  }
  const exchanges = cdmNetworkIntercept.getCapturedExchanges();
  const result = await cdmNetworkIntercept.stopIntercept(tabId);
  if (result.ok) {
    cdmNetworkIntercept.clearCapturedExchanges();
  }
  return { ok: result.ok, exchanges, error: result.error };
});

messageRouter.handle("getCdmCaptures", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may access CDM captures." };
  }
  return {
    ok: true,
    exchanges: cdmNetworkIntercept.getCapturedExchanges(),
    status: cdmNetworkIntercept.getStatus(),
  };
});

messageRouter.handle("cdmStatus", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized." };
  }
  return { ok: true, status: cdmNetworkIntercept.getStatus() };
});

// ── CDM key extraction pipeline (sender-restricted) ───────────────────────

messageRouter.handle("cdmInit", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may initialize CDM." };
  }
  const cdmPath = message.cdmPath || "";
  if (!cdmPath) {
    return { ok: false, error: "cdmPath is required." };
  }
  try {
    const response = await nativeRequest({ type: "cdmInit", id: `cdm_init_${Date.now()}`, cdmPath }, 30000);
    return {
      ok: response?.ok !== false,
      cdmVersion: response?.cdmVersion || "",
      l1Only: Boolean(response?.l1Only),
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `CDM init failed: ${error.message || error}` };
  }
});

messageRouter.handle("extractCdmKeys", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may extract CDM keys." };
  }
  const exchange = message.exchange;
  if (!exchange || !exchange.responseBody) {
    return { ok: false, error: "A completed license exchange with responseBody is required." };
  }

  const sessionId = `${exchange.tabId || 0}_${exchange.requestId || Date.now()}`;

  try {
    const response = await nativeRequest(
      {
        type: "extractKeys",
        id: `extract_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        sessionId,
        responseB64: exchange.responseBody,
        challengeB64: exchange.postData || "",
        initDataB64: "",
      },
      60000,
    );

    return {
      ok: response?.ok !== false,
      sessionId: response?.sessionId || sessionId,
      keys: response?.keys || [],
      l1Only: Boolean(response?.l1Only),
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `Key extraction failed: ${error.message || error}` };
  }
});

messageRouter.handle("decryptCdmSegments", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may decrypt segments." };
  }
  if (!message.jobId) {
    return { ok: false, error: "jobId is required." };
  }
  if (!Array.isArray(message.segments) || !message.segments.length) {
    return { ok: false, error: "At least one encrypted segment is required." };
  }
  if (!Array.isArray(message.keys) || !message.keys.length) {
    return { ok: false, error: "At least one decryption key is required." };
  }

  try {
    const response = await nativeRequest(
      {
        type: "decryptSegments",
        id: `decrypt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        jobId: message.jobId,
        segments: message.segments,
        keys: message.keys,
        outputDir: message.outputDir || "",
      },
      120000,
    );

    return {
      ok: response?.ok !== false,
      jobId: response?.jobId || message.jobId,
      decrypted: response?.decrypted || 0,
      segmentPaths: response?.segmentPaths || [],
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `Segment decryption failed: ${error.message || error}` };
  }
});

messageRouter.handle("assembleDecryptedSegments", async (message, sender) => {
  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: "Unauthorized: only the extension popup may assemble segments." };
  }
  if (!message.jobId) {
    return { ok: false, error: "jobId is required." };
  }
  if (!Array.isArray(message.filePaths) || !message.filePaths.length) {
    return { ok: false, error: "At least one segment file path is required." };
  }

  try {
    const response = await nativeRequest(
      {
        type: "assembleSegments",
        id: `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        jobId: message.jobId,
        filePaths: message.filePaths,
        outputPath: message.outputPath || "",
      },
      120000,
    );

    return {
      ok: response?.ok !== false,
      jobId: response?.jobId || message.jobId,
      filePath: response?.filePath || "",
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `Segment assembly failed: ${error.message || error}` };
  }
});

// ── Segment capture handlers ─────────────────────────────────────────────

messageRouter.handle("startSegmentCapture", async (message) => {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "No tabId provided for segment capture." };
  }
  return segmentCapture.startCapture(tabId, {
    title: message.title || "Video",
    url: message.url || "",
  });
});

messageRouter.handle("stopSegmentCapture", async (message) => {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "No tabId provided." };
  }
  return segmentCapture.stopCapture(tabId);
});

messageRouter.handle("getSegmentCaptureStatus", async (message) => {
  const tabId = Number(message.tabId) || 0;
  return { ok: true, status: segmentCapture.getStatus(tabId) };
});

messageRouter.handle("assembleSegments", async (message) => {
  const segments = Array.isArray(message.segments) ? message.segments : [];
  if (!segments.length) {
    return { ok: true, jobId: message.jobId || "", warning: "No segments to assemble." };
  }

  const requestId = `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const response = await nativeRequest(
      {
        type: "assembleSegments",
        id: requestId,
        tabId: message.tabId || 0,
        jobId: message.jobId || "",
        title: message.title || "Video",
        url: message.url || "",
        streams: message.streams || {},
        segments: segments.map((s) => ({
          streamId: s.streamId || "unknown",
          mimeType: s.mimeType || "",
          data: s.data || "",
          index: typeof s.index === "number" ? s.index : 0,
          timestamp: typeof s.timestamp === "number" ? s.timestamp : 0,
          isLast: Boolean(s.isLast),
        })),
      },
      120000,
    );
    return {
      ok: response && response.ok !== false,
      jobId: message.jobId || "",
      filepath: response?.filepath || "",
      error: response?.error || "",
    };
  } catch (error) {
    return {
      ok: false,
      jobId: message.jobId || "",
      error: `Native host assembly failed: ${error.message || error}`,
    };
  }
});

// ── Batch/playlist handlers ──────────────────────────────────────────────

function initBatchOrchestration() {
  batchOrchestration.init({
    nativeRequest,
    startNativeDownload: (tabId, videoId, formatId, variantId, backend) =>
      getDownloadOrchestration().startNativeDownload(tabId, videoId, formatId, variantId, backend),
    startNativeDownloadForUrl: (tabId, input) =>
      getDownloadOrchestration().startNativeDownloadForUrl(tabId, input),
    addDetectedVideo,
    notifyPopup,
    normalizeUrl,
    getTabVideos,
    updateDownload: (jobId, patch) => updateDownload(jobId, patch, notifyPopup),
    nativeRequestHeadersForVideo,
    userAgent: navigator.userAgent || "",
  });
}

initBatchOrchestration();

messageRouter.handle("enumeratePlaylist", async (message, sender) => {
  const url = String(message.url || "").trim();
  if (!url) {
    return { ok: false, error: "No URL provided for playlist enumeration." };
  }
  const pageUrl = message.pageUrl || (sender.tab && sender.tab.url) || url;
  return batchOrchestration.enumeratePlaylist(url, { pageUrl });
});

messageRouter.handle("batchDownload", async (message, sender) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);
  const videos = Array.isArray(message.videos) ? message.videos : [];
  if (!tabId) {
    return { ok: false, error: "No tab ID provided for batch download." };
  }
  return batchOrchestration.startBatchDownload(tabId, videos);
});

messageRouter.handle("batchDownloadSelected", async (message, sender) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);
  const videoIds = Array.isArray(message.videoIds) ? message.videoIds : [];
  if (!tabId) {
    return { ok: false, error: "No tab ID provided." };
  }
  if (!videoIds.length) {
    return { ok: false, error: "No videos selected for batch download." };
  }
  return batchOrchestration.startSelectedDownload(tabId, videoIds);
});

messageRouter.handle("batchStatus", async () => {
  return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
});

messageRouter.handle("batchPause", async () => {
  batchOrchestration.pauseBatch();
  return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
});

messageRouter.handle("batchResume", async () => {
  batchOrchestration.resumeBatch();
  return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
});

messageRouter.handle("batchCancel", async () => {
  batchOrchestration.cancelBatch();
  return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
});

// ── Torrent handlers ─────────────────────────────────────────────────────

messageRouter.handle("chooseTorrentFile", async () => {
  const requestId = `torrentfile_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const response = await nativeRequest(
    {
      type: "chooseTorrentFile",
      id: requestId,
      initialFolder: tabState.getSettings().downloadFolder || "",
    },
    600000,
  );

  const selectedPath = String(response.path || "").trim();
  if (response.canceled || !selectedPath) {
    return { ok: true, canceled: true };
  }
  return { ok: true, path: selectedPath };
});

messageRouter.handle("downloadTorrent", async (message) => {
  return recording.downloadTorrent(message, () => {
    return browserApi.runtime.connectNative(HOST_NAME);
  });
});

// ── Download history sync handlers ───────────────────────────────────────

messageRouter.handle("getDownloadSyncHistory", async () => {
  const history = downloadSync.getSyncedHistory();
  const syncInfo = downloadSync.getSyncInfo();
  return { ok: true, history, syncInfo };
});

messageRouter.handle("setDownloadSyncEnabled", async (message) => {
  const enabled = message.enabled !== false;
  downloadSync.setSyncEnabled(enabled);
  const currentSettings = tabState.getSettings();
  await tabState.setSettings(Object.assign({}, currentSettings, { downloadSyncEnabled: enabled }));
  return { ok: true, enabled };
});

messageRouter.handle("clearDownloadSyncHistory", async () => {
  downloadSync.clearSyncedHistory();
  await tabState.persistSyncHistoryToStorage();
  return { ok: true };
});

// ── Helper status ────────────────────────────────────────────────────────

messageRouter.handle("pingNativeHost", async () => {
  return pingNativeHost();
});

messageRouter.handle("getHelperStatus", async () => {
  // If cache is stale (> 30s), refresh it before returning
  const age = Date.now() - cachedHelperStatus.lastChecked;
  if (age > HELPER_PING_INTERVAL_MS || !cachedHelperStatus.lastChecked) {
    await refreshCachedHelperStatus(notifyPopup, HOST_NAME);
  }

  return {
    ok: true,
    connected: cachedHelperStatus.connected,
    version: cachedHelperStatus.version,
    dependencies: { ...cachedHelperStatus.dependencies },
    lastChecked: cachedHelperStatus.lastChecked,
    error: cachedHelperStatus.error || "",
  };
});

// ── Rescan / clear tab ───────────────────────────────────────────────────

messageRouter.handle("rescanTab", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  await clearTab(tabId);

  const contentResponse = await browserApi.tabs.sendMessage(tabId, { type: "scanNow" });

  if (contentResponse && contentResponse.ok && Array.isArray(contentResponse.videos)) {
    for (const video of contentResponse.videos) {
      await addDetectedVideo(
        tabId,
        {
          ...video,
          source: video.source || "dom",
          pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
          frameUrl: video.frameUrl || sender.url || "",
        },
        false,
      );
    }
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }

  await browserApi.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => window.dispatchEvent(new CustomEvent("qwin-video-scan-now")),
  });
  return { ok: true };
});

messageRouter.handle("clearVideos", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  await clearTab(tabId);
  return { ok: true };
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

// ── Initialize ───────────────────────────────────────────────────────────

tabState.load();

// Start filter list integration
filterIntegration.initFilterIntegration();

// Start periodic helper ping (pass notifyPopup for status change broadcasts)
startHelperPing(notifyPopup, HOST_NAME);
