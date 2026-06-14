"use strict";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const videoFilters = globalThis.QwinVideoFilters;
const qualityFormat = globalThis.QwinQualityFormat;
const qualityDialog = globalThis.QwinQualityDialog;
const videoPicker = globalThis.QwinVideoPicker;
const seenUrls = new Map();
const pageDetection = globalThis.QwinPageDetection.create({
  document,
  location,
  videoFilters,
  seenUrls,
});
const overlayByVideo = new WeakMap();
const overlayRecords = new Set();

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

function toAbsoluteUrl(value) {
  return pageDetection.toAbsoluteUrl(value);
}

function detectFormat(url, mimeType = "") {
  return pageDetection.detectFormat(url, mimeType);
}

function cleanText(value) {
  return pageDetection.cleanText(value);
}

function decodeUrlText(value) {
  return pageDetection.decodeUrlText(value);
}

function titleFromUrl(url) {
  return pageDetection.titleFromUrl(url);
}

function titleForVideo(video, url) {
  return pageDetection.titleForVideo(video, url);
}

function pageThumbnailUrl() {
  return pageDetection.pageThumbnailUrl();
}

function thumbnailForVideo(video) {
  return pageDetection.thumbnailForVideo(video);
}

function videoElementDetails(video) {
  return pageDetection.videoElementDetails(video);
}

function buildCandidate(url, source, mimeType = "", video = null) {
  return pageDetection.buildCandidate(url, source, mimeType, video);
}

function currentYouTubeVideoPageUrl() {
  return pageDetection.currentYouTubeVideoPageUrl();
}

function youtubePageCandidateForVideo(video) {
  return pageDetection.youtubePageCandidateForVideo(video);
}

function pageFallbackCandidateForVideo(video) {
  return pageDetection.pageFallbackCandidateForVideo(video);
}

function candidateMetadataSignature(candidate) {
  return pageDetection.candidateMetadataSignature(candidate);
}

function addBuiltCandidate(candidates, candidate) {
  return pageDetection.addBuiltCandidate(candidates, candidate);
}

function addCandidate(candidates, url, source, mimeType = "", video = null) {
  return pageDetection.addCandidate(candidates, url, source, mimeType, video);
}

function videoHasBlockedMediaSource(video) {
  return pageDetection.videoHasBlockedMediaSource(video);
}

function videoMetrics(video, candidate) {
  return pageDetection.videoMetrics(video, candidate);
}

function findOverlayCandidate(video, candidates) {
  return pageDetection.findOverlayCandidate(video, candidates);
}

function isLikelyRealPlayer(video) {
  return pageDetection.isLikelyRealPlayer(video);
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
  (document.body || document.documentElement).append(root);
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
    window.setTimeout(showAvailableVideosOverlay, 2000);
    return;
  }

  dialog.title.textContent = "Queued";
  window.setTimeout(hideOverlay, 1500);
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
    rect.width >= 220 &&
    rect.height >= 120 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  if (!visible) {
    record.button.style.display = "none";
    return;
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
    (document.body || document.documentElement).append(button);
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
  const videos = Array.from(document.querySelectorAll("video"));

  for (const video of videos) {
    const videoCandidates = [];
    const primary = addCandidate(candidates, video.currentSrc || video.src, "dom-video", video.type || "", video);
    if (primary) {
      videoCandidates.push(primary);
    }

    for (const source of Array.from(video.querySelectorAll("source"))) {
      const candidate = addCandidate(candidates, source.src, "dom-source", source.type || "", video);
      if (candidate) {
        videoCandidates.push(candidate);
      }
    }

    const youtubeCandidate = addBuiltCandidate(candidates, youtubePageCandidateForVideo(video));
    if (youtubeCandidate) {
      videoCandidates.push(youtubeCandidate);
    }

    const pageFallbackCandidate = pageFallbackCandidateForVideo(video);
    const storedPageFallbackCandidate = addBuiltCandidate(candidates, pageFallbackCandidate);
    if (storedPageFallbackCandidate) {
      videoCandidates.push(storedPageFallbackCandidate);
    }

    const overlayCandidate = findOverlayCandidate(video, videoCandidates);
    updateOverlay(
      video,
      overlayCandidate || pageFallbackCandidate,
      !overlayCandidate && !pageFallbackCandidate && !videoHasBlockedMediaSource(video) && isLikelyRealPlayer(video),
    );
  }

  for (const source of Array.from(document.querySelectorAll("source"))) {
    if (
      String(source.type || "")
        .toLowerCase()
        .startsWith("video/")
    ) {
      addCandidate(candidates, source.src, "dom-source", source.type || "");
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
    addCandidate(candidates, entry.name, "performance");
  }
  return candidates;
}

function scanTextForMediaUrls(text, source) {
  return pageDetection.scanTextForMediaUrls(text, source);
}

function scanInlinePlayerScripts() {
  const candidates = [];
  for (const script of Array.from(document.scripts || [])) {
    if (script.src) {
      continue;
    }
    candidates.push(...scanTextForMediaUrls(script.textContent || "", "script-config"));
  }
  return candidates;
}

function scanVisiblePlayerFrames() {
  const candidates = [];
  for (const frame of Array.from(document.querySelectorAll("iframe[src]"))) {
    const src = toAbsoluteUrl(frame.getAttribute("src") || frame.src || "");
    if (!src || !videoFilters.isDownloadableUrl(src, "")) {
      continue;
    }
    const rect = frame.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 120) {
      continue;
    }
    const iframeTitle = cleanText(frame.getAttribute("title"));
    const finalTitle =
      iframeTitle && !videoFilters.isGenericTitle(iframeTitle)
        ? iframeTitle
        : cleanText(document.title) || titleFromUrl(src) || "Video";

    addBuiltCandidate(candidates, {
      url: src,
      format: detectFormat(src),
      source: "iframe-page",
      contentType: "",
      pageUrl: src,
      frameUrl: location.href,
      title: finalTitle,
      thumbnailUrl: pageThumbnailUrl(),
      downloadable: true,
      width: rect.width,
      height: rect.height,
      duration: 0,
    });
  }
  return candidates;
}

function publishScan() {
  const videos = [
    ...scanVideoElements(),
    ...scanPerformanceEntries(),
    ...scanInlinePlayerScripts(),
    ...scanVisiblePlayerFrames(),
  ];
  lastDetectedVideos = videos;
  if (videos.length > 0) {
    sendMessage({ type: "contentDetectedVideos", videos });
  }
}

function scheduleScan() {
  window.setTimeout(publishScan, 250);
  window.setTimeout(positionAllOverlays, 300);
}

function watchVideoElement(video) {
  for (const eventName of ["loadedmetadata", "loadeddata", "play", "playing", "canplay"]) {
    video.addEventListener(eventName, scheduleScan, { passive: true });
  }
}

function installVideoWatchers(root = document) {
  for (const video of Array.from(root.querySelectorAll ? root.querySelectorAll("video") : [])) {
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
      if (node.matches && node.matches("video, source")) {
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
  publishScan();
  window.setInterval(publishScan, 3000);
  window.setInterval(positionAllOverlays, 600);
}

window.addEventListener("scroll", positionAllOverlays, true);
window.addEventListener("resize", positionAllOverlays, true);

extensionApi.runtime.onMessage.addListener((message) => {
  if (message && message.type === "scanNow") {
    seenUrls.clear();
    publishScan();
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
