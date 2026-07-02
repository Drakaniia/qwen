"use strict";

/**
 * Fetch / XHR Media Stream Capture Module
 *
 * Intercepts window.fetch() and XMLHttpRequest at the page level to capture
 * media response bodies. Used as a fallback when Service Worker capture
 * is unavailable (page has existing SW, cross-origin restrictions, etc.).
 *
 * Architecture:
 *   Content script injects a <script src="chrome-extension://..."> tag into
 *   the page's main world that monkey-patches window.fetch and XMLHttpRequest.
 *   External script file is used (not inline) to satisfy strict page CSP.
 *   When a media
 *   response is detected, the injected code dispatches a custom DOM event.
 *   The content script listens for this event, extracts the response data,
 *   and forwards it to the background script via runtime.sendMessage.
 *
 * Message format matches service_worker_capture.js for compatibility with
 * sw_relay.js in the background.
 *
 * Limitations:
 * - Cannot intercept streamed responses (ReadableStream) — only completed
 *   ArrayBuffer responses are captured.
 * - Large responses (>500MB) are skipped to avoid memory exhaustion.
 * - The page's own JS may detect the monkey-patch and fail.
 */

// ─── Constants ──────────────────────────────────────────────────────────

/** Regex that matches media Content-Type values we want to capture. */
const MEDIA_TYPE_REGEX = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;

/** Regex that matches segment-level media URLs. */
const SEGMENT_RE = /\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\?|$)/i;

/** Regex that matches manifest URLs. */
const MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;

/** Regex that matches direct media file URLs. */
const DIRECT_MEDIA_RE = /\.(mp4|webm|avi|mkv|mov|wmv|flv)(\?|$)/i;

/** Custom DOM event name used for communication from injected script. */
const INTERCEPT_EVENT = "qwinFetchIntercept";

/** Page-world script path (must be listed in web_accessible_resources). */
const PAGE_SCRIPT_PATH = "src/content/fetch_intercept_page.js";

// ─── State ──────────────────────────────────────────────────────────────

/** @type {Array<{url: string, contentType: string, bodyLength: number, bodyB64: string, status: number, headers: string, capturedAt: number}>} */
const capturedResponses = [];

/** @type {boolean} */
let active = false;

/** @type {boolean} */
let injectionPending = false;

/** @type {Function|null} */
let domListener = null;

/** @type {HTMLScriptElement|null} */
let injectedScript = null;

// ─── URL / Content-Type Detection ───────────────────────────────────────

/**
 * Check if a URL looks like it points to media content.
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  return SEGMENT_RE.test(url) ||
         MANIFEST_RE.test(url) ||
         DIRECT_MEDIA_RE.test(url);
}

/**
 * Convert an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize fetch/XHR media interception by injecting the intercept script
 * into the page's DOM.
 *
 * @returns {boolean} True if interception was successfully initialized.
 */
function initFetchIntercept() {
  if (active || injectionPending) return active || injectionPending;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return false;
  }

  const api = typeof browser !== "undefined" ? browser : chrome;
  if (!api?.runtime?.getURL || !api.runtime.id) {
    return false;
  }

  try {
    // Inject via extension URL — inline scripts are blocked by strict page CSP.
    const script = document.createElement("script");
    script.src = api.runtime.getURL(PAGE_SCRIPT_PATH);
    script.id = "qwin-fetch-intercept";
    script.async = false;

    setupDOMListener();
    injectionPending = true;

    const injected = new Promise((resolve) => {
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
    });

    document.documentElement.appendChild(script);
    injectedScript = script;

    injected.then((loaded) => {
      injectionPending = false;
      if (!loaded) {
        console.warn("[qwin] Fetch intercept page script failed to load");
        stopFetchIntercept();
        return;
      }
      active = true;
    });

    return true;
  } catch (e) {
    if (e.message && e.message.includes("Extension context invalidated")) {
      return false;
    }
    console.warn("[qwin] Fetch intercept injection failed:", e);
    return false;
  }
}

/**
 * Set up the DOM event listener that receives captured media data from
 * the injected script and forwards it to the background.
 */
function setupDOMListener() {
  if (domListener) {
    document.removeEventListener(INTERCEPT_EVENT, domListener);
  }

  domListener = (event) => {
    const detail = event.detail;
    if (!detail || detail.type !== "qwinMediaResponse") return;

    capturedResponses.push({
      url: detail.url,
      contentType: detail.contentType,
      bodyLength: detail.bodyLength,
      bodyB64: detail.bodyB64,
      status: detail.status,
      headers: detail.headers,
      isSegment: detail.isSegment,
      isManifest: detail.isManifest,
      capturedAt: detail.capturedAt,
    });

    // Forward to background script
    try {
      const api = typeof browser !== "undefined" ? browser : chrome;
      api.runtime.sendMessage({
        type: "swCapturedMediaResponse",
        data: detail,
      }).catch(() => {});
    } catch (_e) {
      // Extension context may be unavailable
    }
  };

  document.addEventListener(INTERCEPT_EVENT, domListener);
}

/**
 * Stop fetch/XHR interception and clean up.
 */
function stopFetchIntercept() {
  if (domListener) {
    try {
      document.removeEventListener(INTERCEPT_EVENT, domListener);
    } catch (_e) {}
    domListener = null;
  }

  if (injectedScript) {
    try {
      injectedScript.remove();
    } catch (_e) {}
    injectedScript = null;
  }

  active = false;
  injectionPending = false;
}

/**
 * Get all currently captured media responses.
 * @returns {Array<Object>}
 */
function getCapturedResponses() {
  return [...capturedResponses];
}

/**
 * Clear all captured responses from memory.
 */
function clearCapturedResponses() {
  capturedResponses.length = 0;
}

/**
 * Check if fetch/XHR interception is currently active.
 * @returns {boolean}
 */
function isActive() {
  return active;
}

export {
  initFetchIntercept,
  stopFetchIntercept,
  getCapturedResponses,
  clearCapturedResponses,
  isActive,
  // Exported for testing
  PAGE_SCRIPT_PATH,
  MEDIA_TYPE_REGEX,
  looksLikeMediaUrl,
  bufferToBase64,
};
