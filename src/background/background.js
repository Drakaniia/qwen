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
const CDN_HINT_RE = /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey)/i;

let videosByTab = {};
let downloadsById = {};
let settings = { downloadFolder: "" };
let stateLoaded = false;
let stateLoadPromise = null;
const downloadPortsById = {};

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

function detectFormat(url, contentType = "") {
  return videoFilters.classifyVideoUrl(url, contentType);
}

function isDownloadableUrl(url) {
  return videoFilters.isDownloadableUrl(url);
}

function isLikelyVideoRequest(url, resourceType, contentType = "") {
  return videoFilters.isLikelyVideoRequest(url, resourceType, contentType);
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

  const nextVideo = {
    id,
    url: normalizedUrl,
    format,
    source: input.source || "network",
    title: input.title || current?.title || titleFromUrl(normalizedUrl),
    pageUrl: input.pageUrl || input.frameUrl || "",
    frameUrl: input.frameUrl || "",
    contentType: input.contentType || "",
    downloadable: isDownloadableUrl(normalizedUrl),
    firstSeen: current ? current.firstSeen : now,
    lastSeen: now,
  };

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
  notifyPopup({ type: "videoListUpdated", tabId, videos: videosByTab[tabKey] });
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

async function getTabVideos(tabId) {
  await ensureStateLoaded();
  return videosByTab[String(tabId)] || [];
}

async function getTabDownloads(tabId) {
  await ensureStateLoaded();
  return Object.values(downloadsById)
    .filter((job) => job.tabId === tabId)
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
  });
}

function updateDownload(jobId, patch) {
  const existing = downloadsById[jobId] || { id: jobId };
  downloadsById[jobId] = { ...existing, ...patch, updatedAt: Date.now() };
  persistDownloads();
  notifyPopup({ type: "downloadUpdated", job: downloadsById[jobId] });
}

async function startNativeDownload(tabId, videoId, formatId = "best") {
  await ensureStateLoaded();
  const videos = await getTabVideos(tabId);
  const video = videos.find((item) => item.id === videoId);

  if (!video) {
    throw new Error("That video URL is no longer in the detected list.");
  }
  if (!video.downloadable) {
    throw new Error(
      "This is a browser-only blob/data URL. Wait for the underlying MP4, WebM, M3U8, or MPD network URL to appear."
    );
  }

  return startNativeDownloadFromVideo(tabId, video, formatId);
}

async function startNativeDownloadFromVideo(tabId, video, formatId = "best") {
  const tabs = await callTabsQuery({ active: true, currentWindow: true });
  const activeTab = tabs && tabs[0] ? tabs[0] : {};
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const pageUrl = video.pageUrl || activeTab.url || "";
  let port;
  let finished = false;

  updateDownload(jobId, {
    id: jobId,
    tabId,
    videoId,
    url: video.url,
    format: video.format,
    title: video.title || "Video",
    formatId: formatId || "best",
    pageUrl,
    status: "connecting",
    message: "Connecting to native helper...",
    createdAt: Date.now(),
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
      };
      if (typeof message.percent === "number") {
        patch.percent = message.percent;
      }
      if (message.filepath) {
        patch.filepath = message.filepath;
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
        message: message.message || "Download complete.",
      });
      try {
        port.disconnect();
      } catch (_error) {}
      return;
    }

    if (message.type === "error") {
      finished = true;
      delete downloadPortsById[jobId];
      updateDownload(jobId, {
        status: "error",
        error: message.error || "yt-dlp failed.",
      });
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

  port.postMessage({
    type: "download",
    id: jobId,
    url: video.url,
    pageUrl,
    userAgent: navigator.userAgent || "",
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

  return startNativeDownload(tabId, video.id, input.formatId || "best");
}

async function getBestDownloadableVideo(tabId) {
  const videos = await getTabVideos(tabId);
  const video = videos.find((item) => item.downloadable);
  if (!video) {
    throw new Error("No downloadable MP4, WebM, M3U8, or MPD URL has been detected for this player yet.");
  }
  return video;
}

async function startBestNativeDownload(tabId, formatId = "best") {
  const video = await getBestDownloadableVideo(tabId);
  return startNativeDownload(tabId, video.id, formatId);
}

function getDownloadJob(jobId) {
  const job = downloadsById[jobId];
  if (!job) {
    throw new Error("That download is no longer in the history.");
  }
  return job;
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
    {
      id: job.videoId || hashId(job.url),
      url: job.url,
      format: job.format || detectFormat(job.url),
      title: job.title || titleFromUrl(job.url),
      pageUrl: job.pageUrl || "",
      downloadable: true,
    },
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
  if (downloadPortsById[jobId]) {
    throw new Error("Cancel the active download before removing it.");
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

async function getNativeFormatsForVideo(tabId, video) {
  await ensureStateLoaded();
  const requestId = `formats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const response = await nativeRequest({
    type: "formats",
    id: requestId,
    url: video.url,
    pageUrl: video.pageUrl || "",
    userAgent: navigator.userAgent || "",
  });

  if (response.title) {
    const tabKey = String(tabId);
    videosByTab[tabKey] = (videosByTab[tabKey] || []).map((item) =>
      item.id === video.id ? { ...item, title: response.title } : item
    );
    await persistVideos();
    notifyPopup({ type: "videoListUpdated", tabId, videos: videosByTab[tabKey] });
  }

  return {
    title: response.title || video.title || "Video",
    formats: response.formats && response.formats.length ? response.formats : [{ id: "best", label: "Best available MP4" }],
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

api.webRequest.onBeforeRequest.addListener(handleBeforeRequest, { urls: ["<all_urls>"] });
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
      return { ok: true, ...(await startNativeDownload(tabId, message.videoId, message.formatId || "best")) };
    }

    if (message.type === "pauseDownload") {
      return { ok: true, ...controlActiveDownload(message.jobId, "pause") };
    }

    if (message.type === "resumeDownload") {
      return { ok: true, ...controlActiveDownload(message.jobId, "resume") };
    }

    if (message.type === "cancelDownload") {
      return { ok: true, ...controlActiveDownload(message.jobId, "cancel") };
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
      const video = videos.find((item) => item.id === message.videoId);
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
        })),
      };
    }

    if (message.type === "downloadBestVideo") {
      return { ok: true, ...(await startBestNativeDownload(tabId, message.formatId || "best")) };
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
      return { ok: true, videoId: video.id, ...(await getNativeFormatsForVideo(tabId, video)) };
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
