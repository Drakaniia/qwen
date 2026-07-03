"use strict";

import * as videoFilters from "../shared/video_filters.js";
import * as pageDetectionModule from "./page_detection.js";
import * as mediaSourceIntercept from "./media_source_intercept.js";
import * as emeIntercept from "./eme_intercept.js";
import * as p2pDetection from "./p2p_detection.js";
import * as fetchIntercept from "./fetch_intercept.js";
import * as serviceWorkerCapture from "./service_worker_capture.js";
import * as ssrDetectionModule from "./ssr_detection.js";
import {
  initOverlay,
  updateQualityLoadingStatus,
  positionAllOverlays,
  updateOverlay,
  setOverlayEnabled,
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
      pageTitle && !videoFilters.isGenericTitle(pageTitle)
        ? pageTitle
        : iframeTitle && !videoFilters.isGenericTitle(iframeTitle)
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

/**
 * Scan SSR (Server-Side Rendered) JSON globals for HLS manifest URLs.
 * Detects __NEXT_DATA__, __NUXT__, __INITIAL_STATE__, and other SSR globals.
 */
function scanSsrSources() {
  const candidates = [];
  try {
    const ssrResults = ssrDetectionModule.scanSSRGlobals(document, window);
    for (const result of ssrResults) {
      const absoluteUrl = pageDetection.toAbsoluteUrl(result.url);
      if (!absoluteUrl) continue;
      const candidate = pageDetection.buildCandidate(absoluteUrl, result.source);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  } catch (_e) {
    // SSR scanning is best-effort
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
    ...scanSsrSources(),
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

  // Initialize SSR detection for server-rendered JSON manifests
  ssrDetectionModule.init({
    onCandidates: (ssrCandidates) => {
      // Debounce: group rapid SSR scans into a single publish
      if (ssrCandidates.length > 0) {
        // Merge SSR candidates into the next publishScan cycle
        // by triggering a fresh full scan
        seenUrls.clear();
        publishScan();
      }
    },
  });

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

  // Check current overlay setting from background before any scan runs.
  // This prevents a flash of overlays when the user has disabled them.
  sendMessageWithResponse({ type: "getSettings" })
    .then(function (response) {
      if (response && response.ok && response.settings && response.settings.overlayEnabled === false) {
        setOverlayEnabled(false);
      }
    })
    .catch(function () {
      // Overlay setting check is best-effort
    })
    .finally(function () {
      publishScan();
    });

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
  } else if (message && message.type === "setOverlayEnabled") {
    setOverlayEnabled(message.enabled !== false);
  } else if (message && message.type === "qwinCheckCloudflareChallenge") {
    // Check if the page is showing a Cloudflare challenge page.
    // The background script uses this to verify the challenge is solved.
    const hasChallenge = checkForCloudflareChallenge();
    if (typeof browser !== "undefined") {
      return Promise.resolve({ hasChallenge });
    }
    if (sendResponse) {
      sendResponse({ hasChallenge });
    }
    return true;
  }
});

/**
 * Check if the current page is showing a Cloudflare challenge.
 * Scans DOM for challenge elements like Turnstile widgets, challenge
 * platform scripts, challenge iframes, and other Cloudflare indicators.
 * @returns {boolean} True if a Cloudflare challenge is detected.
 */
function checkForCloudflareChallenge() {
  try {
    // Cloudflare Turnstile widget
    if (document.querySelector("#cf-turnstile") || document.querySelector("[data-turnstile]")) {
      return true;
    }

    // Challenge platform script (Turnstile, JS challenge, etc.)
    if (document.querySelector('script[src*="challenge-platform"]')) {
      return true;
    }

    // Classic challenge page elements
    if (
      document.querySelector("#cf-please-wait") ||
      document.querySelector("#cf-chl-blocked") ||
      document.querySelector("#cf-challenge") ||
      document.querySelector("#challenge-form") ||
      document.querySelector(".cf-browser-verification")
    ) {
      return true;
    }

    // Challenge iframes
    if (document.querySelector('iframe[src*="challenge"]') || document.querySelector('iframe[src*="turnstile"]')) {
      return true;
    }

    // JavaScript challenge answer form
    if (document.querySelector('input[name="jschl_answer"]')) {
      return true;
    }

    // Check for meta refresh (used in 5-second challenge pages)
    const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
      const content = (metaRefresh.content || "").toLowerCase();
      if (content.includes("challenge") || content.includes("verify")) {
        return true;
      }
    }

    return false;
  } catch (_e) {
    // Fail closed: if we can't inspect the DOM, assume challenged
    return true;
  }
}

/**
 * Exported for testing purposes.
 */
export { checkForCloudflareChallenge };

window.addEventListener("qwin-video-scan-now", () => {
  seenUrls.clear();
  publishScan();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
