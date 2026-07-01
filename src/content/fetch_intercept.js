"use strict";

/**
 * Fetch / XHR Media Stream Capture Module
 *
 * Intercepts window.fetch() and XMLHttpRequest at the page level to capture
 * media response bodies. Used as a fallback when Service Worker capture
 * is unavailable (page has existing SW, cross-origin restrictions, etc.).
 *
 * Architecture:
 *   Content script injects a <script> tag into the page's main world
 *   that monkey-patches window.fetch and XMLHttpRequest. When a media
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

// ─── State ──────────────────────────────────────────────────────────────

/** @type {Array<{url: string, contentType: string, bodyLength: number, bodyB64: string, status: number, headers: string, capturedAt: number}>} */
const capturedResponses = [];

/** @type {boolean} */
let active = false;

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

// ─── Injected Script Code Generation ────────────────────────────────────

/**
 * Generate the JavaScript code that runs in the page's main world
 * to intercept fetch() and XMLHttpRequest calls.
 *
 * This code is injected as a <script> tag's text content. It monkey-patches
 * window.fetch and XMLHttpRequest, and communicates captured media responses
 * back to the content script via custom DOM events.
 *
 * @returns {string}
 */
function generateInterceptCode() {
  return `
    (function() {
      var MEDIA_RE = /^(video\\/|audio\\/|application\\/(x-mpegURL|vnd\\.apple\\.mpegURL|dash\\+xml)|text\\/vtt)/i;
      var SEGMENT_RE = /\\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\\?|$)/i;
      var MANIFEST_RE = /\\.(m3u8|mpd)(\\?|$)/i;
      var DIRECT_RE = /\\.(mp4|webm|avi|mkv|mov|wmv|flv)(\\?|$)/i;
      var MAX_CAPTURES = 5000;
      var MAX_BYTES_PER_RESPONSE = 500 * 1024 * 1024;
      var capturedCount = 0;
      var totalBytes = 0;
      var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

      function looksLikeMediaUrl(url) {
        return SEGMENT_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_RE.test(url);
      }

      function bufferToBase64(buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      }

      function captureResponse(url, contentType, body, status, headers) {
        if (capturedCount >= MAX_CAPTURES) return;
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        if (body.byteLength > MAX_BYTES_PER_RESPONSE) return;
        if (body.byteLength === 0) return;

        capturedCount++;
        totalBytes += body.byteLength;

        var event = new CustomEvent('${INTERCEPT_EVENT}', {
          detail: {
            type: 'qwinMediaResponse',
            url: url,
            contentType: contentType || '',
            bodyLength: body.byteLength,
            bodyB64: bufferToBase64(body),
            status: status,
            headers: JSON.stringify(headers || []),
            isSegment: SEGMENT_RE.test(url),
            isManifest: MANIFEST_RE.test(url),
            capturedAt: Date.now()
          }
        });
        document.dispatchEvent(event);
      }

      // ── Override window.fetch ────────────────────────────────────────
      var originalFetch = window.fetch;
      window.fetch = function(input, init) {
        var url = (typeof input === 'string') ? input :
                  (input && typeof input === 'object' && input.url) ? input.url : '';
        if (!url) return originalFetch.call(this, input, init);

        return originalFetch.call(this, input, init).then(function(response) {
          var contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (!MEDIA_RE.test(contentType) && !looksLikeMediaUrl(url)) {
            return response;
          }

          var cloned = response.clone();
          cloned.arrayBuffer().then(function(body) {
            captureResponse(url, contentType, body, response.status, []);
          }).catch(function() {});
          return response;
        }).catch(function(err) {
          return originalFetch.call(this, input, init);
        });
      };

      // ── Override XMLHttpRequest ─────────────────────────────────────
      var OrigXHR = window.XMLHttpRequest;
      var XHRProxy = function() {
        var xhr = new OrigXHR();
        var origOpen = xhr.open.bind(xhr);
        var origSend = xhr.send.bind(xhr);
        var origSetRequestHeader = xhr.setRequestHeader.bind(xhr);
        var requestUrl = '';
        var requestHeaders = [];

        xhr.open = function(method, url) {
          requestUrl = (typeof url === 'string') ? url : '';
          return origOpen.apply(xhr, arguments);
        };

        xhr.setRequestHeader = function(name, value) {
          requestHeaders.push({name: name, value: value});
          return origSetRequestHeader(name, value);
        };

        xhr.addEventListener('load', function() {
          var contentType = (xhr.getResponseHeader('content-type') || '').toLowerCase();
          if (!MEDIA_RE.test(contentType) && !looksLikeMediaUrl(requestUrl)) return;
          if (!xhr.response || !xhr.response.byteLength) return;

          captureResponse(
            requestUrl,
            contentType,
            xhr.response,
            xhr.status,
            requestHeaders
          );
        });

        xhr.responseType = 'arraybuffer';
        return xhr;
      };

      // Inherit static properties from original XHR
      if (OrigXHR.UNSENT !== undefined) XHRProxy.UNSENT = OrigXHR.UNSENT;
      if (OrigXHR.OPENED !== undefined) XHRProxy.OPENED = OrigXHR.OPENED;
      if (OrigXHR.HEADERS_RECEIVED !== undefined) XHRProxy.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
      if (OrigXHR.LOADING !== undefined) XHRProxy.LOADING = OrigXHR.LOADING;
      if (OrigXHR.DONE !== undefined) XHRProxy.DONE = OrigXHR.DONE;

      window.XMLHttpRequest = XHRProxy;
    })();
  `;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize fetch/XHR media interception by injecting the intercept script
 * into the page's DOM.
 *
 * @returns {boolean} True if interception was successfully initialized.
 */
function initFetchIntercept() {
  if (active) return true;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return false;
  }

  try {
    // Inject the intercept script into the page's main world
    const script = document.createElement("script");
    script.textContent = generateInterceptCode();
    script.id = "qwin-fetch-intercept";
    document.documentElement.appendChild(script);
    injectedScript = script;

    // Set up listener for custom DOM events from the injected script
    setupDOMListener();

    active = true;
    return true;
  } catch (e) {
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
  generateInterceptCode,
  MEDIA_TYPE_REGEX,
  looksLikeMediaUrl,
  bufferToBase64,
};
