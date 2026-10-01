"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as headerUtils from "./header_utils.js";
import { hasMediaContentType } from "../shared/media_protocols.js";
import { isStreamingUrl, isLikelyStreamingUrl, classifyStreamingUrl } from "../shared/streaming_patterns.js";

/**
 * Pattern to detect Service Worker script URLs used as request initiators.
 */
const SERVICE_WORKER_SCOPE_RE =
  /(?:^|[/?#._-])(?:sw(?:\.js|\b)|serviceworker(?:\.js|\b)|service-worker(?:\.js|\b)|worker\.js)(?:$|[?#])/i;

/**
 * Check if a URL corresponds to a Service Worker script scope.
 */
function isServiceWorkerScopeUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  return SERVICE_WORKER_SCOPE_RE.test(url);
}

/**
 * Handle WebSocket upgrade requests detected via webRequest.
 */
function handleWebSocketRequest(details) {
  if (!details || details.tabId < 0 || !details.url) {
    return;
  }
}

/**
 * Narrow URL patterns to avoid using "<all_urls>" for webRequest listeners.
 *
 * Covers common video file extensions and CDN URL patterns.
 */
const VIDEO_REQUEST_PATTERNS = [
  "*://*/*.mp4*",
  "*://*/*.m3u8*",
  "*://*/*.ts*",
  "*://*/*.webm*",
  "*://*/*.mkv*",
  "*://*/*.avi*",
  "*://*/*.mov*",
  "*://*/*.flv*",
  "*://*/*.wmv*",
  "*://*/*.m4s*",
  "*://*/*.mpd*",
  "*://*/*.key*",
  "*://*/*videoplayback*",
  "*://*/*dash*",
  "*://*/*hls*",
  "*://*/*segment*",
  "*://*/*media*",
  "*://*/*stream*",
  "*://*/*cdn*",
];

/**
 * Check that the message sender is from an extension page (popup, options, etc.)
 * rather than a web page content script.
 *
 * Blocks compromised content scripts while allowing extension UI pages to
 * invoke sensitive operations (debugger, recording).
 */
function isExtensionPageSender(sender) {
  if (!sender || !sender.url) {
    return false;
  }
  return /^(chrome|moz)-extension:\/\//i.test(sender.url);
}

/**
 * Initialize web request handlers with dependencies from background.js.
 *
 * @param {Object} deps - Dependencies injected from background.js
 * @param {Function} deps.clearTab - Clear tab function
 * @param {Function} deps.addDetectedVideo - Add detected video function (tabId, input, notify)
 * @param {Function} deps.detectFormat - Detect video format from URL/contentType
 * @param {Function} deps.isLikelyVideoRequest - Check if request is a video
 * @param {RegExp} deps.VIDEO_EXTENSION_RE - Video extension regex
 * @param {RegExp} deps.HLS_RE - HLS playlist regex
 * @param {RegExp} deps.CDN_HINT_RE - CDN hint regex
 * @param {Function} deps.contentTypeFromHeaders - Extract content-type from headers
 * @param {Function} deps.contentLengthFromHeaders - Extract content-length from headers
 */
export function initWebRequestHandlers(deps) {
  const {
    clearTab,
    addDetectedVideo,
    detectFormat,
    isLikelyVideoRequest,
    VIDEO_EXTENSION_RE,
    HLS_RE,
    CDN_HINT_RE,
    contentTypeFromHeaders,
    contentLengthFromHeaders,
  } = deps;

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
    headerUtils.rememberRequestHeaders(details);
  }

  function handleHeadersReceived(details) {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    const contentType = contentTypeFromHeaders(details.responseHeaders);
    if (!isLikelyVideoRequest(details.url, details.type, contentType)) {
      return;
    }

    const initiator = details.initiator || details.documentUrl || "";
    const source = isServiceWorkerScopeUrl(initiator) ? "service-worker" : contentType ? "headers" : "network";

    addDetectedVideo(details.tabId, {
      url: details.url,
      format: detectFormat(details.url, contentType),
      source,
      pageUrl: details.documentUrl || details.initiator || "",
      contentType,
      sizeBytes: contentLengthFromHeaders(details.responseHeaders),
    });
  }

  /**
   * Broad onHeadersReceived listener — checks ALL responses (not just
   * VIDEO_REQUEST_PATTERNS) for media-related Content-Type headers.
   *
   * This is Coc Coc's key innovation: many CDNs serve video through URLs
   * without standard file extensions (.mp4, .m3u8). The only reliable way
   * to detect them is by checking Content-Type headers on every response.
   *
   * Previously, Qwin only checked responses matching narrow extension
   * patterns (VIDEO_REQUEST_PATTERNS). This missed videos served from
   * generic-looking CDN URLs.
   */
  function handleHeadersReceivedBroad(details) {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    // Skip if already handled by the narrow handler (avoid duplicates)
    if (VIDEO_EXTENSION_RE.test(details.url) || CDN_HINT_RE.test(details.url)) {
      return;
    }

    const contentType = contentTypeFromHeaders(details.responseHeaders);

    // Coc Coc approach: check ALL response content-types for media
    if (!hasMediaContentType(contentType)) {
      return;
    }

    // Also check if the URL matches streaming CDN patterns
    const streamingResult = classifyStreamingUrl(details.url, contentType);
    if (streamingResult.type === "unknown" && !isLikelyStreamingUrl(details.url)) {
      return;
    }

    const source = streamingResult.isStreaming ? "streaming-pattern" : "headers-broad";

    addDetectedVideo(details.tabId, {
      url: details.url,
      format: streamingResult.format || detectFormat(details.url, contentType),
      source,
      pageUrl: details.documentUrl || details.initiator || "",
      contentType,
      sizeBytes: contentLengthFromHeaders(details.responseHeaders),
    });
  }

  /**
   * Broad onBeforeRequest listener — detects video streams by URL pattern
   * matching alone, before any response headers arrive.
   *
   * Coc Coc's isSpecialUrls() approach: certain URL patterns are known to
   * deliver video streams even though the URL doesn't have a video extension.
   * Pattern-matched URLs are flagged immediately rather than waiting for
   * response headers.
   */
  function handleBeforeRequestStreaming(details) {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    // Skip if it already matches a video extension (handled by narrow listener)
    if (VIDEO_EXTENSION_RE.test(details.url)) {
      return;
    }

    // Coc Coc pattern matching: detect streaming URLs without standard extensions
    if (!isStreamingUrl(details.url) && !isLikelyStreamingUrl(details.url)) {
      return;
    }

    addDetectedVideo(details.tabId, {
      url: details.url,
      format: "M3U8", // Best guess — yt-dlp handles the actual format detection
      source: "streaming-pattern",
      pageUrl: details.documentUrl || details.initiator || "",
    });
  }

  // Tab clearing on main_frame navigation — still needs <all_urls>
  browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, {
    urls: ["<all_urls>"],
    types: ["main_frame"],
  });

  // Video detection — narrow patterns only
  browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequest, {
    urls: VIDEO_REQUEST_PATTERNS,
  });

  // WebSocket stream detection — <all_urls> required because WebSocket URLs use ws:///wss://
  browserApi.webRequest.onBeforeRequest.addListener(handleWebSocketRequest, {
    urls: ["<all_urls>"],
    types: ["websocket"],
  });

  // Request headers for video download context — narrow patterns + extraHeaders
  browserApi.webRequest.onBeforeSendHeaders.addListener(handleBeforeSendHeaders, { urls: VIDEO_REQUEST_PATTERNS }, [
    "requestHeaders",
    "extraHeaders",
  ]);

  // Response headers for video detection — narrow patterns only
  browserApi.webRequest.onHeadersReceived.addListener(handleHeadersReceived, { urls: VIDEO_REQUEST_PATTERNS }, [
    "responseHeaders",
  ]);

  // ── Coc Coc-style broad scanning ──────────────────────────────────────
  //
  // These listeners check ALL network requests (not just VIDEO_REQUEST_PATTERNS)
  // for signs of video streaming. This catches videos served from CDN URLs
  // that don't have standard file extensions (.mp4, .m3u8).

  // Broad onBeforeRequest: detect streaming URL patterns (no extension needed)
  browserApi.webRequest.onBeforeRequest.addListener(handleBeforeRequestStreaming, {
    urls: ["<all_urls>"],
  });

  // Broad onHeadersReceived: check ALL responses for media Content-Type
  browserApi.webRequest.onHeadersReceived.addListener(handleHeadersReceivedBroad, { urls: ["<all_urls>"] }, [
    "responseHeaders",
  ]);
}

export { isExtensionPageSender, VIDEO_REQUEST_PATTERNS };
