import * as videoFilters from "../shared/video_filters.js";
import * as pageDetectionModule from "./page_detection.js";
import { browserApi, isPromiseApi, sendMessage as sendRuntimeMessage } from "../shared/browser_api.js";
import type { ContentCommand, ProxyFetchMessage } from "../shared/contracts.js";
import { VIDEO_EXTENSION_RE } from "../shared/media_candidates.js";
import {
  initOverlay,
  updateQualityLoadingStatus,
  positionAllOverlays,
  updateOverlay,
  setOverlayEnabled,
  setOverlayTheme,
} from "./content_overlay.js";
import type { RuntimeResponse } from "./content_overlay.js";
import {
  isStreamingUrl,
  isLikelyStreamingUrl,
  extractStreamingUrlsFromText,
  needsBackgroundProxy,
} from "../shared/streaming_patterns.js";
import type { VideoCandidate } from "./page_detection.js";

const extensionApi = browserApi.raw;
const seenUrls = new Map<string, string>();
/**
 * Phase 8 candidate-count instrumentation (spec D12, "measurement first").
 *
 * `publishScan` resets `discovered` and logs it against the scan's result. This is
 * the only place a list size is recorded anywhere in the extension: `logs/downloads.jsonl`
 * is written by the native host and only holds probe/download events, and the
 * `debugLog` path that used to produce `logs/debug.log` was deleted in `f38e6de`, so
 * there is no file logger left to write to. A content script has no filesystem access
 * in any case — `console.log` is the only sink it has, so the line is emitted in
 * `logs/debug.log`'s own `[<epochMs>] [LEVEL] message` shape and a human copies it out
 * of the page's devtools console.
 *
 * One line per scan: the 3s interval makes that 20 lines/minute on a page left open,
 * which is the cost the spec's "counter plus one log line per scan is fine" budget
 * allows. Nothing here is load-bearing, so delete this and `scanStats` once the p99
 * list size has been read off a real page range.
 */
const scanStats = { discovered: 0 };
const pageDetection = pageDetectionModule.create({
  document,
  location,
  videoFilters,
  seenUrls,
  scanStats,
});
const watchedVideos = new WeakSet<HTMLVideoElement>();

let lastDetectedVideos: VideoCandidate[] = [];

function sendMessage(message: object) {
  sendRuntimeMessage(message).catch(() => {
    // The extension context can disappear during reloads.
  });
}

/**
 * `shared/browser_api.js` normalizes every runtime failure to `{ ok: false, error }`
 * and otherwise answers with whatever the background returned, so the response shape
 * is only knowable per call site — narrowed once here to the envelope the content
 * layer reads (`RuntimeResponse`), rather than cast at each of the five sites.
 */
function sendMessageWithResponse(message: object): Promise<RuntimeResponse> {
  return sendRuntimeMessage(message) as Promise<RuntimeResponse>;
}

function findAllVideos(root: Document | ShadowRoot | Element = document): HTMLVideoElement[] {
  const videos = Array.from(root.querySelectorAll("video"));
  const allElements = root.querySelectorAll("*");
  for (const el of Array.from(allElements)) {
    // Only elements can host a shadow root, and only HTML elements have one.
    if (el instanceof HTMLElement && el.shadowRoot) {
      videos.push(...findAllVideos(el.shadowRoot));
    }
  }
  return videos;
}

// ─── Video scanning ────────────────────────────────────────────────────────

function scanVideoElements(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  const videos = findAllVideos();

  for (const video of videos) {
    const videoCandidates: VideoCandidate[] = [];
    const primary = pageDetection.addCandidate(
      candidates,
      video.currentSrc || video.src,
      "dom-video",
      // `<video>` has no `type` attribute in the DOM IDL (only `<source>` does), so
      // this mimeType has always been empty and the URL alone classifies the candidate.
      "",
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

function scanPerformanceEntries(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  if (!performance || typeof performance.getEntriesByType !== "function") {
    return candidates;
  }

  for (const entry of performance.getEntriesByType("resource")) {
    pageDetection.addCandidate(candidates, entry.name, "performance");
  }
  return candidates;
}

function scanInlinePlayerScripts(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  for (const script of Array.from(document.scripts)) {
    if (script.src) {
      continue;
    }
    candidates.push(...pageDetection.scanTextForMediaUrls(script.textContent || "", "script-config"));
  }
  return candidates;
}

function scanVisiblePlayerFrames(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[src]"))) {
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
    // `VIDEO_EXTENSION_RE` (`shared/media_patterns.ts`, re-exported by
    // `media_candidates.ts`) is the one definition of "this URL names a video or a
    // manifest" — it was a fourth verbatim copy of this literal before.
    const hasVideoExt = VIDEO_EXTENSION_RE.test(src);

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

function scanMusicSources(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
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
 * `ok`, `contentType` and `error` are the fields this reads; the rest of the
 * `RuntimeResponse` envelope is the background's business.
 */
async function fetchWithBackgroundProxy(
  url: string,
  options: { method?: string; headers?: Record<string, string>; includeCredentials?: boolean } = {},
): Promise<RuntimeResponse> {
  const message: ProxyFetchMessage & { type: "proxyFetch" } = {
    type: "proxyFetch",
    url,
    method: options.method || "GET",
    headers: options.headers,
    includeCredentials: options.includeCredentials || false,
  };
  return sendMessageWithResponse(message);
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
  const toVerify: VideoCandidate[] = [];
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
 * @returns Detected video candidates
 */
function scanStreamingUrls(): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];

  // 1. Scan all inline scripts for embedded streaming URLs
  for (const script of Array.from(document.scripts)) {
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
    for (const attr of Array.from(el.attributes)) {
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
  scanStats.discovered = 0;
  const videos: VideoCandidate[] = [
    ...scanVideoElements(),
    ...scanPerformanceEntries(),
    ...scanInlinePlayerScripts(),
    ...scanVisiblePlayerFrames(),
    ...scanMusicSources(),
    ...scanStreamingUrls(),
  ];
  lastDetectedVideos = videos;
  // `discovered` is every candidate the six scanners produced; `unique` is what is
  // left after `seenUrls` collapses repeats across and within them — the list this
  // scan hands to the background, which is what the popup's list size derives from.
  // NOT logged here: the count surviving `groupUniqueFullVideos`
  // (`shared/video_sorting.js`), which runs in `background/background.js:94` and so
  // is only observable from the background or the popup, not from a content script.
  console.log(
    `[${Date.now()}] [INFO] candidate-count host=${location.hostname} discovered=${scanStats.discovered} unique=${videos.length}`,
  );
  if (videos.length > 0) {
    // `ContentDetectedVideosMessage.videos` is `DetectedVideo[]`, which requires an
    // `id` that only `background/addDetectedVideo` assigns — a content script has
    // never known one, so the payload is sent untyped rather than cast into a lie.
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

function watchVideoElement(video: HTMLVideoElement) {
  if (!video || watchedVideos.has(video)) {
    return;
  }
  watchedVideos.add(video);
  // `seeked` joined the list for `hls-thumbnail-spec.md` §3.1. It is the only one of the
  // spec's three "there is a frame now" events these watchers did not already carry,
  // and the only one a player can reach without ever firing `play` — scrubbing a
  // `preload="none"` element. `loadeddata` and `playing` were already here, so §3.1's
  // second listener set would be a duplicate of this one on this same element: media
  // events do not bubble, so `capture: true` on a listener attached to the target is a
  // no-op (the spec's "wasted work on a page with dozens of `<video>` elements" argument
  // is about a delegated document-level listener, which this deliberately is not).
  //
  // `scheduleScan` is the whole of §3.1's "push the candidate back through the normal
  // detection path": its 250ms debounce lands a `publishScan`, which re-runs
  // `thumbnailCandidatesForVideo` → `captureFrame`, and `candidateMetadataSignature`
  // (`page_detection.js:446`) sees the changed ladder and re-emits. No new message, no
  // new state, no second `WeakSet` — `watchedVideos` already makes this once per element.
  for (const eventName of ["loadedmetadata", "loadeddata", "play", "playing", "canplay", "seeked"]) {
    video.addEventListener(eventName, scheduleScan, { passive: true });
  }
}

function installVideoWatchers(root: Document | Element = document) {
  if (root instanceof HTMLVideoElement) {
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
    if (mutation.type === "attributes" && mutation.attributeName && ["src", "type"].includes(mutation.attributeName)) {
      shouldScan = true;
    }

    for (const node of Array.from(mutation.addedNodes)) {
      // Element nodes are the only additions that can carry a `<video>` or `<source>`.
      if (!(node instanceof Element)) {
        continue;
      }
      if (node.matches("video, source") || node.querySelector("video, source")) {
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
  observer.observe(document.documentElement, {
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
      if (response && response.ok && response.settings) {
        if (response.settings.overlayEnabled === false) {
          setOverlayEnabled(false);
        }
        // The overlay's stylesheet lives in a shadow root on a third-party page, so
        // it cannot see the extension's `<html data-theme>` (spec D6). The settings
        // response this call already awaits is the channel: mirror the preference
        // onto the shadow host, which `qwin_overlay.css` keys `:host([data-theme])`
        // off. Best-effort — an unknown or absent value leaves the media query in
        // charge.
        setOverlayTheme(response.settings.theme);
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

extensionApi.runtime.onMessage.addListener(
  (message: ContentCommand | undefined, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (message && message.type === "scanNow") {
      seenUrls.clear();
      const videos = publishScan();

      // Return scan results synchronously so the background's rescanTab
      // handler can await tabs.sendMessage and get populated data back.
      // `isPromiseApi` is the browser_api shim's own capture of "does this browser
      // expose the promise-based `browser` namespace".
      if (isPromiseApi) {
        return Promise.resolve({ ok: true, videos });
      }
      if (sendResponse) {
        sendResponse({ ok: true, videos });
      }
      return true;
    } else if (message && message.type === "rescanForFrames") {
      // `hls-thumbnail-spec.md` §3.2, H11 part 2 — the popup-open backstop for a player
      // that buffered without firing a media event (autoplay-muted ones often never fire
      // `playing`). Fire-and-forget by design: no `sendResponse`, no promise, so the
      // popup never waits on it.
      //
      // Two lines because the work is already written. `publishScan` re-runs every
      // scanner, so `thumbnailCandidatesForVideo` calls `captureFrame` on each element
      // and `captureFrame` no-ops by itself on a video that still has no decoded frame —
      // an unready tab costs one scan and re-sends the list it already had. Clearing
      // `seenUrls` is the half that matters: it is what lets a video whose frame has
      // since arrived re-emit through `candidateMetadataSignature` instead of being
      // collapsed as "already seen". The same two lines `scanNow` runs, deliberately:
      // `scanNow` exists to answer, `rescanForFrames` not to.
      seenUrls.clear();
      publishScan();
    } else if (message && message.type === "updateLoadingStatus") {
      updateQualityLoadingStatus(message.text);
    } else if (message && message.type === "setOverlayEnabled") {
      setOverlayEnabled(message.enabled !== false);
    }
    return undefined;
  },
);

window.addEventListener("qwin-video-scan-now", () => {
  seenUrls.clear();
  publishScan();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
