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

    async function handleFetch(event) {
      try {
        const response = await fetch(event.request);
        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        if (MEDIA_TYPES.test(contentType) || looksLikeSegment(event.request.url) || looksLikeManifest(event.request.url)) {
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
            }
          }
        }
        return response;
      } catch (e) {
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

// ─── State ──────────────────────────────────────────────────────────────

/** @type {Array<{url: string, contentType: string, bodyLength: number, bodyB64: string, status: number, headers: string, isManifest: boolean, isSegment: boolean, capturedAt: number}>} */
const capturedResponses = [];

let swRegistration = null;
let swActive = false;
let messageHandler = null;

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
    if (event.data && event.data.type === "qwinMediaResponse") {
      capturedResponses.push({
        url: event.data.url,
        contentType: event.data.contentType,
        bodyLength: event.data.bodyLength,
        bodyB64: event.data.bodyB64,
        status: event.data.status,
        headers: event.data.headers,
        isManifest: event.data.isManifest,
        isSegment: event.data.isSegment,
        capturedAt: event.data.capturedAt,
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
};
