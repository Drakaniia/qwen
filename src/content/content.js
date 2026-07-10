"use strict";

import * as videoFilters from "../shared/video_filters.js";
import * as pageDetectionModule from "./page_detection.js";
import {
  initOverlay,
  updateQualityLoadingStatus,
  positionAllOverlays,
  updateOverlay,
  setOverlayEnabled,
} from "./content_overlay.js";
import {
  isStreamingUrl,
  isLikelyStreamingUrl,
  extractStreamingUrlsFromText,
  needsBackgroundProxy,
} from "../shared/streaming_patterns.js";

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

/**
 * Fetch a URL through the background service worker to bypass CORS.
 *
 * Coc Coc's approach: content scripts cannot fetch media URLs from CDNs
 * (googlevideo, akamai, cloudfront) due to CORS restrictions. By proxying
 * through the background worker, we bypass browser CORS checks and can
 * verify Content-Type headers.
 *
 * @param {string} url - The URL to fetch
 * @param {object} [options]
 * @param {string} [options.method="GET"] - HTTP method
 * @param {object} [options.headers] - Additional headers
 * @param {boolean} [options.includeCredentials=false] - Include cookies
 * @returns {Promise<{ok: boolean, body?: string, contentType?: string, status?: number, error?: string}>}
 */
async function fetchWithBackgroundProxy(url, options = {}) {
  return sendMessageWithResponse({
    type: "proxyFetch",
    url,
    method: options.method || "GET",
    headers: options.headers || null,
    includeCredentials: options.includeCredentials || false,
  });
}

/**
 * For candidate URLs that match CORS-restricted CDNs, issue a background
 * proxy HEAD request to verify they actually serve media content. If
 * verified, re-trigger the scan pipeline so the verified candidate is
 * included in the next publishScan() cycle.
 *
 * This mirrors Coc Coc's background-request-proxy strategy: CDN-hosted
 * streaming URLs cannot be fetched by content scripts, so we route the
 * verification through the extension background worker.
 */
function verifyStreamingUrlsViaProxy() {
  const mediaContentTypes = [
    "video/",
    "audio/",
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "application/dash+xml",
    "application/xml",
    "text/xml",
    "application/json",
  ];

  // Collect existing candidates that need proxy verification
  const toVerify = [];
  for (const vid of lastDetectedVideos) {
    if (vid.url && needsBackgroundProxy(vid.url) && vid.source !== "proxy-verified") {
      toVerify.push(vid);
    }
  }
  if (toVerify.length === 0) return;

  // Fire HEAD requests through background proxy
  for (const vid of toVerify) {
    fetchWithBackgroundProxy(vid.url, { method: "HEAD" })
      .then((result) => {
        if (!result.ok) return;
        const ct = (result.contentType || "").toLowerCase();
        const isMedia = mediaContentTypes.some((mct) => ct.includes(mct));
        if (isMedia) {
          // Mark existing candidate as proxy-verified
          const existing = lastDetectedVideos.find((v) => v.url === vid.url);
          if (existing) {
            existing.source = "proxy-verified";
            existing.proxyContentType = ct;
          }
          // Re-publish with updated source info
          sendMessage({ type: "contentDetectedVideos", videos: lastDetectedVideos });
        }
      })
      .catch(() => {
        // Proxy fetch failure is non-critical; candidate already listed
      });
  }
}

/**
 * Scan page content for streaming URLs embedded in scripts, configs,
 * and data attributes using Coc Coc's pattern-based approach.
 *
 * Many websites embed video URLs in:
 *   - Inline <script> blocks with player config objects
 *   - JSON-LD structured data
 *   - data-* attributes on HTML elements
 *   - Server-rendered window.__INITIAL_STATE__ or similar globals
 *   - noscript fallback URLs
 *
 * Unlike scanInlinePlayerScripts() which only looks for standard video
 * extensions, this uses the streaming_patterns library to detect URLs
 * from known CDNs, signed URLs, and platform-specific patterns.
 *
 * @returns {Array<object>} Detected video candidates
 */
function scanStreamingUrls() {
  const candidates = [];

  // 1. Scan all inline scripts for embedded streaming URLs
  for (const script of Array.from(document.scripts || [])) {
    if (script.src) continue; // External script — skip (already scanned by webRequest)
    const urls = extractStreamingUrlsFromText(script.textContent || "");
    for (const { url, confidence } of urls) {
      pageDetection.addCandidate(candidates, url, "ssr-json:" + confidence);
    }
  }

  // 2. Scan JSON-LD structured data
  for (const jsonld of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(jsonld.textContent || "{}");
      const jsonStr = JSON.stringify(data);
      const urls = extractStreamingUrlsFromText(jsonStr);
      for (const { url, confidence } of urls) {
        pageDetection.addCandidate(candidates, url, "ssr-json:" + confidence);
      }
    } catch (_e) {
      // Skip malformed JSON-LD
    }
  }

  // 3. Scan data-* attributes on video-related elements
  const videoElements = document.querySelectorAll(
    "video, source, [data-video], [data-src], [data-url], [data-file], [data-hls], [data-m3u8], [data-mpd]",
  );
  for (const el of Array.from(videoElements)) {
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith("data-") && attr.value) {
        const attrUrl = pageDetection.toAbsoluteUrl(attr.value);
        if (attrUrl && (isStreamingUrl(attrUrl) || isLikelyStreamingUrl(attrUrl))) {
          pageDetection.addCandidate(candidates, attrUrl, "data-attr");
        }
      }
    }
  }

  // 4. Scan noscript tags for fallback video URLs
  for (const noscript of Array.from(document.querySelectorAll("noscript"))) {
    const text = noscript.textContent || noscript.innerHTML || "";
    if (text.includes("<video") || text.includes("<source")) {
      const urlMatch = text.match(/src=["']([^"']+)["']/gi);
      if (urlMatch) {
        for (const match of urlMatch) {
          const url = match.replace(/src=["']/i, "").replace(/["']/g, "");
          const absoluteUrl = pageDetection.toAbsoluteUrl(url);
          if (absoluteUrl) {
            pageDetection.addCandidate(candidates, absoluteUrl, "noscript");
          }
        }
      }
    }
  }

  return candidates;
}

function publishScan() {
  const videos = [
    ...scanVideoElements(),
    ...scanPerformanceEntries(),
    ...scanInlinePlayerScripts(),
    ...scanVisiblePlayerFrames(),
    ...scanMusicSources(),
    ...scanStreamingUrls(),
  ];
  lastDetectedVideos = videos;
  if (videos.length > 0) {
    sendMessage({ type: "contentDetectedVideos", videos });
  }
  // Async: try to verify CORS-blocked CDN URLs via background proxy
  // (Coc Coc approach — non-blocking, re-emits if new verification found)
  verifyStreamingUrlsViaProxy();
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
  // Video stream detection is handled by background network request interception and content script DOM scanning

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
  }
});

function checkForCloudflareChallenge() {
  return false;
}

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
