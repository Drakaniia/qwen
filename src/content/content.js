"use strict";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const videoFilters = globalThis.QwinVideoFilters;
const seenUrls = new Set();
const overlayByVideo = new WeakMap();
const overlayRecords = new Set();
let qualityDialog = null;

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
  if (!value) {
    return "";
  }
  try {
    return new URL(value, document.baseURI).href;
  } catch (_error) {
    return "";
  }
}

function detectFormat(url, mimeType = "") {
  return videoFilters.classifyVideoUrl(url, mimeType);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return cleanText(file.replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "").replace(/[_-]+/g, " "));
  } catch (_error) {
    return "";
  }
}

function titleForVideo(video, url) {
  const labelledBy = video.getAttribute("aria-labelledby");
  const labelledByText = labelledBy
    ? cleanText(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
      )
    : "";

  return (
    cleanText(video.getAttribute("title")) ||
    cleanText(video.getAttribute("aria-label")) ||
    labelledByText ||
    cleanText(document.querySelector('meta[property="og:title"]')?.content) ||
    cleanText(document.querySelector('meta[name="twitter:title"]')?.content) ||
    cleanText(document.title) ||
    titleFromUrl(url) ||
    "Video"
  );
}

function buildCandidate(url, source, mimeType = "", video = null) {
  const absoluteUrl = toAbsoluteUrl(url);
  if (!absoluteUrl || videoFilters.isBlockedVideoUrl(absoluteUrl, mimeType)) {
    return null;
  }

  const likelyVideo =
    absoluteUrl.startsWith("blob:") ||
    videoFilters.isLikelyVideoRequest(absoluteUrl, "media", mimeType);

  if (!likelyVideo) {
    return null;
  }

  return {
    url: absoluteUrl,
    format: detectFormat(absoluteUrl, mimeType),
    source,
    contentType: mimeType || "",
    pageUrl: location.href,
    frameUrl: location.href,
    title: video ? titleForVideo(video, absoluteUrl) : cleanText(document.title) || titleFromUrl(absoluteUrl) || "Video",
  };
}

function addCandidate(candidates, url, source, mimeType = "", video = null) {
  const candidate = buildCandidate(url, source, mimeType, video);
  if (!candidate) {
    return null;
  }

  if (!seenUrls.has(candidate.url)) {
    seenUrls.add(candidate.url);
    candidates.push(candidate);
  }

  return candidate;
}

function videoHasBlockedMediaSource(video) {
  const sources = [
    { url: video.currentSrc, type: video.type || "" },
    { url: video.src, type: video.type || "" },
  ];
  for (const source of Array.from(video.querySelectorAll("source"))) {
    sources.push({ url: source.src, type: source.type || "" });
  }
  return sources.some((source) => {
    const absoluteUrl = toAbsoluteUrl(source.url);
    return absoluteUrl && videoFilters.isBlockedVideoUrl(absoluteUrl, source.type);
  });
}

function videoMetrics(video, candidate) {
  const rect = video.getBoundingClientRect();
  return {
    url: candidate.url,
    contentType: candidate.contentType || "",
    width: video.videoWidth || rect.width || video.clientWidth,
    height: video.videoHeight || rect.height || video.clientHeight,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    loop: Boolean(video.loop),
    muted: Boolean(video.muted),
    autoplay: Boolean(video.autoplay),
  };
}

function findOverlayCandidate(video, candidates) {
  return candidates.find((candidate) =>
    videoFilters.isLikelyRealVideoElement(videoMetrics(video, candidate))
  );
}

function isLikelyRealPlayer(video) {
  const rect = video.getBoundingClientRect();
  return videoFilters.isLikelyRealVideoBox({
    width: video.videoWidth || rect.width || video.clientWidth,
    height: video.videoHeight || rect.height || video.clientHeight,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    loop: Boolean(video.loop),
    muted: Boolean(video.muted),
    autoplay: Boolean(video.autoplay),
  });
}

function createOverlayButton(video) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download";
  button.title = "Download this video";
  button.setAttribute("aria-label", "Download this video");
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

    const record = overlayByVideo.get(video);
    if (!record) {
      return;
    }

    button.disabled = true;
    button.textContent = "Quality...";
    const formatsResponse = await sendMessageWithResponse(
      record.candidate
        ? {
            type: "getFormatsForUrl",
            video: record.candidate,
          }
        : {
            type: "getBestVideoFormats",
          }
    );

    if (!formatsResponse || !formatsResponse.ok) {
      button.textContent = "Error";
      button.title = formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load qualities.";
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = "Download";
      }, 2500);
      return;
    }

    const selectedFormat = await showQualityDialog(formatsResponse);
    if (!selectedFormat) {
      button.disabled = false;
      button.textContent = "Download";
      return;
    }

    button.textContent = "Sending...";
    const response = await sendMessageWithResponse(
      record.candidate
        ? {
            type: "downloadUrl",
            video: record.candidate,
            formatId: selectedFormat,
          }
        : {
            type: "downloadBestVideo",
            formatId: selectedFormat,
          }
    );

    if (!response || !response.ok) {
      button.textContent = "Error";
      button.title = response && response.error ? response.error : "Could not start download.";
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = "Download";
      }, 2500);
      return;
    }

    button.textContent = "Queued";
    window.setTimeout(() => {
      button.disabled = false;
      button.textContent = "Download";
    }, 2500);
  });
  return button;
}

function ensureQualityDialog() {
  if (qualityDialog && qualityDialog.root.isConnected) {
    return qualityDialog;
  }

  const root = document.createElement("div");
  const card = document.createElement("div");
  const title = document.createElement("div");
  const list = document.createElement("div");
  const cancel = document.createElement("button");

  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "2147483647";
  root.style.display = "none";
  root.style.placeItems = "center";
  root.style.background = "rgba(0, 0, 0, 0.48)";

  card.style.width = "min(360px, calc(100vw - 28px))";
  card.style.maxHeight = "min(420px, calc(100vh - 28px))";
  card.style.overflow = "auto";
  card.style.padding = "12px";
  card.style.border = "1px solid rgba(255, 255, 255, 0.24)";
  card.style.borderRadius = "8px";
  card.style.background = "#ffffff";
  card.style.boxShadow = "0 18px 42px rgba(0, 0, 0, 0.35)";
  card.style.font = "13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  card.style.color = "#171b22";

  title.style.fontWeight = "750";
  title.style.marginBottom = "10px";

  list.style.display = "grid";
  list.style.gap = "7px";

  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.style.marginTop = "10px";
  cancel.style.minHeight = "32px";
  cancel.style.padding = "6px 10px";
  cancel.style.border = "1px solid #dce1e8";
  cancel.style.borderRadius = "6px";
  cancel.style.background = "#fff";
  cancel.style.color = "#171b22";
  cancel.style.font = "600 13px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  cancel.style.cursor = "pointer";

  card.append(title, list, cancel);
  root.append(card);
  (document.body || document.documentElement).append(root);
  qualityDialog = { root, card, title, list, cancel };
  return qualityDialog;
}

function showQualityDialog({ title, formats }) {
  return new Promise((resolve) => {
    const dialog = ensureQualityDialog();
    dialog.title.textContent = title ? `Choose quality: ${title}` : "Choose quality";
    dialog.list.textContent = "";

    const choices = formats && formats.length ? formats : [{ id: "best", label: "Best available MP4" }];
    for (const format of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = [format.label || format.id || "Best", format.size || "", format.note || ""]
        .filter(Boolean)
        .join("  ");
      button.style.minHeight = "34px";
      button.style.padding = "7px 9px";
      button.style.border = "1px solid #dce1e8";
      button.style.borderRadius = "6px";
      button.style.background = "#fff";
      button.style.color = "#171b22";
      button.style.textAlign = "left";
      button.style.font = "600 13px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      button.style.cursor = "pointer";
      button.addEventListener("click", () => {
        dialog.root.style.display = "none";
        resolve(format.id || "best");
      });
      dialog.list.append(button);
    }

    dialog.cancel.onclick = () => {
      dialog.root.style.display = "none";
      resolve(null);
    };
    dialog.root.style.display = "grid";
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
  record.button.title = candidate
    ? "Download this video"
    : "Download the best detected video URL for this player";
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

    const overlayCandidate = findOverlayCandidate(video, videoCandidates);
    updateOverlay(
      video,
      overlayCandidate,
      !overlayCandidate && !videoHasBlockedMediaSource(video) && isLikelyRealPlayer(video)
    );
  }

  for (const source of Array.from(document.querySelectorAll("source"))) {
    if (String(source.type || "").toLowerCase().startsWith("video/")) {
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

function publishScan() {
  const videos = [...scanVideoElements(), ...scanPerformanceEntries()];
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
