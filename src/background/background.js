"use strict";

if (typeof importScripts === "function" && typeof globalThis.QwinVideoFilters === "undefined") {
  importScripts("../shared/video_filters.js");
}

const api = typeof browser !== "undefined" ? browser : chrome;
const isPromiseApi = typeof browser !== "undefined";
const videoFilters = globalThis.QwinVideoFilters;

const HOST_NAME = "com.qwin.video_downloader";
const STORAGE_VIDEOS = "qwinVideosByTab";
const STORAGE_SETTINGS = "qwinSettings";
const STORAGE_DOWNLOADS = "qwinDownloadsById";
const MAX_VIDEOS_PER_TAB = 100;
const VIDEO_EXTENSION_RE = /\.(mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i;
const HLS_RE = /\.m3u8(?:$|[?#])/i;
const DASH_RE = /\.mpd(?:$|[?#])/i;
const DIRECT_VIDEO_EXTENSION_RE = /\.(mp4|m4v|webm)(?:$|[?#])/i;
const CDN_HINT_RE = /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey)/i;
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
const HARD_ACCESS_ERROR_RE =
  /\bHTTP Error\s+(?:401|403|404|410|451)\b|\b(?:Unauthorized|Forbidden|Gone|Not Found|Unavailable For Legal Reasons)\b/i;

let videosByTab = {};
let downloadsById = {};
let settings = { downloadFolder: "" };
let stateLoaded = false;
let stateLoadPromise = null;
const downloadPortsById = {};
const sizeProbePromises = {};
const requestHeadersByUrl = {};

function callStorageGet(keys) {
  if (isPromiseApi) {
    return api.storage.local.get(keys);
  }
  return new Promise((resolve) => api.storage.local.get(keys, resolve));
}

function callStorageSet(items) {
  if (isPromiseApi) {
    return api.storage.local.set(items);
  }
  return new Promise((resolve) => api.storage.local.set(items, resolve));
}

function callStorageRemove(keys) {
  if (isPromiseApi) {
    return api.storage.local.remove(keys);
  }
  return new Promise((resolve) => api.storage.local.remove(keys, resolve));
}

function callTabsQuery(queryInfo) {
  if (isPromiseApi) {
    return api.tabs.query(queryInfo);
  }
  return new Promise((resolve) => api.tabs.query(queryInfo, resolve));
}

function callCookiesGetAll(details) {
  if (!api.cookies || !api.cookies.getAll) {
    return Promise.resolve([]);
  }
  if (isPromiseApi) {
    return api.cookies.getAll(details).catch(() => []);
  }
  return new Promise((resolve) => {
    try {
      api.cookies.getAll(details, (cookies) => {
        void chrome.runtime.lastError;
        resolve(cookies || []);
      });
    } catch (_error) {
      resolve([]);
    }
  });
}

function cleanStoredVideos(storedVideosByTab) {
  const cleaned = {};
  for (const [tabId, videos] of Object.entries(storedVideosByTab || {})) {
    const list = Array.isArray(videos) ? videos : [];
    cleaned[tabId] = list.filter((video) => video && video.url && !videoFilters.isBlockedVideoUrl(video.url, video.contentType));
  }
  return cleaned;
}

function callTabsSendMessage(tabId, message) {
  if (isPromiseApi) {
    return api.tabs.sendMessage(tabId, message).catch(() => null);
  }
  return new Promise((resolve) => {
    try {
      api.tabs.sendMessage(tabId, message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

function callExecuteScript(details) {
  if (!api.scripting || !api.scripting.executeScript) {
    return Promise.resolve(null);
  }
  if (isPromiseApi) {
    return api.scripting.executeScript(details).catch(() => null);
  }
  return new Promise((resolve) => {
    try {
      api.scripting.executeScript(details, (result) => {
        void chrome.runtime.lastError;
        resolve(result || null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

async function ensureStateLoaded() {
  if (stateLoaded) {
    return;
  }
  if (!stateLoadPromise) {
    stateLoadPromise = callStorageGet([STORAGE_VIDEOS, STORAGE_SETTINGS, STORAGE_DOWNLOADS]).then((items) => {
      videosByTab = cleanStoredVideos(items[STORAGE_VIDEOS] || {});
      settings = { ...settings, ...(items[STORAGE_SETTINGS] || {}) };
      downloadsById = items[STORAGE_DOWNLOADS] || {};
      stateLoaded = true;
      persistVideos();
    });
  }
  await stateLoadPromise;
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
  return String(name || "").trim().toLowerCase();
}

function canonicalHeaderName(name) {
  return normalizeHeaderName(name)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("-");
}

function cleanHeaderValue(value) {
  const text = String(value || "").replace(/[\r\n]/g, " ").trim();
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

  const cookies = await callCookiesGetAll({ url });
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

  const tabKey = String(tabId);
  let changed = false;
  videosByTab[tabKey] = (videosByTab[tabKey] || []).map((item) => {
    if (item.id !== videoId || item.sizeBytes) {
      return item;
    }
    changed = true;
    return { ...item, sizeBytes: size };
  });

  if (!changed) {
    return false;
  }

  await persistVideos();
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
  for (const video of videosByTab[String(tabId)] || []) {
    scheduleVideoSizeProbe(tabId, video);
  }
}

async function addDetectedVideo(tabId, input) {
  if (!Number.isInteger(tabId) || tabId < 0 || !input || !input.url) {
    return null;
  }

  await ensureStateLoaded();

  const normalizedUrl = normalizeUrl(input.url);
  if (videoFilters.isBlockedVideoUrl(normalizedUrl, input.contentType)) {
    return null;
  }

  const format = input.format || detectFormat(normalizedUrl, input.contentType);
  const id = hashId(normalizedUrl);
  const now = Date.now();
  const tabKey = String(tabId);
  const existing = videosByTab[tabKey] || [];
  const current = existing.find((item) => item.id === id);
  const width = Number(input.width || 0);
  const height = Number(input.height || 0);
  const duration = Number(input.duration || 0);
  const bitrate = Number(input.bitrate || input.tbr || 0);
  const isPlaylist = isPlaylistVideo({ url: normalizedUrl, format, contentType: input.contentType || "" });
  const sizeBytes = isPlaylist ? 0 : Number(input.sizeBytes || input.filesize || 0);

  const nextVideo = {
    id,
    url: normalizedUrl,
    format,
    source: input.source || "network",
    title: input.title || current?.title || titleFromUrl(normalizedUrl),
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
    videosByTab[tabKey] = existing.filter((item) => item.id !== id);
    await persistVideos();
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    return null;
  }

  let nextList;
  if (current) {
    nextList = existing.map((item) => (item.id === id ? { ...item, ...nextVideo } : item));
  } else {
    nextList = [nextVideo, ...existing];
  }

  videosByTab[tabKey] = nextList
    .sort((left, right) => right.lastSeen - left.lastSeen)
    .slice(0, MAX_VIDEOS_PER_TAB);

  await persistVideos();
  notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  scheduleVideoSizeProbe(tabId, nextVideo);
  return nextVideo;
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
    return file.replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "").replace(/[_-]+/g, " ").trim() || "Video";
  } catch (_error) {
    return "Video";
  }
}

function notifyPopup(message) {
  try {
    const result = api.runtime.sendMessage(message);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (_error) {
    // The popup is not open.
  }
}

async function clearTab(tabId) {
  await ensureStateLoaded();
  delete videosByTab[String(tabId)];
  await persistVideos();
  notifyPopup({ type: "videoListUpdated", tabId, videos: [] });
}

function getVisibleVideosForTab(tabId) {
  return videoFilters.groupUniqueFullVideos(videosByTab[String(tabId)] || []);
}

async function getTabVideos(tabId) {
  await ensureStateLoaded();
  scheduleMissingSizeProbes(tabId);
  return getVisibleVideosForTab(tabId);
}

async function getTabDownloads(_tabId) {
  await ensureStateLoaded();
  return Object.values(downloadsById)
    .sort((left, right) => right.updatedAt - left.updatedAt);
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
  const existing = downloadsById[jobId] || { id: jobId };
  downloadsById[jobId] = { ...existing, ...patch, updatedAt: Date.now() };
  persistDownloads();
  notifyPopup({ type: "downloadUpdated", job: downloadsById[jobId] });
}

function isHardAccessError(error) {
  return HARD_ACCESS_ERROR_RE.test(String(error || ""));
}

async function markVideoUrlUnavailable(tabId, url, error) {
  const tabKey = String(tabId);
  const targetUrl = normalizeUrl(url);
  let changed = false;

  videosByTab[tabKey] = (videosByTab[tabKey] || []).map((item) => {
    if (normalizeUrl(item.url || "") !== targetUrl || item.downloadable === false) {
      return item;
    }
    changed = true;
    return {
      ...item,
      downloadable: false,
      blockedReason: String(error || "The server refused this source.").slice(0, 500),
      lastSeen: Date.now(),
    };
  });

  if (!changed) {
    return false;
  }

  await persistVideos();
  notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  return true;
}

function artifactPatchFromMessage(message) {
  const patch = {
    filepath: message.filepath,
    artifactRoot: message.artifactRoot,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value));
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

function findVariant(video, variantId) {
  if (!variantId) {
    return preferredNativeVideo(video);
  }
  return variantsForVideo(video).find((variant) => variant.id === variantId) || null;
}

async function startNativeDownload(tabId, videoId, formatId = "best", variantId = "") {
  await ensureStateLoaded();
  const videos = await getTabVideos(tabId);
  const video = videos.find(
    (item) => item.id === videoId || variantsForVideo(item).some((variant) => variant.id === videoId)
  );

  if (!video) {
    throw new Error("That video URL is no longer in the detected list.");
  }
  const selectedVideo = findVariant(video, variantId || (video.id === videoId ? "" : videoId));
  if (!selectedVideo) {
    throw new Error("That video version is no longer in the detected list.");
  }
  if (!selectedVideo.downloadable) {
    throw new Error(
      "This is a browser-only blob/data URL. Wait for the underlying MP4, WebM, M3U8, or MPD network URL to appear."
    );
  }

  return startNativeDownloadFromVideo(tabId, { ...selectedVideo, groupId: video.id }, formatId);
}

async function startNativeDownloadFromVideo(tabId, video, formatId = "best", options = {}) {
  const tabs = await callTabsQuery({ active: true, currentWindow: true });
  const activeTab = tabs && tabs[0] ? tabs[0] : {};
  const jobId = options.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const existingJob = downloadsById[jobId] || {};
  const pageUrl = video.pageUrl || activeTab.url || "";
  let port;
  let finished = false;

  updateDownload(jobId, {
    id: jobId,
    tabId,
    videoId: video.groupId || video.id,
    variantId: video.groupId ? video.id : "",
    url: video.url,
    format: video.format,
    title: video.title || "Video",
    formatId: formatId || "best",
    pageUrl,
    filepath: existingJob.filepath || "",
    artifactRoot: existingJob.artifactRoot || "",
    status: "connecting",
    message: options.resume ? "Reconnecting to native helper..." : "Connecting to native helper...",
    createdAt: existingJob.createdAt || Date.now(),
  });

  try {
    port = api.runtime.connectNative(HOST_NAME);
  } catch (error) {
    updateDownload(jobId, {
      status: "error",
      error: `Native messaging is not connected: ${error.message || error}`,
    });
    return { jobId };
  }
  downloadPortsById[jobId] = port;

  port.onMessage.addListener((message) => {
    if (!message || message.id !== jobId) {
      return;
    }

    if (message.type === "started") {
      updateDownload(jobId, { status: "running", message: message.message || "Download started." });
      return;
    }

    if (message.type === "progress") {
      const patch = {
        status: "running",
        stage: message.stage,
        message: message.line || message.message || "Downloading...",
        ...artifactPatchFromMessage(message),
      };
      if (typeof message.percent === "number") {
        patch.percent = message.percent;
      }
      updateDownload(jobId, patch);
      return;
    }

    if (message.type === "control") {
      updateDownload(jobId, {
        status: message.status || downloadsById[jobId]?.status || "running",
        message: message.message || "Download control command sent.",
      });
      return;
    }

    if (message.type === "paused") {
      updateDownload(jobId, {
        status: "paused",
        message: message.message || "Download paused.",
        ...artifactPatchFromMessage(message),
      });
      return;
    }

    if (message.type === "resumed") {
      updateDownload(jobId, {
        status: "running",
        message: message.message || "Resuming download...",
      });
      return;
    }

    if (message.type === "canceled") {
      finished = true;
      delete downloadPortsById[jobId];
      updateDownload(jobId, {
        status: "canceled",
        message: message.message || "Download canceled.",
        ...artifactPatchFromMessage(message),
      });
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (message.type === "done") {
      finished = true;
      delete downloadPortsById[jobId];
      updateDownload(jobId, {
        status: "done",
        percent: 100,
        filepath: message.filepath || "",
        artifactRoot: message.artifactRoot || "",
        message: message.message || "Download complete.",
      });
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (message.type === "error") {
      const errorText = message.error || "yt-dlp failed.";
      finished = true;
      delete downloadPortsById[jobId];
      updateDownload(jobId, {
        status: "error",
        error: errorText,
        ...artifactPatchFromMessage(message),
      });
      if (isHardAccessError(errorText)) {
        void markVideoUrlUnavailable(tabId, video.url, errorText);
      }
      try {
        port.disconnect();
      } catch (_error) {}
    }
  });

  port.onDisconnect.addListener(() => {
    const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
    delete downloadPortsById[jobId];
    if (!finished) {
      updateDownload(jobId, {
        status: "error",
        error:
          runtimeError ||
          "Native messaging helper disconnected. Run scripts\\install.bat, restart the browser, and try again.",
      });
    }
  });

  const requestHeaders = await nativeRequestHeadersForVideo(video.url, pageUrl);
  port.postMessage({
    type: "download",
    id: jobId,
    url: video.url,
    format: video.format || "",
    pageUrl,
    userAgent: navigator.userAgent || "",
    requestHeaders,
    downloadFolder: settings.downloadFolder || "",
    formatId: formatId || "best",
  });

  updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper.",
  });

  return { jobId };
}

async function startNativeDownloadForUrl(tabId, input) {
  const video = await addDetectedVideo(tabId, {
    ...input,
    source: input.source || "overlay",
  });

  if (!video) {
    throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
  }

  return startNativeDownload(tabId, video.id, input.formatId || "best", input.variantId || "");
}

async function getBestDownloadableVideo(tabId) {
  const videos = await getTabVideos(tabId);
  const video = videos.find((item) => item.downloadable);
  if (!video) {
    throw new Error("No downloadable MP4, WebM, M3U8, or MPD URL has been detected for this player yet.");
  }
  return video;
}

async function startBestNativeDownload(tabId, formatId = "best", variantId = "") {
  const video = await getBestDownloadableVideo(tabId);
  return startNativeDownload(tabId, video.id, formatId, variantId);
}

function getDownloadJob(jobId) {
  const job = downloadsById[jobId];
  if (!job) {
    throw new Error("That download is no longer in the history.");
  }
  return job;
}

function videoFromDownloadJob(job) {
  return {
    id: job.videoId || hashId(job.url),
    url: job.url,
    format: job.format || detectFormat(job.url),
    title: job.title || titleFromUrl(job.url),
    pageUrl: job.pageUrl || "",
    downloadable: true,
  };
}

function controlActiveDownload(jobId, nativeType) {
  const port = downloadPortsById[jobId];
  if (!port) {
    throw new Error("That download is not active anymore. Use Retry to start it again.");
  }

  const nextStatus = {
    pause: "pausing",
    resume: "running",
    cancel: "canceling",
  }[nativeType];
  const nextMessage = {
    pause: "Pausing download...",
    resume: "Resuming download...",
    cancel: "Canceling download...",
  }[nativeType];

  updateDownload(jobId, {
    status: nextStatus || downloadsById[jobId]?.status || "running",
    message: nextMessage || "Sending download command...",
  });
  if (nativeType === "pause") {
    port.postMessage({ type: "pause", id: jobId });
  } else if (nativeType === "resume") {
    port.postMessage({ type: "resume", id: jobId });
  } else if (nativeType === "cancel") {
    port.postMessage({ type: "cancel", id: jobId });
  }
  return { jobId };
}

async function resumeDownload(tabId, jobId) {
  await ensureStateLoaded();
  if (downloadPortsById[jobId]) {
    return controlActiveDownload(jobId, "resume");
  }

  const job = getDownloadJob(jobId);
  if (job.status !== "paused") {
    throw new Error("That download is not paused.");
  }
  if (!job.url) {
    throw new Error("That download does not have a URL to resume.");
  }

  return startNativeDownloadFromVideo(
    job.tabId || tabId,
    videoFromDownloadJob(job),
    job.formatId || "best",
    { jobId, resume: true }
  );
}

async function cancelDownload(_tabId, jobId) {
  await ensureStateLoaded();
  if (downloadPortsById[jobId]) {
    return controlActiveDownload(jobId, "cancel");
  }

  const job = getDownloadJob(jobId);
  if (["done", "error", "canceled"].includes(job.status)) {
    throw new Error("This download is no longer active.");
  }

  updateDownload(jobId, {
    status: "canceled",
    message: "Download canceled. No active helper connection remained.",
  });
  return { jobId };
}

async function retryDownload(tabId, jobId) {
  await ensureStateLoaded();
  const job = getDownloadJob(jobId);
  if (["queued", "connecting", "running", "paused", "pausing", "canceling"].includes(job.status)) {
    throw new Error("That download is still active. Cancel it or wait before retrying.");
  }
  if (!job.url) {
    throw new Error("That download does not have a URL to retry.");
  }

  return startNativeDownloadFromVideo(
    job.tabId || tabId,
    videoFromDownloadJob(job),
    job.formatId || "best"
  );
}

async function openDownloadedPath(jobId, nativeType) {
  await ensureStateLoaded();
  const job = getDownloadJob(jobId);
  if (!job.filepath) {
    throw new Error("That download has no saved file path yet.");
  }

  const requestId = `open_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const payload =
    nativeType === "openFile"
      ? { type: "openFile", id: requestId, path: job.filepath }
      : { type: "showFile", id: requestId, path: job.filepath };

  await nativeRequest(payload, 10000);
  return { jobId };
}

async function removeDownload(jobId) {
  await ensureStateLoaded();
  const job = getDownloadJob(jobId);
  if (downloadPortsById[jobId]) {
    throw new Error("Cancel the active download before removing it.");
  }
  if (job.filepath || job.artifactRoot || (Array.isArray(job.artifactPaths) && job.artifactPaths.length)) {
    const requestId = `delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await nativeRequest(
      {
        type: "deleteArtifacts",
        id: requestId,
        path: job.filepath || "",
        artifactRoot: job.artifactRoot || "",
        artifactPaths: job.artifactPaths || [],
      },
      30000
    );
  }
  delete downloadsById[jobId];
  await persistDownloads();
  notifyPopup({ type: "downloadRemoved", jobId });
  return { jobId };
}

function nativeRequest(payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    const finish = (error, response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        if (port) {
          port.disconnect();
        }
      } catch (_error) {}
      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    };

    try {
      port = api.runtime.connectNative(HOST_NAME);
    } catch (error) {
      reject(new Error(`Native messaging is not connected: ${error.message || error}`));
      return;
    }

    const timeout = setTimeout(() => {
      finish(new Error("Native helper did not respond in time."));
    }, timeoutMs);

    port.onMessage.addListener((message) => {
      if (!message || message.id !== payload.id) {
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.error || "Native helper returned an error."));
        return;
      }
      finish(null, message);
    });

    port.onDisconnect.addListener(() => {
      const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
      if (!settled) {
        finish(new Error(runtimeError || "Native helper disconnected."));
      }
    });

    port.postMessage(payload);
  });
}

function humanSize(numBytes) {
  const size = Number(numBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }
  let value = size;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024 || unit === "GB") {
      return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return "";
}

function sourceHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function sourceText(video) {
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
    variantId: "",
    optionType: "native-format",
    ext,
    source: format.source || `yt-dlp / ${sourceHost(video.url) || "detected source"}`,
  };
}

function findGroupedVideoForVariant(tabId, variant) {
  return getVisibleVideosForTab(tabId).find((video) =>
    variantsForVideo(video).some((item) => item.id === variant.id)
  );
}

async function updateGroupedTitle(tabId, video, title) {
  if (!title) {
    return;
  }

  const variantIds = new Set(variantsForVideo(video).map((variant) => variant.id));
  const tabKey = String(tabId);
  videosByTab[tabKey] = (videosByTab[tabKey] || []).map((item) =>
    variantIds.has(item.id) ? { ...item, title } : item
  );
  await persistVideos();
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
    }))
  );

  let changed = false;
  for (const result of results) {
    if (result.sizeBytes) {
      changed = (await updateVideoSize(tabId, result.id, result.sizeBytes, false)) || changed;
    }
  }

  if (changed) {
    await persistVideos();
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    return findGroupedVideoForVariant(tabId, variantsForVideo(video)[0]) || video;
  }

  return video;
}

async function getNativeFormatsForVideo(tabId, video) {
  await ensureStateLoaded();
  const sizedVideo = await ensureComparisonSizes(tabId, video);
  const lookupVideo = preferredNativeVideo(sizedVideo);
  const requestId = `formats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let response = null;
  let nativeError = "";

  try {
    response = await nativeRequest({
      type: "formats",
      id: requestId,
      url: lookupVideo.url,
      pageUrl: lookupVideo.pageUrl || "",
      userAgent: navigator.userAgent || "",
      requestHeaders: await nativeRequestHeadersForVideo(lookupVideo.url, lookupVideo.pageUrl || ""),
    });
  } catch (error) {
    nativeError = error.message || String(error);
  }

  if (response && response.title) {
    await updateGroupedTitle(tabId, sizedVideo, response.title);
  }

  const nativeFormats =
    response && response.formats && response.formats.length
      ? response.formats.map((format) => normalizeNativeFormatOption(format, lookupVideo))
      : [];
  const refreshedVideo = findGroupedVideoForVariant(tabId, variantsForVideo(sizedVideo)[0]) || sizedVideo;
  if (nativeError && !nativeFormats.length) {
    if (isHardAccessError(nativeError)) {
      await markVideoUrlUnavailable(tabId, lookupVideo.url, nativeError);
    }
    throw new Error(nativeError);
  }

  const sourceFormats = nativeFormats.length
    ? []
    : variantsForVideo(refreshedVideo)
        .filter((variant) => variant.downloadable)
        .map(detectedVariantOption);
  const formats = nativeFormats.length ? nativeFormats : sourceFormats;

  return {
    title: (response && response.title) || refreshedVideo.title || lookupVideo.title || "Video",
    formats: formats.length
      ? formats
      : [
          normalizeNativeFormatOption(
            { id: "best", label: "Best available MP4", ext: "mp4", note: "Recommended" },
            lookupVideo
          ),
        ],
    nativeError,
  };
}

function pingNativeHost() {
  return new Promise((resolve) => {
    const id = `ping_${Date.now()}`;
    let settled = false;
    let port;
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

    try {
      port = api.runtime.connectNative(HOST_NAME);
    } catch (error) {
      finish({ ok: false, error: `Native messaging is not connected: ${error.message || error}` });
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
  try {
    api.webRequest.onBeforeSendHeaders.addListener(
      handleBeforeSendHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders", "extraHeaders"]
    );
  } catch (_error) {
    api.webRequest.onBeforeSendHeaders.addListener(
      handleBeforeSendHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders"]
    );
  }
}

api.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: ["<all_urls>"] });
registerBeforeSendHeadersListener();
api.webRequest.onHeadersReceived.addListener(
  handleHeadersReceived,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    await ensureStateLoaded();
    const tabId = message.tabId || (sender.tab && sender.tab.id);

    if (message.type === "contentDetectedVideos") {
      const videos = Array.isArray(message.videos) ? message.videos : [];
      for (const video of videos) {
        await addDetectedVideo(tabId, {
          ...video,
          source: video.source || "dom",
          pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
          frameUrl: video.frameUrl || sender.url || "",
        });
      }
      return { ok: true };
    }

    if (message.type === "getVideos") {
      return {
        ok: true,
        videos: await getTabVideos(tabId),
        downloads: await getTabDownloads(tabId),
        settings,
      };
    }

    if (message.type === "downloadVideo") {
      return {
        ok: true,
        ...(await startNativeDownload(
          tabId,
          message.videoId,
          message.formatId || "best",
          message.variantId || ""
        )),
      };
    }

    if (message.type === "pauseDownload") {
      return { ok: true, ...controlActiveDownload(message.jobId, "pause") };
    }

    if (message.type === "resumeDownload") {
      return { ok: true, ...(await resumeDownload(tabId, message.jobId)) };
    }

    if (message.type === "cancelDownload") {
      return { ok: true, ...(await cancelDownload(tabId, message.jobId)) };
    }

    if (message.type === "retryDownload") {
      return { ok: true, ...(await retryDownload(tabId, message.jobId)) };
    }

    if (message.type === "openDownloadedFile") {
      return { ok: true, ...(await openDownloadedPath(message.jobId, "openFile")) };
    }

    if (message.type === "showDownloadedFile") {
      return { ok: true, ...(await openDownloadedPath(message.jobId, "showFile")) };
    }

    if (message.type === "removeDownload") {
      return { ok: true, ...(await removeDownload(message.jobId)) };
    }

    if (message.type === "getVideoFormats") {
      const videos = await getTabVideos(tabId);
      const video = videos.find(
        (item) => item.id === message.videoId || variantsForVideo(item).some((variant) => variant.id === message.videoId)
      );
      if (!video) {
        throw new Error("That video URL is no longer in the detected list.");
      }
      return { ok: true, ...(await getNativeFormatsForVideo(tabId, video)) };
    }

    if (message.type === "downloadUrl") {
      return {
        ok: true,
        ...(await startNativeDownloadForUrl(tabId, {
          ...(message.video || {}),
          pageUrl: (sender.tab && sender.tab.url) || "",
          frameUrl: sender.url || "",
          formatId: message.formatId || "best",
          variantId: message.variantId || "",
        })),
      };
    }

    if (message.type === "downloadBestVideo") {
      return {
        ok: true,
        ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
      };
    }

    if (message.type === "getFormatsForUrl") {
      const video = await addDetectedVideo(tabId, {
        ...(message.video || {}),
        pageUrl: (sender.tab && sender.tab.url) || "",
        frameUrl: sender.url || "",
        source: (message.video && message.video.source) || "overlay",
      });
      if (!video) {
        throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
      }
      const groupedVideo = findGroupedVideoForVariant(tabId, video) || video;
      return { ok: true, videoId: groupedVideo.id, ...(await getNativeFormatsForVideo(tabId, groupedVideo)) };
    }

    if (message.type === "getBestVideoFormats") {
      const video = await getBestDownloadableVideo(tabId);
      return { ok: true, videoId: video.id, ...(await getNativeFormatsForVideo(tabId, video)) };
    }

    if (message.type === "saveSettings") {
      settings = { ...settings, ...(message.settings || {}) };
      await persistSettings();
      return { ok: true, settings };
    }

    if (message.type === "getSettings") {
      return { ok: true, settings };
    }

    if (message.type === "pingNativeHost") {
      return pingNativeHost();
    }

    if (message.type === "rescanTab") {
      await callTabsSendMessage(tabId, { type: "scanNow" });
      await callExecuteScript({
        target: { tabId, allFrames: true },
        func: () => window.dispatchEvent(new CustomEvent("qwin-video-scan-now")),
      });
      return { ok: true };
    }

    if (message.type === "clearVideos") {
      await clearTab(tabId);
      return { ok: true };
    }

    return { ok: false, error: "Unknown message type." };
  };

  run()
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

api.tabs.onRemoved.addListener((tabId) => {
  delete videosByTab[String(tabId)];
  persistVideos();
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearTab(tabId);
  }
});

ensureStateLoaded();
