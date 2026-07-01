"use strict";

import * as videoFilters from "../shared/video_filters.js";
import * as pageDetectionModule from "./page_detection.js";
import * as mediaSourceIntercept from "./media_source_intercept.js";
import * as emeIntercept from "./eme_intercept.js";
import * as p2pDetection from "./p2p_detection.js";
import * as fetchIntercept from "./fetch_intercept.js";
import * as serviceWorkerCapture from "./service_worker_capture.js";
import {
  initOverlay,
  updateQualityLoadingStatus,
  positionAllOverlays,
  updateOverlay,
} from "./content_overlay.js";

const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const seenUrls = new Map();
const pageDetection = pageDetectionModule.create({
  document,
  location,
  videoFilters,
  seenUrls,
});
const watchedVideos = new WeakSet();

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

// ─── Video scanning ────────────────────────────────────────────────────────

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
    const pageTitle = pageDetection.cleanText(document.title);
    // Prefer document.title (page-level content title) over iframe title,
    // because iframe title attributes often reflect the embedded player's
    // branding ("VibePlayer - Fast Streaming with FullHD") rather than
    // the actual content being watched.
    const finalTitle =
      (pageTitle && !videoFilters.isGenericTitle(pageTitle))
        ? pageTitle
        : (iframeTitle && !videoFilters.isGenericTitle(iframeTitle))
          ? iframeTitle
          : pageDetection.titleFromUrl(src) || "Video";

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

// ─── Video watching ────────────────────────────────────────────────────────

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

// ─── Mutation observer ─────────────────────────────────────────────────────

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

// ─── Start ─────────────────────────────────────────────────────────────────

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

  // Initialize Service Worker media capture (best-effort)
  serviceWorkerCapture.initMediaCaptureSW().then((active) => {
    if (active) {
      console.log("[qwin] Service Worker media capture active");
    } else {
      // Fall back to fetch/XHR interception when SW capture is unavailable
      // (existing SW on page, unsupported environment, or registration failure)
      const fiActive = fetchIntercept.initFetchIntercept();
      if (fiActive) {
        console.log("[qwin] Fetch/XHR intercept active (SW capture fallback)");
      }
    }
  });

  // Initialize overlay with core dependencies
  initOverlay({
    sendMessageWithResponse,
    getLastDetectedVideos: () => lastDetectedVideos,
  });

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
