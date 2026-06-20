"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as mediaCandidates from "../shared/media_candidates.js";
import * as videoFilters from "../shared/video_filters.js";
import * as downloadState from "./download_state.js";
import { nativeRequest as nativeRequestFn } from "./native_requests.js";
import * as downloadFallbacks from "./download_fallbacks.js";
import * as tabState from "./tab_state.js";
import * as cdpRelay from "./cdp_relay.js";
import { create as createMessageRouter } from "./message_router.js";
import { create as createDownloadOrchestration } from "./download_orchestration.js";

// Raw API object for native_requests.js which expects it directly.
const api = browserApi.raw;
const messageRouter = createMessageRouter();
const downloadOrchestrationModule = { create: createDownloadOrchestration };
const nativeRequests = { nativeRequest: nativeRequestFn };

const HOST_NAME = "com.qwin.video_downloader";
const MAX_VIDEOS_PER_TAB = 100;
// Regex patterns — use the canonical versions exported from media_candidates.js.
const VIDEO_EXTENSION_RE = mediaCandidates.VIDEO_EXTENSION_RE;
const HLS_RE = mediaCandidates.HLS_RE;
const DASH_RE = mediaCandidates.DASH_RE;
const DIRECT_VIDEO_EXTENSION_RE = mediaCandidates.DIRECT_VIDEO_EXTENSION_RE;
const CDN_HINT_RE = mediaCandidates.CDN_HINT_RE;
const SIZE_PROBE_TIMEOUT_MS = 8000;
const SIZE_PROBE_LIMIT_PER_GROUP = 6;
const MAX_CAPTURED_REQUEST_HEADERS = 250;
const NATIVE_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "x-requested-with",
]);
const BLOCKING_DOWNLOAD_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

// State is now owned by tabState module.
const downloadPortsById = {};
const sizeProbePromises = {};
const requestHeadersByUrl = {};
const pageTitlesByTab = {};

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return String(url || "").split("#")[0];
  }
}

function normalizeHeaderName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function canonicalHeaderName(name) {
  return normalizeHeaderName(name)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("-");
}

function cleanHeaderValue(value) {
  const text = String(value || "")
    .replace(/[\r\n]/g, " ")
    .trim();
  return text.length > 8192 ? text.slice(0, 8192) : text;
}

function addNativeHeader(headerMap, name, value, overwrite = false) {
  const normalizedName = normalizeHeaderName(name);
  const cleanedValue = cleanHeaderValue(value);
  if (!normalizedName || !cleanedValue || !NATIVE_HEADER_NAMES.has(normalizedName)) {
    return;
  }
  if (!overwrite && headerMap.has(normalizedName)) {
    return;
  }
  headerMap.set(normalizedName, {
    name: canonicalHeaderName(normalizedName),
    value: cleanedValue,
  });
}

function capturedNativeHeaders(headers) {
  const headerMap = new Map();
  for (const header of headers || []) {
    addNativeHeader(headerMap, header.name, header.value);
  }
  return Array.from(headerMap.values());
}

function pruneCapturedRequestHeaders() {
  const entries = Object.entries(requestHeadersByUrl);
  if (entries.length <= MAX_CAPTURED_REQUEST_HEADERS) {
    return;
  }

  entries
    .sort((left, right) => Number(left[1].lastSeen || 0) - Number(right[1].lastSeen || 0))
    .slice(0, entries.length - MAX_CAPTURED_REQUEST_HEADERS)
    .forEach(([key]) => {
      delete requestHeadersByUrl[key];
    });
}

function rememberRequestHeaders(details) {
  if (!details || !details.url || videoFilters.isBlockedVideoUrl(details.url)) {
    return;
  }

  const headers = capturedNativeHeaders(details.requestHeaders || []);
  if (!headers.length) {
    return;
  }

  requestHeadersByUrl[normalizeUrl(details.url)] = {
    headers,
    lastSeen: Date.now(),
  };
  pruneCapturedRequestHeaders();
}

function pageOrigin(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch (_error) {
    return "";
  }
}

async function cookieHeaderForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
  } catch (_error) {
    return "";
  }

  const cookies = await browserApi.cookies.getAll({ url });
  return cookies
    .filter((cookie) => cookie && cookie.name)
    .sort((left, right) => String(right.path || "").length - String(left.path || "").length)
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");
}

async function nativeRequestHeadersForVideo(videoUrl, pageUrl) {
  const headerMap = new Map();
  const captured = requestHeadersByUrl[normalizeUrl(videoUrl)] || {};
  for (const header of captured.headers || []) {
    addNativeHeader(headerMap, header.name, header.value);
  }

  if (pageUrl) {
    addNativeHeader(headerMap, "Referer", pageUrl);
    addNativeHeader(headerMap, "Origin", pageOrigin(pageUrl));
  }

  addNativeHeader(headerMap, "Accept", "*/*");
  addNativeHeader(headerMap, "Accept-Language", "en-US,en;q=0.9");

  const cookieHeader = await cookieHeaderForUrl(videoUrl);
  if (cookieHeader) {
    addNativeHeader(headerMap, "Cookie", cookieHeader);
  }

  return Array.from(headerMap.values());
}

function hashId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v_${(hash >>> 0).toString(36)}`;
}

function contentTypeFromHeaders(headers) {
  const header = (headers || []).find((item) => item.name && item.name.toLowerCase() === "content-type");
  return header ? String(header.value || "").toLowerCase() : "";
}

function contentLengthFromHeaders(headers) {
  const header = (headers || []).find((item) => item.name && item.name.toLowerCase() === "content-length");
  const size = header ? Number(header.value) : 0;
  return Number.isFinite(size) && size > 0 ? size : null;
}

function parseContentRangeSize(value) {
  const match = String(value || "").match(/\/(\d+)\s*$/);
  const size = match ? Number(match[1]) : 0;
  return Number.isFinite(size) && size > 0 ? size : null;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function detectFormat(url, contentType = "") {
  return videoFilters.classifyVideoUrl(url, contentType);
}

function isDownloadableUrl(url, contentType = "") {
  return videoFilters.isDownloadableUrl(url, contentType);
}

function isLikelyVideoRequest(url, resourceType, contentType = "") {
  return videoFilters.isLikelyVideoRequest(url, resourceType, contentType);
}

function isPlaylistVideo(video) {
  const format = String(video.format || detectFormat(video.url || "", video.contentType || "")).toUpperCase();
  const contentType = lower(video.contentType);
  return (
    format === "M3U8" ||
    format === "MPD" ||
    HLS_RE.test(video.url || "") ||
    DASH_RE.test(video.url || "") ||
    contentType.includes("mpegurl") ||
    contentType.includes("dash+xml")
  );
}

function canProbeVideoSize(video) {
  if (!video || video.sizeBytes || !isDownloadableUrl(video.url || "", video.contentType || "")) {
    return false;
  }
  if (isPlaylistVideo(video)) {
    return false;
  }
  const contentType = lower(video.contentType);
  return DIRECT_VIDEO_EXTENSION_RE.test(video.url || "") || contentType.startsWith("video/");
}

function sizeFromFetchResponse(response, ranged = false) {
  if (!response || (!response.ok && response.status !== 206)) {
    return null;
  }
  const contentType = lower(response.headers.get("content-type"));
  if (contentType.includes("mpegurl") || contentType.includes("dash+xml") || contentType.includes("image/gif")) {
    return null;
  }

  const rangeSize = parseContentRangeSize(response.headers.get("content-range"));
  if (rangeSize) {
    return rangeSize;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return null;
  }
  if (ranged && response.status === 206 && contentLength <= 1) {
    return null;
  }
  return contentLength;
}

async function fetchSizeProbe(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIZE_PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeVideoSize(video) {
  if (!canProbeVideoSize(video)) {
    return null;
  }

  try {
    const headResponse = await fetchSizeProbe(video.url, { method: "HEAD" });
    const headSize = sizeFromFetchResponse(headResponse);
    if (headSize) {
      return headSize;
    }
  } catch (_error) {
    // Some CDNs disallow HEAD. Try a one-byte request below.
  }

  let rangeResponse = null;
  try {
    const headers = new Headers();
    headers.set("Range", "bytes=0-0");
    rangeResponse = await fetchSizeProbe(video.url, { method: "GET", headers });
    return sizeFromFetchResponse(rangeResponse, true);
  } catch (_error) {
    return null;
  } finally {
    try {
      if (rangeResponse && rangeResponse.body && typeof rangeResponse.body.cancel === "function") {
        await rangeResponse.body.cancel();
      }
    } catch (_error) {}
  }
}

async function updateVideoSize(tabId, videoId, sizeBytes, notify = true) {
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return false;
  }

  const changed = await tabState.patchVideo(tabId, (item) => item.id === videoId && !item.sizeBytes, {
    sizeBytes: size,
  });

  if (!changed) {
    return false;
  }

  if (notify) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  return true;
}

function scheduleVideoSizeProbe(tabId, video) {
  if (!canProbeVideoSize(video)) {
    return;
  }

  const key = `${tabId}:${video.id}`;
  if (sizeProbePromises[key]) {
    return;
  }

  sizeProbePromises[key] = probeVideoSize(video)
    .then((sizeBytes) => updateVideoSize(tabId, video.id, sizeBytes))
    .catch(() => false)
    .finally(() => {
      delete sizeProbePromises[key];
    });
}

function scheduleMissingSizeProbes(tabId) {
  for (const video of tabState.getVideosForTab(tabId)) {
    scheduleVideoSizeProbe(tabId, video);
  }
}

async function addDetectedVideo(tabId, input, notify = true) {
  if (!Number.isInteger(tabId) || tabId < 0 || !input || !input.url) {
    return null;
  }

  await tabState.load();

  const normalizedUrl = normalizeUrl(input.url);
  if (videoFilters.isBlockedVideoUrl(normalizedUrl, input.contentType)) {
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
  const isPlaylist = isPlaylistVideo({ url: normalizedUrl, format, contentType: input.contentType || "" });
  const sizeBytes = isPlaylist ? 0 : Number(input.sizeBytes || input.filesize || 0);

  const inputTitle = input.title || "";
  const currentTitle = current?.title || "";
  const isGenericInput = videoFilters.isGenericTitle(inputTitle);
  const isGenericCurrent = videoFilters.isGenericTitle(currentTitle);

  const urlDerivedTitle = titleFromUrl(normalizedUrl);
  const finalTitle = (function () {
    const candidate =
      (!isGenericInput && inputTitle) || (!isGenericCurrent && currentTitle) || inputTitle || urlDerivedTitle;
    // If the title is generic or came from the URL and looks like a random server hash/token,
    // fall back to the page <title> which is more descriptive (e.g. "My Video - Site").
    if (
      videoFilters.isGenericTitle(candidate) ||
      (candidate === urlDerivedTitle && looksLikeServerToken(urlDerivedTitle))
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
    nextList.sort((left, right) => right.lastSeen - left.lastSeen).slice(0, MAX_VIDEOS_PER_TAB),
  );

  if (notify) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  scheduleVideoSizeProbe(tabId, nextVideo);
  return nextVideo;
}

function looksLikeServerToken(text) {
  // Detect random hash/token filenames from CDN/proxy servers.
  // Heuristic: long (>30 chars), no whitespace, mostly alphanumeric = likely a hash/UID.
  if (!text || text.length <= 30 || /\s/.test(text)) {
    return false;
  }
  const alphaNum = text.replace(/[^a-zA-Z0-9]/g, "").length;
  return alphaNum / text.length > 0.8;
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
    return (
      file
        .replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "")
        .replace(/[_-]+/g, " ")
        .trim() || "Video"
    );
  } catch (_error) {
    return "Video";
  }
}

function notifyPopup(message) {
  browserApi.runtime.sendMessage(message).catch(() => {});
}

async function clearTab(tabId) {
  delete pageTitlesByTab[tabId];
  await tabState.load();
  await tabState.removeTab(tabId);
  notifyPopup({ type: "videoListUpdated", tabId, videos: [] });
}

function getVisibleVideosForTab(tabId) {
  return videoFilters.groupUniqueFullVideos(tabState.getVideosForTab(tabId));
}

async function getTabVideos(tabId) {
  await tabState.load();
  scheduleMissingSizeProbes(tabId);
  return getVisibleVideosForTab(tabId);
}

async function getTabDownloads(_tabId) {
  await tabState.load();
  return Object.values(tabState.getAllDownloads()).sort((left, right) => right.updatedAt - left.updatedAt);
}

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
  rememberRequestHeaders(details);
}

function handleHeadersReceived(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }

  const contentType = contentTypeFromHeaders(details.responseHeaders);
  if (!isLikelyVideoRequest(details.url, details.type, contentType)) {
    return;
  }

  addDetectedVideo(details.tabId, {
    url: details.url,
    format: detectFormat(details.url, contentType),
    source: contentType ? "headers" : "network",
    pageUrl: details.documentUrl || details.initiator || "",
    contentType,
    sizeBytes: contentLengthFromHeaders(details.responseHeaders),
  });
}

function updateDownload(jobId, patch) {
  // Delegate to tabState which handles persistence.
  tabState.updateDownload(jobId, patch);
  const job = tabState.getDownload(jobId);
  notifyPopup({ type: "downloadUpdated", job });
}

function isSegmentedDownloadJob(job) {
  const format = String(job?.format || "").toUpperCase();
  const url = String(job?.url || "");
  return format === "M3U8" || format === "MPD" || HLS_RE.test(url) || DASH_RE.test(url);
}

function normalizeDownloadProgress(jobId, percent) {
  const job = tabState.getDownload(jobId) || {};
  return downloadState.visibleDownloadProgressPercent(job.percent, percent, isSegmentedDownloadJob(job));
}

function downloadProgressMessage(percent) {
  return downloadState.downloadProgressMessage(percent);
}

function cleanProgressText(value) {
  return downloadState.cleanProgressText(value);
}

function resetDownloadProgressDetails() {
  return downloadState.resetDownloadProgressDetails();
}

function progressDetailPatchFromMessage(message) {
  return downloadState.progressDetailPatchFromMessage(message);
}

function downloadFallbackDeps() {
  return {
    addDetectedVideo,
    detectFormat,
    findGroupedVideoForAnyVariant,
    hashId,
    isDownloadableUrl,
    nativeRequest,
    nativeRequestHeadersForVideo,
    normalizeUrl,
    titleFromUrl,
    userAgent: navigator.userAgent || "",
    variantsForVideo,
  };
}

function isHardAccessError(error) {
  return downloadFallbacks.isHardAccessError(error);
}

function isRetryableSourceError(error) {
  return downloadFallbacks.isRetryableSourceError(error);
}

function exhaustedSourcesError(error, attemptedUrls) {
  return downloadFallbacks.exhaustedSourcesError(error, attemptedUrls);
}

function userFriendlyDownloadError(error) {
  return downloadFallbacks.userFriendlyDownloadError(error);
}

async function markVideoUrlUnavailable(tabId, url, error) {
  const targetUrl = normalizeUrl(url);
  const changed = await tabState.patchVideo(
    tabId,
    (item) => normalizeUrl(item.url || "") === targetUrl && item.downloadable !== false,
    {
      downloadable: false,
      blockedReason: String(error || "The server refused this source.").slice(0, 500),
      lastSeen: Date.now(),
    },
  );
  if (changed) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  return changed;
}

function artifactPatchFromMessage(message) {
  const patch = {
    filepath: message.filepath,
    artifactRoot: message.artifactRoot,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value));
}

function cleanupPatchFromMessage(message) {
  const patch = {
    artifactCleanupDeleted: Array.isArray(message.artifactCleanupDeleted) ? message.artifactCleanupDeleted : undefined,
    artifactCleanupMissing: Array.isArray(message.artifactCleanupMissing) ? message.artifactCleanupMissing : undefined,
    artifactCleanupError: cleanProgressText(message.artifactCleanupError),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== ""));
}

function clearedArtifactPatch(cleanupPatch) {
  return Array.isArray(cleanupPatch.artifactCleanupDeleted) && cleanupPatch.artifactCleanupDeleted.length
    ? { filepath: "", artifactRoot: "", artifactPaths: [] }
    : {};
}

function hasDownloadArtifacts(job) {
  return Boolean(job?.filepath || job?.artifactRoot || (Array.isArray(job?.artifactPaths) && job.artifactPaths.length));
}

async function cleanupDownloadArtifacts(jobId, job) {
  if (!hasDownloadArtifacts(job)) {
    return {};
  }

  const requestId = `delete_${jobId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const response = await nativeRequest(
      {
        type: "deleteArtifacts",
        id: requestId,
        path: job.filepath || "",
        artifactRoot: job.artifactRoot || "",
        artifactPaths: job.artifactPaths || [],
        downloadFolder: job.downloadFolder || tabState.getSettings().downloadFolder || "",
      },
      30000,
    );
    return {
      artifactCleanupDeleted: response.deleted || [],
      artifactCleanupMissing: response.missing || [],
    };
  } catch (error) {
    return {
      artifactCleanupError: cleanProgressText(error && error.message ? error.message : String(error)),
    };
  }
}

function variantsForVideo(video) {
  return Array.isArray(video.variants) && video.variants.length ? video.variants : [video];
}

function preferredNativeVideo(video) {
  const variants = variantsForVideo(video);
  return (
    variants.find((variant) => ["M3U8", "MPD"].includes(String(variant.format || "").toUpperCase())) ||
    variants[0] ||
    video
  );
}

function findGroupedVideoForAnyVariant(tabId, video) {
  const ids = new Set();
  if (video && video.id) {
    ids.add(video.id);
  }
  if (video && video.groupId) {
    ids.add(video.groupId);
  }
  for (const variant of variantsForVideo(video)) {
    if (variant && variant.id) {
      ids.add(variant.id);
    }
  }

  return getVisibleVideosForTab(tabId).find((item) => {
    if (ids.has(item.id)) {
      return true;
    }
    return variantsForVideo(item).some((variant) => ids.has(variant.id));
  });
}

function findVariant(video, variantId) {
  if (!variantId) {
    return preferredNativeVideo(video);
  }
  return variantsForVideo(video).find((variant) => variant.id === variantId) || null;
}

function downloadableVariants(video, attemptedUrls = new Set()) {
  return downloadFallbacks.downloadableVariants(video, attemptedUrls, downloadFallbackDeps());
}

function isExtractorPageVideo(video) {
  return downloadFallbacks.isExtractorPageVideo(video);
}

function pageFallbackVideoForSource(video, attemptedUrls = new Set()) {
  return downloadFallbacks.pageFallbackVideoForSource(video, attemptedUrls, downloadFallbackDeps());
}

async function resolveMediaCandidatesForSource(tabId, sourceVideo, attemptedUrls = new Set()) {
  return downloadFallbacks.resolveMediaCandidatesForSource(tabId, sourceVideo, attemptedUrls, downloadFallbackDeps());
}

async function fallbackVideoForDownload(tabId, failedVideo, attemptedUrls) {
  return downloadFallbacks.fallbackVideoForDownload(tabId, failedVideo, attemptedUrls, downloadFallbackDeps());
}

function downloadOrchestrationDeps() {
  return {
    api,
    artifactPatchFromMessage,
    blockingDownloadStatuses: BLOCKING_DOWNLOAD_STATUSES,
    callTabsQuery: browserApi.tabs.query,
    cleanupDownloadArtifacts,
    cleanupPatchFromMessage,
    clearedArtifactPatch,
    detectFormat,
    downloadPortsById,
    downloadProgressMessage,
    ensureStateLoaded: tabState.load,
    exhaustedSourcesError,
    fallbackVideoForDownload,
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
    pageFallbackVideoForSource,
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
    titleFromUrl,
    updateDownload,
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
function nativeRequest(payload, timeoutMs = 60000) {
  return nativeRequests.nativeRequest(api, HOST_NAME, payload, timeoutMs);
}

function sourceHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function sourceText(video) {
  if (video.source === "youtube-page" || String(video.format || "").toUpperCase() === "YOUTUBE") {
    return "YouTube full video";
  }
  if (video.source === "manual-url" || String(video.format || "").toUpperCase() === "PAGE") {
    return "Manual link";
  }
  if (video.source === "music-page") {
    return [sourceHost(video.url), "music"].filter(Boolean).join(" / ");
  }
  return [video.source || "detected", sourceHost(video.url)].filter(Boolean).join(" / ");
}

function detectedVariantOption(variant) {
  const height = Number(variant.height || 0);
  const width = Number(variant.width || 0);
  const ext = videoFilters.displayVideoFormat(variant);
  const quality = height ? `${height}p` : width ? `${width}w` : ext;
  return {
    id: `variant:${variant.id}`,
    formatId: "best",
    variantId: variant.id,
    backend: variant.backend || "auto",
    fallbackReason: variant.fallbackReason || "",
    optionType: "detected-source",
    label: `${quality} ${ext}`.trim(),
    ext,
    height: height || null,
    width: width || null,
    tbr: variant.tbr || variant.bitrate || null,
    bitrate: variant.bitrate || variant.tbr || null,
    size: variant.size || videoFilters.displayVideoSize(variant),
    sizeBytes: variant.sizeBytes || null,
    note: "Detected source",
    source: sourceText(variant),
    sourceUrl: variant.url,
  };
}

function normalizeNativeFormatOption(format, video) {
  const ext = format.ext || (format.id === "best" ? "mp4" : "");
  return {
    ...format,
    id: format.id || "best",
    formatId: format.id || "best",
    variantId: video.source === "page-fallback" ? video.id || "" : "",
    backend: format.backend || video.backend || "auto",
    fallbackReason: format.fallbackReason || "",
    optionType: "native-format",
    ext,
    source: format.source || `yt-dlp / ${sourceHost(video.url) || "detected source"}`,
  };
}

function findGroupedVideoForVariant(tabId, variant) {
  return getVisibleVideosForTab(tabId).find((video) => variantsForVideo(video).some((item) => item.id === variant.id));
}

async function updateGroupedTitle(tabId, video, title) {
  if (!title || videoFilters.isGenericTitle(title)) {
    return;
  }

  const variantIds = new Set(variantsForVideo(video).map((variant) => variant.id));
  await tabState.mutateVideos(tabId, function (list) {
    return list.map((item) => (variantIds.has(item.id) ? Object.assign({}, item, { title: title }) : item));
  });
  notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
}

async function ensureComparisonSizes(tabId, video) {
  const variantsToProbe = variantsForVideo(video)
    .filter((variant) => canProbeVideoSize(variant))
    .slice(0, SIZE_PROBE_LIMIT_PER_GROUP);

  if (!variantsToProbe.length) {
    return video;
  }

  const results = await Promise.all(
    variantsToProbe.map(async (variant) => ({
      id: variant.id,
      sizeBytes: await probeVideoSize(variant),
    })),
  );

  let changed = false;
  for (const result of results) {
    if (result.sizeBytes) {
      changed = (await updateVideoSize(tabId, result.id, result.sizeBytes, false)) || changed;
    }
  }

  if (changed) {
    await tabState.persistVideos();
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    return findGroupedVideoForVariant(tabId, variantsForVideo(video)[0]) || video;
  }

  return video;
}

async function requestNativeFormats(video) {
  const requestId = `formats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const currentSettings = tabState.getSettings();
  return nativeRequest({
    type: "formats",
    id: requestId,
    url: video.url,
    pageUrl: video.pageUrl || "",
    userAgent: navigator.userAgent || "",
    requestHeaders: await nativeRequestHeadersForVideo(video.url, video.pageUrl || ""),
    musicMode: currentSettings.musicMode || false,
    audioFormat: currentSettings.audioFormat || "mp3",
  });
}

async function notifyContentStatus(tabId, text) {
  if (!tabId) return;
  await browserApi.tabs.sendMessage(tabId, { type: "updateLoadingStatus", text });
}

async function getNativeFormatsForVideo(tabId, video) {
  await tabState.load();

  // Start size probing in background but don't block the main yt-dlp call immediately.
  // We only wait for it if we truly have nothing else to show.
  const sizeProbePromise = ensureComparisonSizes(tabId, video);

  const lookupVideo = preferredNativeVideo(video);
  let formatLookupVideo = lookupVideo;
  let response = null;
  let nativeError = "";
  let firstNativeError = "";

  await notifyContentStatus(tabId, "Checking link with yt-dlp...");
  try {
    response = await requestNativeFormats(formatLookupVideo);
  } catch (error) {
    nativeError = error.message || String(error);
    firstNativeError = nativeError;
    const pageFallback = isRetryableSourceError(nativeError)
      ? pageFallbackVideoForSource(lookupVideo, new Set([normalizeUrl(lookupVideo.url || "")]))
      : null;
    if (pageFallback) {
      await notifyContentStatus(tabId, "Checking page fallback...");
      try {
        response = await requestNativeFormats(pageFallback);
        formatLookupVideo =
          (await addDetectedVideo(tabId, {
            ...pageFallback,
            title: pageFallback.title || lookupVideo.title || video.title,
            duration: pageFallback.duration || lookupVideo.duration || video.duration,
            width: pageFallback.width || lookupVideo.width || video.width,
            height: pageFallback.height || lookupVideo.height || video.height,
            bitrate: pageFallback.bitrate || lookupVideo.bitrate || video.bitrate,
            thumbnailUrl: pageFallback.thumbnailUrl || lookupVideo.thumbnailUrl || video.thumbnailUrl,
            downloadable: true,
          })) || pageFallback;
        nativeError = "";
      } catch (pageError) {
        nativeError = pageError.message || String(pageError);
      }
    }
    if (!response && isRetryableSourceError(nativeError)) {
      const resolvedCandidates = await resolveMediaCandidatesForSource(
        tabId,
        pageFallback || lookupVideo,
        new Set([normalizeUrl(lookupVideo.url || "")]),
      );
      if (resolvedCandidates.length > 0) {
        await notifyContentStatus(tabId, `Checking ${resolvedCandidates.length} resolved source(s)...`);
      }
      for (const candidate of resolvedCandidates) {
        try {
          response = await requestNativeFormats(candidate);
          formatLookupVideo = candidate;
          nativeError = "";
          break;
        } catch (candidateError) {
          nativeError = candidateError.message || String(candidateError);
        }
      }
    }
  }

  const nativeFormats =
    response && response.formats && response.formats.length
      ? response.formats.map((format) => normalizeNativeFormatOption(format, formatLookupVideo))
      : [];

  const firstHardNativeError = firstNativeError && isHardAccessError(firstNativeError);
  const hardNativeError = nativeError && !nativeFormats.length && isHardAccessError(nativeError);
  if (firstHardNativeError) {
    await markVideoUrlUnavailable(tabId, lookupVideo.url, firstNativeError);
  } else if (hardNativeError) {
    await markVideoUrlUnavailable(tabId, formatLookupVideo.url, nativeError);
  }

  let refreshedVideo = null;
  if (nativeFormats.length > 0) {
    if (response && response.title) {
      await updateGroupedTitle(tabId, formatLookupVideo, response.title);
    }
    refreshedVideo = findGroupedVideoForAnyVariant(tabId, formatLookupVideo) || formatLookupVideo;
  } else {
    // Only block on size probes if we have no native formats and need source formats with sizes.
    const sizedVideo = await sizeProbePromise;
    if (response && response.title) {
      await updateGroupedTitle(tabId, sizedVideo, response.title);
    }
    refreshedVideo =
      findGroupedVideoForAnyVariant(tabId, formatLookupVideo) ||
      findGroupedVideoForAnyVariant(tabId, sizedVideo) ||
      formatLookupVideo ||
      sizedVideo;
  }
  const excludedUrls = new Set();
  if (firstHardNativeError) {
    excludedUrls.add(normalizeUrl(lookupVideo.url || ""));
  }
  if (hardNativeError) {
    excludedUrls.add(normalizeUrl(formatLookupVideo.url || ""));
  }

  const sourceFormats = nativeFormats.length
    ? []
    : isExtractorPageVideo(refreshedVideo)
      ? []
      : downloadableVariants(refreshedVideo, excludedUrls).map(detectedVariantOption);

  if (nativeError && !nativeFormats.length && !sourceFormats.length) {
    const friendlyError = userFriendlyDownloadError(nativeError);
    throw new Error(friendlyError ? `${friendlyError}\n\nTechnical details: ${nativeError}` : nativeError);
  }
  if (!nativeFormats.length && !sourceFormats.length) {
    throw new Error("yt-dlp did not find any downloadable video formats for this link.");
  }

  const formats = nativeFormats.length ? nativeFormats : sourceFormats;
  const pageTitle = refreshedVideo.title || lookupVideo.title || "Video";
  const serverTitle = response && response.title && !videoFilters.isGenericTitle(response.title) ? response.title : "";
  const serverThumbnail = response && response.thumbnailUrl ? response.thumbnailUrl : "";

  if (serverThumbnail) {
    await tabState.patchVideo(
      tabId,
      (item) => item.id === refreshedVideo.id || variantsForVideo(item).some((v) => v.id === refreshedVideo.id),
      { thumbnailUrl: serverThumbnail },
    );
  }

  // The user wants the "site tile" (page title) over "random metadata texts" (generic server titles).
  // If the server provides a GOOD, non-generic title, we should use it as it's most accurate for the stream.
  // Otherwise, fallback to the page title.
  const finalTitle = serverTitle || pageTitle;

  return {
    videoId: refreshedVideo.id || formatLookupVideo.id || lookupVideo.id,
    title: finalTitle,
    thumbnailUrl: serverThumbnail || refreshedVideo.thumbnailUrl || "",
    formats: formats.length
      ? formats
      : [
          normalizeNativeFormatOption(
            { id: "best", label: "Best available MP4", ext: "mp4", note: "Recommended" },
            lookupVideo,
          ),
        ],
    nativeError,
  };
}

function pingNativeHost() {
  return new Promise((resolve) => {
    const id = `ping_${Date.now()}`;
    let settled = false;
    const port = browserApi.runtime.connectNative(HOST_NAME);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      try {
        if (port) {
          port.disconnect();
        }
      } catch (_error) {}
    };

    if (!port) {
      finish({ ok: false, error: "Native messaging is not available in this browser." });
      return;
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Native helper did not respond." });
    }, 5000);

    port.onMessage.addListener((message) => {
      if (message && message.id === id && message.type === "pong") {
        clearTimeout(timeout);
        finish({ ok: true, version: message.version, dependencies: message.dependencies || {} });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
      finish({
        ok: false,
        error: runtimeError || "Native helper is not registered or could not start.",
      });
    });

    port.postMessage({ type: "ping", id });
  });
}

function registerBeforeSendHeadersListener() {
  browserApi.webRequest.onBeforeSendHeaders.addListener(handleBeforeSendHeaders, { urls: ["<all_urls>"] }, [
    "requestHeaders",
    "extraHeaders",
  ]);
}

browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: ["<all_urls>"] });
registerBeforeSendHeadersListener();
browserApi.webRequest.onHeadersReceived.addListener(handleHeadersReceived, { urls: ["<all_urls>"] }, [
  "responseHeaders",
]);

// Initialise CDP relay module (listens for debugger events)
cdpRelay.init();

// --- Message handlers (registered with MessageRouter) ---

function senderTabId(message, sender) {
  return message.tabId || (sender.tab && sender.tab.id);
}

messageRouter.handle("contentDetectedVideos", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const videos = Array.isArray(message.videos) ? message.videos : [];

  // Capture page title from content script sender (most reliable source).
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

messageRouter.handle("getVideos", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    videos: await getTabVideos(tabId),
    downloads: await getTabDownloads(tabId),
    settings: tabState.getSettings(),
  };
});

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

messageRouter.handle("getVideoFormats", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const videos = await getTabVideos(tabId);
  const video = videos.find(
    (item) => item.id === message.videoId || variantsForVideo(item).some((variant) => variant.id === message.videoId),
  );
  if (!video) {
    throw new Error("That video URL is no longer in the detected list.");
  }
  return { ok: true, ...(await getNativeFormatsForVideo(tabId, video)) };
});

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

messageRouter.handle("downloadBestVideo", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  return {
    ok: true,
    ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
  };
});

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
  const groupedVideo = findGroupedVideoForVariant(tabId, video) || video;
  return { ok: true, videoId: groupedVideo.id, ...(await getNativeFormatsForVideo(tabId, groupedVideo)) };
});

messageRouter.handle("getBestVideoFormats", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  const video = await getBestDownloadableVideo(tabId);
  return { ok: true, videoId: video.id, ...(await getNativeFormatsForVideo(tabId, video)) };
});

messageRouter.handle("saveSettings", async (message) => {
  await tabState.updateSettings(message.settings || {});
  return { ok: true, settings: tabState.getSettings() };
});

// Folder picker — multiple message type aliases.
messageRouter.handle("chooseDownloadFolder", async () => {
  return { ok: true, ...(await chooseDownloadFolder()) };
});
messageRouter.handle("chooseFolder", async () => {
  return { ok: true, ...(await chooseDownloadFolder()) };
});
messageRouter.handle("selectDownloadFolder", async () => {
  return { ok: true, ...(await chooseDownloadFolder()) };
});
messageRouter.handle("browseDownloadFolder", async () => {
  return { ok: true, ...(await chooseDownloadFolder()) };
});

messageRouter.handle("getSettings", async () => {
  return { ok: true, settings: tabState.getSettings() };
});

messageRouter.handle("openPopup", async () => {
  await browserApi.action.openPopup();
  return { ok: true };
});

messageRouter.handle("downloadMagnet", async (message) => {
  const magnetUrl = String(message.url || "").trim();
  if (!magnetUrl.startsWith("magnet:?")) {
    throw new Error("Invalid magnet link format.");
  }

  const jobId = `magnet_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const downloadFolder = String(message.downloadFolder || tabState.getSettings().downloadFolder || "");

  tabState.updateDownload(jobId, {
    id: jobId,
    url: magnetUrl,
    title: "Magnet link",
    format: "TORRENT",
    status: "connecting",
    message: "Connecting to BitTorrent network via aria2c...",
    downloadFolder,
    createdAt: Date.now(),
    ...resetDownloadProgressDetails(),
    percent: null,
  });

  let port;
  let finished = false;

  try {
    port = browserApi.runtime.connectNative(HOST_NAME);
  } catch (error) {
    tabState.updateDownload(jobId, {
      status: "error",
      error: `Native messaging is not connected: ${error.message || error}`,
    });
    return { ok: true, jobId };
  }
  downloadPortsById[jobId] = port;

  port.onMessage.addListener((portMessage) => {
    if (!portMessage || portMessage.id !== jobId) {
      return;
    }

    if (portMessage.type === "started") {
      tabState.updateDownload(jobId, { status: "running", message: "Downloading via aria2c..." });
      return;
    }

    if (portMessage.type === "progress") {
      const patch = {
        status: "running",
        stage: portMessage.stage,
        ...artifactPatchFromMessage(portMessage),
        ...progressDetailPatchFromMessage(portMessage),
      };
      if (typeof portMessage.percent === "number") {
        patch.percent = normalizeDownloadProgress(jobId, portMessage.percent);
        patch.message = downloadProgressMessage(patch.percent);
      }
      tabState.updateDownload(jobId, patch);
      return;
    }

    if (portMessage.type === "done") {
      finished = true;
      delete downloadPortsById[jobId];
      tabState.updateDownload(jobId, {
        status: "done",
        percent: 100,
        speed: "",
        eta: "",
        stage: "done",
        filepath: portMessage.filepath || "",
        artifactRoot: portMessage.artifactRoot || "",
        message: portMessage.message || "Magnet download complete.",
      });
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (portMessage.type === "error") {
      finished = true;
      delete downloadPortsById[jobId];
      try {
        port.disconnect();
      } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "error",
        error: portMessage.error || "aria2c failed to download the magnet link.",
        ...artifactPatchFromMessage(portMessage),
      });
      return;
    }

    if (portMessage.type === "canceled") {
      finished = true;
      delete downloadPortsById[jobId];
      try {
        port.disconnect();
      } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "canceled",
        message: portMessage.message || "Download canceled.",
        ...artifactPatchFromMessage(portMessage),
      });
    }
  });

  port.onDisconnect.addListener(() => {
    const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
    delete downloadPortsById[jobId];
    if (!finished) {
      tabState.updateDownload(jobId, {
        status: "error",
        error: runtimeError || "Native messaging helper disconnected while downloading magnet link.",
      });
    }
  });

  port.postMessage({
    type: "magnet",
    id: jobId,
    url: magnetUrl,
    downloadFolder,
  });

  tabState.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper for magnet download.",
  });

  return { ok: true, jobId };
});

// ─── CDP relay ──────────────────────────────────────────────────────────────

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
  const torrentPath = String(message.path || "").trim();
  if (!torrentPath || !/\.torrent$/i.test(torrentPath)) {
    throw new Error("Select a valid .torrent file.");
  }

  const jobId = `torrent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const downloadFolder = String(message.downloadFolder || tabState.getSettings().downloadFolder || "");
  const torrentName = torrentPath.split(/[\\/]/).pop() || "Torrent file";

  tabState.updateDownload(jobId, {
    id: jobId,
    url: torrentPath,
    title: torrentName,
    format: "TORRENT",
    status: "connecting",
    message: "Connecting to BitTorrent network via aria2c...",
    downloadFolder,
    createdAt: Date.now(),
    ...resetDownloadProgressDetails(),
    percent: null,
  });

  let port;
  let finished = false;

  try {
    port = browserApi.runtime.connectNative(HOST_NAME);
  } catch (error) {
    tabState.updateDownload(jobId, {
      status: "error",
      error: `Native messaging is not connected: ${error.message || error}`,
    });
    return { ok: true, jobId };
  }
  downloadPortsById[jobId] = port;

  port.onMessage.addListener((portMessage) => {
    if (!portMessage || portMessage.id !== jobId) {
      return;
    }

    if (portMessage.type === "started") {
      tabState.updateDownload(jobId, { status: "running", message: "Downloading via aria2c..." });
      return;
    }

    if (portMessage.type === "progress") {
      const patch = {
        status: "running",
        stage: portMessage.stage,
        ...artifactPatchFromMessage(portMessage),
        ...progressDetailPatchFromMessage(portMessage),
      };
      if (typeof portMessage.percent === "number") {
        patch.percent = normalizeDownloadProgress(jobId, portMessage.percent);
        patch.message = downloadProgressMessage(patch.percent);
      }
      tabState.updateDownload(jobId, patch);
      return;
    }

    if (portMessage.type === "done") {
      finished = true;
      delete downloadPortsById[jobId];
      tabState.updateDownload(jobId, {
        status: "done",
        percent: 100,
        speed: "",
        eta: "",
        stage: "done",
        filepath: portMessage.filepath || "",
        artifactRoot: portMessage.artifactRoot || "",
        message: portMessage.message || "Torrent download complete.",
      });
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (portMessage.type === "error") {
      finished = true;
      delete downloadPortsById[jobId];
      try {
        port.disconnect();
      } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "error",
        error: portMessage.error || "aria2c failed to download the .torrent file.",
        ...artifactPatchFromMessage(portMessage),
      });
      return;
    }

    if (portMessage.type === "canceled") {
      finished = true;
      delete downloadPortsById[jobId];
      try {
        port.disconnect();
      } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "canceled",
        message: portMessage.message || "Download canceled.",
        ...artifactPatchFromMessage(portMessage),
      });
    }
  });

  port.onDisconnect.addListener(() => {
    const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
    delete downloadPortsById[jobId];
    if (!finished) {
      tabState.updateDownload(jobId, {
        status: "error",
        error: runtimeError || "Native messaging helper disconnected while downloading the .torrent file.",
      });
    }
  });

  port.postMessage({
    type: "torrentFile",
    id: jobId,
    path: torrentPath,
    downloadFolder,
  });

  tabState.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper for .torrent download.",
  });

  return { ok: true, jobId };
});

messageRouter.handle("pingNativeHost", async () => {
  return pingNativeHost();
});

messageRouter.handle("rescanTab", async (message, sender) => {
  const tabId = senderTabId(message, sender);
  await clearTab(tabId);

  // Send scanNow to content script and await the scan results via sendResponse.
  // This ensures videos are re-detected BEFORE returning to the popup,
  // so refresh() immediately after rescanTab gets populated data.
  const contentResponse = await browserApi.tabs.sendMessage(tabId, { type: "scanNow" });

  // Process videos returned from the content scan response.
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

  // Also dispatch into sub-frames (tabs.sendMessage only reaches main frame).
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

// Wire the message router to the runtime.onMessage listener.
browserApi.onMessage((message, sender, sendResponse) => {
  return messageRouter.dispatch(message, sender, sendResponse);
});

// Tab lifecycle — delegated to tabState
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

tabState.load();
