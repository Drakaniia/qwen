"use strict";

import { browserApi } from "../shared/browser_api.js";
import * as headerUtils from "./header_utils.js";

/**
 * Pattern to detect Service Worker script URLs used as request initiators.
 */
const SERVICE_WORKER_SCOPE_RE = /(?:^|[/?#._-])(?:sw(?:\.js|\b)|serviceworker(?:\.js|\b)|service-worker(?:\.js|\b)|worker\.js)(?:$|[?#])/i;

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
 * invoke sensitive operations (CDM, debugger, recording).
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
    const source = isServiceWorkerScopeUrl(initiator) ? "service-worker" : (contentType ? "headers" : "network");

    addDetectedVideo(details.tabId, {
      url: details.url,
      format: detectFormat(details.url, contentType),
      source,
      pageUrl: details.documentUrl || details.initiator || "",
      contentType,
      sizeBytes: contentLengthFromHeaders(details.responseHeaders),
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
  browserApi.webRequest.onBeforeSendHeaders.addListener(
    handleBeforeSendHeaders,
    { urls: VIDEO_REQUEST_PATTERNS },
    ["requestHeaders", "extraHeaders"],
  );

  // Response headers for video detection — narrow patterns only
  browserApi.webRequest.onHeadersReceived.addListener(handleHeadersReceived, { urls: VIDEO_REQUEST_PATTERNS }, [
    "responseHeaders",
  ]);
}

export { isExtensionPageSender, VIDEO_REQUEST_PATTERNS };
