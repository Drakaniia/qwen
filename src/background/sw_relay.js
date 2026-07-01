"use strict";

/**
 * SW Capture Relay Module
 *
 * Receives media responses captured by the Service Worker (via content script
 * runtime messages) and batches them for forwarding to the native host.
 * The native host receives the segments when a download is requested.
 */

/** @type {Array<{url: string, contentType: string, bodyB64: string, bodyLength: number, status: number, isManifest: boolean, isSegment: boolean, capturedAt: number}>} */
const pendingSegments = [];

/** @type {boolean} */
let initialized = false;

/** @type {Function|null} */
let messageListener = null;

/**
 * Initialize the relay — register runtime message listener for SW data.
 */
function init() {
  if (initialized) return;
  initialized = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  messageListener = (message, sender) => {
    if (!message || message.type !== "swCapturedMediaResponse") return false;

    const data = message.data;
    if (!data || !data.bodyB64) return false;

    // Store segment
    pendingSegments.push({
      url: data.url,
      contentType: data.contentType,
      bodyB64: data.bodyB64,
      bodyLength: data.bodyLength,
      status: data.status,
      isManifest: data.isManifest,
      isSegment: data.isSegment,
      capturedAt: data.capturedAt || Date.now(),
      tabId: sender.tab?.id,
    });

    // Trim if too many
    if (pendingSegments.length > 10000) {
      pendingSegments.splice(0, pendingSegments.length - 10000);
    }

    return false;
  };

  api.runtime.onMessage.addListener(messageListener);
}

/**
 * Remove the runtime message listener and reset state.
 */
function cleanup() {
  if (!initialized) return;
  const api = typeof browser !== "undefined" ? browser : chrome;
  if (messageListener) {
    try {
      api.runtime.onMessage.removeListener(messageListener);
    } catch (_e) { /* ignore */ }
    messageListener = null;
  }
  pendingSegments.length = 0;
  initialized = false;
}

/**
 * Get all pending segments for a given tab.
 * @param {number} tabId
 * @returns {Array}
 */
function getTabSegments(tabId) {
  if (!tabId && tabId !== 0) return [];
  return pendingSegments.filter((s) => s.tabId === tabId);
}

/**
 * Get all pending segments (across all tabs).
 * @returns {Array}
 */
function getAllSegments() {
  return [...pendingSegments];
}

/**
 * Clear segments for a given job/tab.
 * @param {number} [tabId]
 */
function clearSegments(tabId) {
  if (tabId) {
    for (let i = pendingSegments.length - 1; i >= 0; i--) {
      if (pendingSegments[i].tabId === tabId) {
        pendingSegments.splice(i, 1);
      }
    }
  } else {
    pendingSegments.length = 0;
  }
}

export { init, cleanup, getTabSegments, getAllSegments, clearSegments };
