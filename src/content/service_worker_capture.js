"use strict";

/**
 * Service Worker Media Capture Module
 *
 * Registers an ephemeral Service Worker on the page that intercepts ALL
 * network requests and captures response bodies for media content types.
 *
 * This catches:
 * - Fetches to M3U8/MPD manifests
 * - Segment fetches (TS, M4S, CMFA, CMFV)
 * - Direct MP4/WebM requests
 * - Range requests (HTTP 206 Partial Content)
 *
 * Architecture:
 *   Content Script → SW capture (in-page) → postMessage → Content Script
 *   → runtime.sendMessage → Background → Native Host
 *
 * Limitations:
 * - In-page SW registration via blob: script URLs is rejected by Chromium/Firefox.
 *   fetch_intercept.js is used instead on third-party pages.
 * - SW scope is limited to the page origin — cannot intercept cross-origin CDN
 *   requests directly (no CORS access to opaque responses).
 * - For cross-origin CDNs, falls back to CDP Network.enable as backup.
 * - Max 500MB per response capture, 2GB total per session.
 */

// ─── Constants ──────────────────────────────────────────────────────────

/** Regex that matches media Content-Type values we want to capture. */
const MEDIA_TYPE_REGEX = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;

/** Regex that matches segment URLs (not manifests). */
function looksLikeSegment(url) {
  return /\.(ts|m4s|cmfv|cmfa)(\?|$)/i.test(url) ||
         /\/seg(ment)?[-_]?\d+/i.test(url);
}

/** Regex that matches manifest URLs we want to capture separately. */
function looksLikeManifest(url) {
  return /\.(m3u8|mpd)(\?|$)/i.test(url);
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

/**
 * Generate the Service Worker code (runs in SW context) as a string.
 * This is injected as a blob URL to avoid needing a separate file.
 * @returns {string}
 */
function generateCaptureSWCode() {
  return `
    const MEDIA_TYPES = /^(video\\/|audio\\/|application\\/(x-mpegURL|vnd\\.apple\\.mpegURL|dash\\+xml)|text\\/vtt)/i;
    const SEGMENT_RE = /\\.(ts|m4s|cmfv|cmfa)(\\?|$)/i;
    let capturedCount = 0;
    const MAX_CAPTURES = 5000;
    const MAX_BYTES_PER_RESPONSE = 500 * 1024 * 1024;
    let totalBytes = 0;
    const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

    self.addEventListener('fetch', (event) => {
      const url = event.request.url;
      if (!url.startsWith('http')) return;
      event.respondWith(handleFetch(event));
    });

    // Respond to keepalive pings from the content script
    self.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'qwinKeepalivePing') {
        event.source.postMessage({ type: 'qwinKeepalivePong', ts: Date.now() });
      }
    });

    async function handleFetch(event) {
      try {
        // Build a new request that forwards critical headers (Range, If-Range)
        const reqHeaders = new Headers(event.request.headers);
        // Browser fetch() already forwards headers from event.request,
        // but we ensure Range/If-Range are explicitly present for correctness
        const forwardedReq = new Request(event.request, { headers: reqHeaders });

        const response = await fetch(forwardedReq);
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const isMedia = MEDIA_TYPES.test(contentType) || looksLikeSegment(event.request.url) || looksLikeManifest(event.request.url);

        if (isMedia) {
          // ── Opaque response handling ──────────────────────────────
          if (response.type === 'opaque') {
            // Cannot read body from opaque cross-origin responses —
            // send metadata to trigger CDP fallback
            const clientId = event.resultingClientId || event.clientId;
            if (clientId) {
              const client = await self.clients.get(clientId);
              if (client) {
                client.postMessage({
                  type: 'qwinMediaResponse',
                  url: event.request.url,
                  contentType: contentType,
                  bodyLength: 0,
                  bodyB64: null,
                  status: 0,
                  headers: '[]',
                  isManifest: false,
                  isSegment: false,
                  capturedAt: Date.now(),
                  isOpaque: true,
                });
              }
            }
            // Pass opaque response through without attempting body capture
            return response;
          }

          if (capturedCount < MAX_CAPTURES && totalBytes < MAX_TOTAL_BYTES) {
            const cloned = response.clone();
            const body = await cloned.arrayBuffer();

            if (body.byteLength <= MAX_BYTES_PER_RESPONSE && body.byteLength > 0) {
              capturedCount++;
              totalBytes += body.byteLength;

              const clientId = event.resultingClientId || event.clientId;
              if (clientId) {
                const client = await self.clients.get(clientId);
                if (client) {
                  client.postMessage({
                    type: 'qwinMediaResponse',
                    url: event.request.url,
                    contentType: contentType,
                    bodyLength: body.byteLength,
                    bodyB64: bufferToBase64(body),
                    status: response.status,
                    headers: JSON.stringify([...response.headers.entries()]),
                    isManifest: looksLikeManifest(event.request.url),
                    isSegment: looksLikeSegment(event.request.url),
                    capturedAt: Date.now(),
                  });
                }
              }
            } else if (body.byteLength > 0) {
              console.warn('[qwin-sw] Response exceeds MAX_BYTES_PER_RESPONSE (' + body.byteLength + ' > ' + MAX_BYTES_PER_RESPONSE + '), skipping', event.request.url);
            }
          } else {
            if (capturedCount >= MAX_CAPTURES) {
              console.warn('[qwin-sw] MAX_CAPTURES limit reached (' + MAX_CAPTURES + '), stopping capture');
            }
            if (totalBytes >= MAX_TOTAL_BYTES) {
              console.warn('[qwin-sw] MAX_TOTAL_BYTES limit reached (' + MAX_TOTAL_BYTES + '), stopping capture');
            }
          }
        }
        return response;
      } catch (e) {
        console.warn('[qwin-sw] Fetch interception error:', e);
        return fetch(event.request);
      }
    }

    function looksLikeSegment(url) {
      return SEGMENT_RE.test(url) || /\\/seg(ment)?[-_]?\\d+/i.test(url);
    }

    function looksLikeManifest(url) {
      return /\\.(m3u8|mpd)(\\?|$)/i.test(url);
    }

    function bufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
  `;
}

/**
 * Whether an injected capture SW can be registered on third-party pages.
 *
 * generateCaptureSWCode() is injected via URL.createObjectURL(), but Chromium
 * and Firefox reject blob: script URLs for navigator.serviceWorker.register():
 * "The URL protocol of the script ('blob:...') is not supported."
 *
 * A working in-page capture SW would need an https: script URL on the page
 * origin (not available without hosting on that origin). fetch_intercept.js
 * is the supported fallback for third-party video embeds.
 *
 * @returns {boolean}
 */
function isCaptureServiceWorkerRegistrationSupported() {
  return false;
}

/**
 * Check if the given page URL supports Service Worker registration.
 *
 * Service Workers can only be registered from secure contexts:
 * - https:// (all secure origins)
 * - http://localhost, http://127.0.0.1, http://[::1] (local development)
 *
 * The following protocols NEVER support SW registration:
 * - blob:// (e.g., blob:https://example.com/uuid)
 * - about:, data:, file:, chrome-extension:, etc.
 *
 * @param {string} pageUrl - The current page URL to check.
 * @returns {boolean} True if the URL supports SW registration.
 */
function isPageUrlSupportedForSWCapture(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      const hostname = url.hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    }
    return false;
  } catch (_e) {
    return false;
  }
}

// ─── State ──────────────────────────────────────────────────────────────

/** @type {Array<{url: string, contentType: string, bodyLength: number, bodyB64: string, status: number, headers: string, isManifest: boolean, isSegment: boolean, capturedAt: number}>} */
const capturedResponses = [];

let swRegistration = null;
let swActive = false;
let messageHandler = null;

/** @type {number|null} Keepalive interval ID for SW heartbeat */
let keepaliveIntervalId = null;

/** Interval (ms) between keepalive pings to prevent SW idle termination. */
const KEEPALIVE_INTERVAL_MS = 20000;

// ─── Keepalive ────────────────────────────────────────────────────────────

/**
 * Start a periodic heartbeat to keep the Service Worker alive.
 * Browsers kill idle SWs after approximately 30 seconds of inactivity.
 * This sends periodic pings and expects pong responses.
 */
function startKeepalive() {
  stopKeepalive();
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  keepaliveIntervalId = setInterval(async () => {
    try {
      if (!swActive || !swRegistration) {
        stopKeepalive();
        return;
      }
      // Send a ping through the SW registration's active worker
      if (swRegistration.active) {
        swRegistration.active.postMessage({
          type: "qwinKeepalivePing",
          ts: Date.now(),
        });
      }
    } catch (_e) {
      // SW may have been killed — stop keepalive
      stopKeepalive();
    }
  }, KEEPALIVE_INTERVAL_MS);
}

/**
 * Stop the keepalive heartbeat timer.
 */
function stopKeepalive() {
  if (keepaliveIntervalId !== null) {
    clearInterval(keepaliveIntervalId);
    keepaliveIntervalId = null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the media capture Service Worker on the current page.
 * @returns {Promise<boolean>} True if SW was registered successfully.
 */
async function initMediaCaptureSW() {
  if (swActive) {
    return true;
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  // Don't override an existing controlling SW
  if (navigator.serviceWorker.controller) {
    console.warn("[qwin] Page already has a Service Worker — not registering capture SW");
    return false;
  }

  // Bail early if the page URL doesn't support SW registration
  // (blob:, about:, data:, file:, chrome-extension:, non-localhost http:)
  if (!isPageUrlSupportedForSWCapture(window.location.href)) {
    return false;
  }

  // Blob-injected SW scripts are rejected by browsers even on valid https: pages.
  if (!isCaptureServiceWorkerRegistrationSupported()) {
    return false;
  }

  try {
    const swCode = generateCaptureSWCode();
    const swBlob = new Blob([swCode], { type: "application/javascript" });
    const swURL = URL.createObjectURL(swBlob);

    const registration = await navigator.serviceWorker.register(swURL, {
      scope: window.location.pathname,
    });

    swRegistration = registration;
    swActive = true;

    // Set up message handler for incoming SW data
    setupMessageChannel();

    // Start keepalive heartbeat to prevent browser from killing idle SW
    startKeepalive();

    return true;
  } catch (e) {
    console.warn("[qwin] SW capture registration failed:", e);
    return false;
  }
}

/**
 * Set up the message channel to receive captured responses from the SW.
 */
function setupMessageChannel() {
  if (messageHandler) {
    navigator.serviceWorker.removeEventListener("message", messageHandler);
  }

  messageHandler = (event) => {
    // Validate event.data exists and has the expected type before accessing properties
    if (!event || !event.data) return;
    if (typeof event.data !== "object") return;
    if (!event.data.type) return;

    if (event.data.type === "qwinMediaResponse") {
      // Validate required fields
      if (!event.data.url || !event.data.bodyB64) return;

      capturedResponses.push({
        url: event.data.url,
        contentType: event.data.contentType || "",
        bodyLength: event.data.bodyLength || 0,
        bodyB64: event.data.bodyB64,
        status: event.data.status || 0,
        headers: event.data.headers || "[]",
        isManifest: !!event.data.isManifest,
        isSegment: !!event.data.isSegment,
        capturedAt: event.data.capturedAt || Date.now(),
      });

      // Forward to background script
      try {
        const api = typeof browser !== "undefined" ? browser : chrome;
        api.runtime.sendMessage({
          type: "swCapturedMediaResponse",
          data: event.data,
        }).catch(() => {});
      } catch (_e) {
        // Extension context may be unavailable
      }
    }
  };

  navigator.serviceWorker.addEventListener("message", messageHandler);
}

/**
 * Stop the media capture SW and clean up.
 * @returns {Promise<void>}
 */
async function stopMediaCaptureSW() {
  // Stop keepalive heartbeat
  stopKeepalive();

  if (messageHandler) {
    try {
      navigator.serviceWorker.removeEventListener("message", messageHandler);
    } catch (_e) {}
    messageHandler = null;
  }

  if (swRegistration) {
    try {
      await swRegistration.unregister();
    } catch (_e) {}
    swRegistration = null;
  }

  swActive = false;
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
 * Check if the capture SW is currently active.
 * @returns {boolean}
 */
function isSWActive() {
  return swActive;
}

export {
  initMediaCaptureSW,
  stopMediaCaptureSW,
  getCapturedResponses,
  clearCapturedResponses,
  isSWActive,
  // Exported for testing
  generateCaptureSWCode,
  MEDIA_TYPE_REGEX,
  looksLikeSegment,
  bufferToBase64,
  isPageUrlSupportedForSWCapture,
  isCaptureServiceWorkerRegistrationSupported,
};
