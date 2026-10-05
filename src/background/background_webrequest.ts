import { browserApi } from "../shared/browser_api.js";
import * as headerUtils from "./header_utils.js";
import { hasMediaContentType } from "../shared/media_protocols.js";
import { isStreamingUrl, isLikelyStreamingUrl, classifyStreamingUrl } from "../shared/streaming_patterns.js";
import type { TabId, VideoInput } from "./types.js";

/**
 * Pattern to detect Service Worker script URLs used as request initiators.
 */
const SERVICE_WORKER_SCOPE_RE =
  /(?:^|[/?#._-])(?:sw(?:\.js|\b)|serviceworker(?:\.js|\b)|service-worker(?:\.js|\b)|worker\.js)(?:$|[?#])/i;

/**
 * Check if a URL corresponds to a Service Worker script scope.
 */
function isServiceWorkerScopeUrl(url: unknown): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }
  return SERVICE_WORKER_SCOPE_RE.test(url);
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
 * The page URL a request was made from.
 *
 * `WebRequestDetails.documentUrl` was replaced by `documentId` in Chrome 106 and the
 * project floors at 148, so the declared details type no longer carries it — but the
 * request object's field is still what the page-scoped bookkeeping wants, so it is
 * read through a cast with `initiator` (which survives in the type) as the fallback.
 * This is the only place the two are mixed.
 */
function pageUrlFor(details: { documentUrl?: string; initiator?: string }): string {
  return details.documentUrl || details.initiator || "";
}

/** What `background.ts` injects so this module owns no detection logic itself. */
export interface WebRequestDeps {
  clearTab(tabId: TabId): void;
  addDetectedVideo(tabId: TabId, input: VideoInput, notify?: boolean): Promise<unknown>;
  detectFormat(url: string, contentType?: string): string;
  isLikelyVideoRequest(url: string, resourceType: string, contentType?: string): boolean;
  isBlockedMediaUrl(url: string, contentType?: string): boolean;
  VIDEO_EXTENSION_RE: RegExp;
  HLS_RE: RegExp;
  CDN_HINT_RE: RegExp;
  contentTypeFromHeaders(headers?: chrome.webRequest.HttpHeader[]): string;
  contentLengthFromHeaders(headers?: chrome.webRequest.HttpHeader[]): number | null;
}

/**
 * Initialize web request handlers with dependencies from background.ts.
 */
export function initWebRequestHandlers(deps: WebRequestDeps): void {
  const {
    clearTab,
    addDetectedVideo,
    detectFormat,
    isLikelyVideoRequest,
    isBlockedMediaUrl,
    VIDEO_EXTENSION_RE,
    HLS_RE,
    CDN_HINT_RE,
    contentTypeFromHeaders,
    contentLengthFromHeaders,
  } = deps;

  function handleBeforeRequest(details: chrome.webRequest.OnBeforeRequestDetails): void {
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

    void addDetectedVideo(details.tabId, {
      url: details.url,
      format: detectFormat(details.url),
      source: HLS_RE.test(details.url) ? "hls-network" : "network",
      pageUrl: pageUrlFor(details),
    });
  }

  function handleBeforeSendHeaders(details: chrome.webRequest.OnBeforeSendHeadersDetails): void {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }
    if (details.type !== "media" && !VIDEO_EXTENSION_RE.test(details.url) && !CDN_HINT_RE.test(details.url)) {
      return;
    }
    headerUtils.rememberRequestHeaders(details);
  }

  function handleHeadersReceived(details: chrome.webRequest.OnHeadersReceivedDetails): void {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    const contentType = contentTypeFromHeaders(details.responseHeaders);
    if (!isLikelyVideoRequest(details.url, details.type, contentType)) {
      return;
    }

    const initiator = pageUrlFor(details);
    const source = isServiceWorkerScopeUrl(initiator) ? "service-worker" : contentType ? "headers" : "network";

    void addDetectedVideo(details.tabId, {
      url: details.url,
      format: detectFormat(details.url, contentType),
      source,
      pageUrl: pageUrlFor(details),
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
  function handleHeadersReceivedBroad(details: chrome.webRequest.OnHeadersReceivedDetails): void {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    const contentType = contentTypeFromHeaders(details.responseHeaders);
    // Block list is authoritative on every path — streaming patterns must not
    // resurrect a URL the shared tables rejected (e.g. /cdn-cgi/ infra).
    if (isBlockedMediaUrl(details.url, contentType)) {
      return;
    }

    // Skip if already handled by the narrow handler (avoid duplicates)
    if (VIDEO_EXTENSION_RE.test(details.url) || CDN_HINT_RE.test(details.url)) {
      return;
    }

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

    void addDetectedVideo(details.tabId, {
      url: details.url,
      format: streamingResult.format || detectFormat(details.url, contentType),
      source,
      pageUrl: pageUrlFor(details),
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
  function handleBeforeRequestStreaming(details: chrome.webRequest.OnBeforeRequestDetails): void {
    if (!details || details.tabId < 0 || !details.url) {
      return;
    }

    // Block list is authoritative — never pattern-match an infra/ad URL
    // into a fake M3U8 (e.g. /cdn-cgi/challenge-platform matched `cdn`).
    if (isBlockedMediaUrl(details.url)) {
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

    void addDetectedVideo(details.tabId, {
      url: details.url,
      format: "M3U8", // Best guess — yt-dlp handles the actual format detection
      source: "streaming-pattern",
      pageUrl: pageUrlFor(details),
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

export { VIDEO_REQUEST_PATTERNS };
