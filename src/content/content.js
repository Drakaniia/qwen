"use strict";

import * as videoFilters from "../shared/video_filters.js";
import * as qualityFormat from "../shared/quality_format.js";
import * as qualityDialog from "../shared/quality_dialog.js";
import * as videoPicker from "../shared/video_picker.js";
import * as pageDetectionModule from "./page_detection.js";
import * as mediaSourceIntercept from "./media_source_intercept.js";
import * as emeIntercept from "./eme_intercept.js";
import * as p2pDetection from "./p2p_detection.js";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const seenUrls = new Map();
const pageDetection = pageDetectionModule.create({
  document,
  location,
  videoFilters,
  seenUrls,
});
const overlayByVideo = new WeakMap();
const overlayRecords = new Set();
const watchedVideos = new WeakSet();

let overlayDialog = null;
let overlayQualityChooser = null;
let overlayRequestSerial = 0;
let lastDetectedVideos = [];

function sendMessage(message) {
  try {
    const result = extensionApi.runtime.sendMessage(message);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (_error) {
    // The extension context can disappear during reloads.
  }
}

function sendMessageWithResponse(message) {
  if (typeof browser !== "undefined") {
    return extensionApi.runtime.sendMessage(message).catch((error) => ({
      ok: false,
      error: error.message || String(error),
    }));
  }

  return new Promise((resolve) => {
    try {
      extensionApi.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from background script." });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error) });
    }
  });
}

function findAllVideos(root = document) {
  const videos = Array.from(root.querySelectorAll("video"));
  const allElements = root.querySelectorAll("*");
  for (const el of Array.from(allElements)) {
    if (el.shadowRoot) {
      videos.push(...findAllVideos(el.shadowRoot));
    }
  }
  return videos;
}

function createOverlayButton(_video) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download";
  button.title = "Open available video";
  button.setAttribute("aria-label", "Open available video");
  button.style.position = "fixed";
  button.style.zIndex = "2147483647";
  button.style.minWidth = "96px";
  button.style.height = "34px";
  button.style.padding = "0 12px";
  button.style.border = "1px solid rgba(255, 255, 255, 0.45)";
  button.style.borderRadius = "6px";
  button.style.background = "rgba(15, 118, 110, 0.96)";
  button.style.color = "#fff";
  button.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.28)";
  button.style.font = "700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  button.style.cursor = "pointer";
  button.style.display = "none";
  button.style.letterSpacing = "0";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    showAvailableVideosOverlay();
  });
  return button;
}

function ensureOverlay() {
  if (overlayDialog && overlayDialog.root.isConnected) {
    return overlayDialog;
  }

  const root = document.createElement("div");
  root.id = "qwin-video-overlay";
  root.hidden = true;

  const card = document.createElement("div");
  card.className = "qwin-overlay-card";

  const header = document.createElement("div");
  header.className = "qwin-overlay-header";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "qwin-overlay-back";
  back.textContent = "Back";
  back.hidden = true;
  back.addEventListener("click", () => showAvailableVideosOverlay());

  const title = document.createElement("h2");
  title.className = "qwin-overlay-title";

  const list = document.createElement("div");
  list.className = "qwin-overlay-list";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "qwin-overlay-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => hideOverlay());

  header.append(back, title);
  card.append(header, list, cancel);
  root.append(card);
  (document.fullscreenElement || document.body || document.documentElement).append(root);
  overlayDialog = { root, card, header, back, title, list, cancel };
  overlayQualityChooser = null;
  return overlayDialog;
}

function hideOverlay() {
  if (!overlayDialog || !overlayDialog.root) {
    return;
  }

  if (overlayQualityChooser) {
    overlayQualityChooser.hide();
    return;
  }

  overlayDialog.root.hidden = true;
  overlayDialog.list.textContent = "";
  overlayDialog.back.hidden = true;
  overlayDialog.cancel.disabled = false;
  overlayDialog.cancel.textContent = "Cancel";
}

function ensureQualityChooser() {
  const dialog = ensureOverlay();
  if (overlayQualityChooser) {
    return overlayQualityChooser;
  }
  if (!qualityDialog || typeof qualityDialog.create !== "function") {
    throw new Error("QwinQualityDialog is not loaded.");
  }

  overlayQualityChooser = qualityDialog.create({
    document,
    root: dialog.root,
    title: dialog.title,
    list: dialog.list,
    cancel: dialog.cancel,
    back: dialog.back,
    qualityFormat,
    videoFilters,
    loadingStatusId: "qwin-quality-loading-status",
    style: "classes",
    hideOnSelect: false,
    hideOnBack: false,
    showRoot(root) {
      root.hidden = false;
    },
    hideRoot(root) {
      root.hidden = true;
    },
  });
  return overlayQualityChooser;
}

function showQualityLoadingDialog(title = "Loading versions...") {
  const requestToken = ++overlayRequestSerial;
  ensureQualityChooser().showLoading({
    loadingTitle: title,
    onCancel() {
      overlayRequestSerial += 1;
    },
  });
  return requestToken;
}

function updateQualityLoadingStatus(text) {
  ensureQualityChooser().updateLoadingStatus(text);
}

function isCurrentQualityRequest(requestToken) {
  return requestToken === overlayRequestSerial;
}

async function handleVideoSelection(video) {
  const dialog = ensureOverlay();
  dialog.list.textContent = "";
  dialog.title.textContent = "Loading...";

  const requestToken = showQualityLoadingDialog(video.title || "Video");
  const formatsResponse = await sendMessageWithResponse({
    type: "getFormatsForUrl",
    video: video,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideOverlay();
    return;
  }

  const selectedFormat = await showQualityDialog(formatsResponse, true);
  if (!selectedFormat) {
    showAvailableVideosOverlay();
    return;
  }

  dialog.list.textContent = "";
  dialog.title.textContent = "Sending...";
  const response = await sendMessageWithResponse({
    type: "downloadVideo",
    videoId: formatsResponse.videoId,
    formatId: selectedFormat.formatId,
    variantId: selectedFormat.variantId,
    backend: selectedFormat.backend,
  });

  if (!response || !response.ok) {
    dialog.title.textContent = "Error";
    window.setTimeout(showAvailableVideosOverlay, 1000);
    return;
  }

  dialog.title.textContent = "Queued";
  window.setTimeout(hideOverlay, 700);
}

function showAvailableVideosOverlay() {
  const dialog = ensureOverlay();
  dialog.title.textContent = "Available Videos";
  dialog.list.textContent = "";
  dialog.back.hidden = true;
  dialog.root.hidden = false;

  void (async () => {
    const response = await sendMessageWithResponse({ type: "getVideos" });
    const videos = response && response.ok ? response.videos : lastDetectedVideos;

    if (!videoPicker || typeof videoPicker.renderList !== "function") {
      dialog.list.textContent = "No downloadable video detected yet.";
      return;
    }

    videoPicker.renderList(dialog.list, videos, {
      videoFilters,
      emptyText: "No downloadable video detected yet.",
      onSelect: handleVideoSelection,
    });
  })();
}

function showQualityDialog({ title, formats }, hasBack = false) {
  return ensureQualityChooser().showChoices({
    choiceTitle: title,
    formats,
    hasBack,
  });
}

function positionOverlay(record) {
  if (!record.video.isConnected) {
    removeOverlay(record.video);
    return;
  }

  const rect = record.video.getBoundingClientRect();
  const visible =
    rect.width >= 160 &&
    rect.height >= 90 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  if (!visible) {
    record.button.style.display = "none";
    return;
  }

  // Ensure button is attached to the correct parent (handles fullscreen)
  const targetParent = document.fullscreenElement || document.body || document.documentElement;
  if (record.button.parentElement !== targetParent) {
    targetParent.append(record.button);
  }

  const left = Math.max(8, Math.min(rect.right - 106, window.innerWidth - 114));
  const top = Math.max(8, rect.top + 8);
  record.button.style.left = `${left}px`;
  record.button.style.top = `${top}px`;
  record.button.style.display = "block";
}

function positionAllOverlays() {
  for (const record of Array.from(overlayRecords)) {
    positionOverlay(record);
  }
}

function removeOverlay(video) {
  const record = overlayByVideo.get(video);
  if (!record) {
    return;
  }
  record.button.remove();
  overlayByVideo.delete(video);
  overlayRecords.delete(record);
}

function updateOverlay(video, candidate, allowBestDetectedFallback = false) {
  if (!candidate && !allowBestDetectedFallback) {
    removeOverlay(video);
    return;
  }

  let record = overlayByVideo.get(video);
  if (!record) {
    const button = createOverlayButton(video);
    (document.fullscreenElement || document.body || document.documentElement).append(button);
    record = { video, button, candidate };
    overlayByVideo.set(video, record);
    overlayRecords.add(record);
  }

  record.candidate = candidate || null;
  record.button.title = "Open available video";
  positionOverlay(record);
}

function scanVideoElements() {
  const candidates = [];
  const videos = findAllVideos();

  for (const video of videos) {
    const videoCandidates = [];
    const primary = pageDetection.addCandidate(
      candidates,
      video.currentSrc || video.src,
      "dom-video",
      video.type || "",
      video,
    );
    if (primary) {
      videoCandidates.push(primary);
    }

    for (const source of Array.from(video.querySelectorAll("source"))) {
      const candidate = pageDetection.addCandidate(candidates, source.src, "dom-source", source.type || "", video);
      if (candidate) {
        videoCandidates.push(candidate);
      }
    }

    const youtubeCandidate = pageDetection.addBuiltCandidate(
      candidates,
      pageDetection.youtubePageCandidateForVideo(video),
    );
    if (youtubeCandidate) {
      videoCandidates.push(youtubeCandidate);
    }

    const pageFallbackCandidate = pageDetection.pageFallbackCandidateForVideo(video);
    const storedPageFallbackCandidate = pageDetection.addBuiltCandidate(candidates, pageFallbackCandidate);
    if (storedPageFallbackCandidate) {
      videoCandidates.push(storedPageFallbackCandidate);
    }

    const overlayCandidate = pageDetection.findOverlayCandidate(video, videoCandidates);
    updateOverlay(
      video,
      overlayCandidate || pageFallbackCandidate,
      !overlayCandidate &&
        !pageFallbackCandidate &&
        !pageDetection.videoHasBlockedMediaSource(video) &&
        pageDetection.isLikelyRealPlayer(video),
    );
  }

  for (const source of Array.from(document.querySelectorAll("source"))) {
    if (
      String(source.type || "")
        .toLowerCase()
        .startsWith("video/")
    ) {
      pageDetection.addCandidate(candidates, source.src, "dom-source", source.type || "");
    }
  }

  return candidates;
}

function scanPerformanceEntries() {
  const candidates = [];
  if (!performance || typeof performance.getEntriesByType !== "function") {
    return candidates;
  }

  for (const entry of performance.getEntriesByType("resource")) {
    pageDetection.addCandidate(candidates, entry.name, "performance");
  }
  return candidates;
}

function scanInlinePlayerScripts() {
  const candidates = [];
  for (const script of Array.from(document.scripts || [])) {
    if (script.src) {
      continue;
    }
    candidates.push(...pageDetection.scanTextForMediaUrls(script.textContent || "", "script-config"));
  }
  return candidates;
}

function scanVisiblePlayerFrames() {
  const candidates = [];
  for (const frame of Array.from(document.querySelectorAll("iframe[src]"))) {
    const src = pageDetection.toAbsoluteUrl(frame.getAttribute("src") || frame.src || "");
    if (!src || !videoFilters.isDownloadableUrl(src, "")) {
      continue;
    }
    const rect = frame.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 120) {
      continue;
    }
    const iframeTitle = pageDetection.cleanText(frame.getAttribute("title"));
    const finalTitle =
      iframeTitle && !videoFilters.isGenericTitle(iframeTitle)
        ? iframeTitle
        : pageDetection.cleanText(document.title) || pageDetection.titleFromUrl(src) || "Video";

    // If the iframe URL doesn't have a video extension, treat it as a PAGE
    // format so the native host uses yt-dlp for page extraction rather than
    // attempting a direct download of the (non-video) URL.
    const hasVideoExt = /(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])|\.ism(?:\/Manifest)?(?:$|[?#]))/i.test(src);

    pageDetection.addBuiltCandidate(candidates, {
      url: src,
      format: hasVideoExt ? pageDetection.detectFormat(src) : "PAGE",
      source: "iframe-page",
      contentType: "",
      pageUrl: src,
      frameUrl: location.href,
      title: finalTitle,
      thumbnailUrl: pageDetection.pageThumbnailUrl(),
      downloadable: true,
      width: rect.width,
      height: rect.height,
      duration: 0,
    });
  }
  return candidates;
}

function scanMusicSources() {
  const candidates = [];
  const hostname = location.hostname.toLowerCase();
  const pathname = location.pathname;

  // Detect known music streaming platforms.
  // For yt-dlp-supported sites (SoundCloud, Deezer, Tidal, Bandcamp, Apple Music)
  // the page URL is sent directly.
  // For DRM-protected sites (Spotify), the native host falls back to a YouTube
  // search + metadata pipeline.
  const MUSIC_PLATFORMS = [
    { host: /(^|\.)open\.spotify\.com$/, path: /^\/(track|album|playlist|episode|show)\//i },
    { host: /(^|\.)music\.apple\.com$/, path: /^\/([a-z]{2}\/)?(album|song|playlist)\//i },
    { host: /(^|\.)soundcloud\.com$/, path: /^\/(?!search|upload|signin|discover)/i },
    { host: /(^|\.)tidal\.com$/, path: /\/(track|album|playlist|video)\//i },
    { host: /(^|\.)deezer\.com$/, path: /\/(track|album|playlist|podcast)\//i },
    { host: /(^|\.)music\.youtube\.com$/, path: /\//i },
    { host: /(^|\.)bandcamp\.com$/, path: /\/(track|album)\//i },
  ];

  const matched = MUSIC_PLATFORMS.find((p) => p.host.test(hostname) && p.path.test(pathname));
  if (!matched) {
    return candidates;
  }

  // Use the page URL itself as the download source.
  // For DRM platforms like Spotify the native host resolves via YouTube fallback.
  const pageUrl = location.href;
  const title =
    pageDetection.cleanMusicTitle(pageDetection.cleanText(document.title)) ||
    pageDetection.titleFromUrl(pageUrl) ||
    "Music";

  pageDetection.addBuiltCandidate(candidates, {
    url: pageUrl,
    format: "AUDIO",
    source: "music-page",
    contentType: "",
    pageUrl,
    frameUrl: location.href,
    title,
    thumbnailUrl: pageDetection.pageThumbnailUrl(),
    downloadable: true,
    width: 0,
    height: 0,
    duration: 0,
  });

  return candidates;
}

function publishScan() {
  const videos = [
    ...scanVideoElements(),
    ...scanPerformanceEntries(),
    ...scanInlinePlayerScripts(),
    ...scanVisiblePlayerFrames(),
    ...scanMusicSources(),
  ];
  lastDetectedVideos = videos;
  if (videos.length > 0) {
    sendMessage({ type: "contentDetectedVideos", videos });
  }
  return videos;
}

function scheduleScan() {
  window.setTimeout(publishScan, 250);
  window.setTimeout(positionAllOverlays, 300);
}

function watchVideoElement(video) {
  if (!video || watchedVideos.has(video)) {
    return;
  }
  watchedVideos.add(video);
  for (const eventName of ["loadedmetadata", "loadeddata", "play", "playing", "canplay"]) {
    video.addEventListener(eventName, scheduleScan, { passive: true });
  }
}

function installVideoWatchers(root = document) {
  if (root && root.matches && root.matches("video")) {
    watchVideoElement(root);
  }
  for (const video of findAllVideos(root)) {
    watchVideoElement(video);
  }
}

const observer = new MutationObserver((mutations) => {
  let shouldScan = false;
  for (const mutation of mutations) {
    if (mutation.type === "attributes" && ["src", "type"].includes(mutation.attributeName)) {
      shouldScan = true;
    }

    for (const node of Array.from(mutation.addedNodes || [])) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      if (node.matches && (node.matches("video, source") || node.querySelector("video, source"))) {
        shouldScan = true;
      }
      installVideoWatchers(node);
    }
  }

  if (shouldScan) {
    scheduleScan();
  }
});

function start() {
  installVideoWatchers();
  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "type"],
  });
  // Initialise MSE/Blob URL interception for custom players
  mediaSourceIntercept.init();

  // Initialise EME interception for DRM-protected streams
  emeIntercept.init();

  // Initialise P2P/WebRTC stream detection
  p2pDetection.init();

  publishScan();
  window.setInterval(publishScan, 3000);
  window.setInterval(positionAllOverlays, 600);
}

window.addEventListener("scroll", positionAllOverlays, true);
window.addEventListener("resize", positionAllOverlays, true);

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "scanNow") {
    seenUrls.clear();
    const videos = publishScan();

    // Return scan results synchronously so the background's rescanTab
    // handler can await tabs.sendMessage and get populated data back.
    if (typeof browser !== "undefined") {
      return Promise.resolve({ ok: true, videos });
    }
    if (sendResponse) {
      sendResponse({ ok: true, videos });
    }
    return true;
  } else if (message && message.type === "updateLoadingStatus") {
    updateQualityLoadingStatus(message.text);
  }
});

window.addEventListener("qwin-video-scan-now", () => {
  seenUrls.clear();
  publishScan();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
