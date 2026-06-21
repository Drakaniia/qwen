"use strict";

/**
 * CDP Network Interception Module (Phase 1b)
 *
 * Monitors Widevine license exchanges via chrome.debugger's Network domain.
 * Captures the license challenge (POST to /license, /widevine, etc.) and
 * the license response body for forwarding to the CDM-proxy pipeline.
 *
 * Architecture:
 *   1. CDP attach to tab + Network.enable()
 *   2. Listen for Network.requestWillBeSent → detect Widevine license URLs
 *   3. Store requestId + postData for tracked requests
 *   4. Listen for Network.loadingFinished → call Network.getResponseBody
 *   5. Completed exchanges are stored and can be retrieved via getCapturedExchanges()
 *
 * This runs in the background script context and feeds the native host's
 * CDM-proxy pipeline (or the Go binary when available).
 */

// ─── Active sessions ───────────────────────────────────────────────────────

/** @type {Map<number, {tabId: number, attached: boolean}>} */
const activeSessions = new Map();

/**
 * Map of tracked Widevine license exchanges keyed by requestId.
 * Only requests matching isWidevineUrl() are tracked.
 *
 * @type {Map<string, Object>}
 */
const trackedRequests = new Map();

/** @type {Array<Object>} */
const completedExchanges = [];

// ─── Widevine URL patterns ─────────────────────────────────────────────────

/**
 * Regex patterns for detecting Widevine license endpoints.
 * Matches common DRM license URL patterns.
 */
const WIDEVINE_URL_RE = /\/license|\/widevine|\/wv\b|\/wv\/|\/drm\/license|\/cdm\//i;

/**
 * Request Content-Type patterns that indicate Widevine license exchange payloads.
 */
const WIDEVINE_CONTENT_TYPES = [
  "application/octet-stream",
  "application/x-protobuf",
  "application/octet-stream;",
  "application/x-protobuf;",
];

// ─── Widevine URL detection ────────────────────────────────────────────────

/**
 * Check if a network request is a Widevine license exchange.
 *
 * A Widevine license request is typically:
 * - POST method
 * - URL containing /license, /widevine, /wv
 * - Content-Type: application/octet-stream or application/x-protobuf
 *
 * @param {string} url - The request URL
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {Object} [headers] - Request headers object
 * @returns {boolean} True if this looks like a Widevine license request
 */
function isWidevineUrl(url, method, headers) {
  if (!url || typeof url !== "string") {
    return false;
  }

  // Must be POST
  if (method !== "POST") {
    return false;
  }

  // URL must match Widevine patterns
  if (!WIDEVINE_URL_RE.test(url)) {
    return false;
  }

  // If we have headers, check Content-Type
  if (headers && typeof headers === "object") {
    const contentType = String(headers["Content-Type"] || headers["content-type"] || "").toLowerCase();
    if (contentType) {
      return WIDEVINE_CONTENT_TYPES.some((t) => contentType.startsWith(t));
    }
  }

  // Without Content-Type headers, still match on URL + POST
  // (Some DRM providers don't set the expected Content-Type)
  return true;
}

// ─── CDP Integration ───────────────────────────────────────────────────────

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function attach(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Failed to attach debugger" });
          return;
        }
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Detach the debugger from a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function detach(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Failed to detach debugger" });
          return;
        }
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Send a CDP command via chrome.debugger.sendCommand.
 * @param {number} tabId
 * @param {string} method - CDP method name
 * @param {Object} [params] - CDP method parameters
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "CDP command failed" });
          return;
        }
        resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

// ─── Event handlers ────────────────────────────────────────────────────────

/**
 * Handle Network.requestWillBeSent CDP event.
 * Detects Widevine license requests and starts tracking them.
 *
 * @param {Object} params - CDP event parameters
 */
function handleRequestWillBeSent(params, tabId) {
  if (!params || !params.request) {
    return;
  }

  const { requestId, request } = params;
  const { url, method, headers, postData } = request;

  if (!isWidevineUrl(url, method, headers)) {
    return;
  }

  // Start tracking this license exchange
  trackedRequests.set(requestId, {
    requestId,
    tabId,
    url,
    method,
    headers: headers || {},
    postData: postData || "",
    status: "pending",
    capturedAt: Date.now(),
    completedAt: null,
    responseBody: null,
  });
}

/**
 * Handle Network.loadingFinished CDP event.
 * For tracked Widevine requests, fetch the response body.
 *
 * @param {Object} params - CDP event parameters
 * @param {number} tabId - The tab where the event occurred
 */
async function handleLoadingFinished(params, tabId) {
  if (!params || !params.requestId) {
    return;
  }

  const { requestId } = params;
  const tracked = trackedRequests.get(requestId);
  if (!tracked) {
    return;
  }

  // Fetch the response body
  const response = await sendCommand(tabId, "Network.getResponseBody", { requestId });

  const exchange = {
    ...tracked,
    status: response.ok ? "completed" : "error",
    responseBody: response.ok ? response.result?.body || "" : "",
    responseError: response.ok ? "" : response.error || "Failed to get response body",
    completedAt: Date.now(),
  };

  // Remove from tracked and add to completed
  trackedRequests.delete(requestId);
  completedExchanges.push(exchange);
}

/**
 * Register CDP event listeners for the tab.
 *
 * @param {number} tabId
 */
function registerEventListeners(tabId) {
  if (!chrome.debugger.onEvent) {
    return;
  }

  // We use a single listener that filters by tabId
  const handler = (source, method, params) => {
    if (source.tabId !== tabId) {
      return;
    }

    switch (method) {
      case "Network.requestWillBeSent":
        handleRequestWillBeSent(params, source.tabId);
        break;
      case "Network.loadingFinished":
        handleLoadingFinished(params, source.tabId);
        break;
      default:
        break;
    }
  };

  chrome.debugger.onEvent.addListener(handler);

  // Store the handler reference for cleanup
  const session = activeSessions.get(tabId);
  if (session) {
    session.eventHandler = handler;
  }
}

/**
 * Register global onDetach handler to clean up sessions when the debugger
 * is detached unexpectedly (tab close, navigation, etc.).
 */
function registerDetachHandler() {
  if (!chrome.debugger.onDetach || _detachHandlerRegistered) {
    return;
  }

  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (!activeSessions.has(tabId)) {
      return;
    }
    // Clean up any tracked requests for this tab
    unregisterEventListeners(tabId);
    for (const [requestId, tracked] of trackedRequests) {
      if (tracked.tabId === tabId) {
        trackedRequests.delete(requestId);
      }
    }
    activeSessions.delete(tabId);
  });

  _detachHandlerRegistered = true;
}

/** @type {boolean} */
let _detachHandlerRegistered = false;

/**
 * Unregister CDP event listeners for the tab.
 *
 * @param {number} tabId
 */
function unregisterEventListeners(tabId) {
  const session = activeSessions.get(tabId);
  if (session && session.eventHandler && chrome.debugger.onEvent) {
    // Note: chrome.debugger.onEvent has removeListener in Chrome
    try {
      chrome.debugger.onEvent.removeListener(session.eventHandler);
    } catch (_error) {
      // Some Chrome versions don't support removeListener on debugger events
    }
    delete session.eventHandler;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize CDP network interception on a tab.
 *
 * Flow:
 * 1. Attach CDP to the tab
 * 2. Enable Network domain
 * 3. Register event listeners for request/response monitoring
 *
 * @param {number} tabId - The browser tab ID to monitor.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function initIntercept(tabId) {
  if (!tabId || !Number.isInteger(tabId)) {
    return { ok: false, error: "Invalid tabId: must be a positive integer." };
  }

  // Check if already initialized for this tab
  if (activeSessions.has(tabId)) {
    return { ok: true };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Enable Network domain
  const networkResult = await sendCommand(tabId, "Network.enable", {});
  if (!networkResult.ok) {
    await detach(tabId);
    return { ok: false, error: networkResult.error || "Could not enable Network domain." };
  }

  // Register session
  activeSessions.set(tabId, { tabId, attached: true });

  // Register event listeners
  registerEventListeners(tabId);

  // Register the global onDetach handler (once)
  registerDetachHandler();

  return { ok: true };
}

/**
 * Stop CDP network interception on a tab.
 *
 * @param {number} tabId - The browser tab ID to stop monitoring.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function stopIntercept(tabId) {
  if (!activeSessions.has(tabId)) {
    return { ok: true };
  }

  // Unregister event listeners
  unregisterEventListeners(tabId);

  // Clean up any pending tracked requests for this tab
  for (const [requestId, tracked] of trackedRequests) {
    if (tracked.tabId === tabId) {
      trackedRequests.delete(requestId);
    }
  }

  // Detach the debugger
  const detachResult = await detach(tabId);

  activeSessions.delete(tabId);

  return detachResult;
}

/**
 * Stop all active CDP network interception sessions.
 */
function stopAll() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    unregisterEventListeners(tabId);
    try {
      chrome.debugger.detach({ tabId });
    } catch (_error) {
      // Session may already be detached
    }
    activeSessions.delete(tabId);
  }
  trackedRequests.clear();
}

/**
 * Get all Widevine license exchanges (both pending and completed).
 *
 * @returns {Array<Object>} Array of exchange objects with:
 *   - requestId: CDP request ID
 *   - url: Full license URL
 *   - postData: License challenge (base64)
 *   - responseBody: License response (base64, only for completed)
 *   - status: "pending" or "completed" or "error"
 *   - capturedAt: Timestamp when request was captured
 *   - completedAt: Timestamp when response was received (only for completed)
 */
function getCapturedExchanges() {
  const all = [...completedExchanges];
  for (const tracked of trackedRequests.values()) {
    all.push({
      ...tracked,
      status: "pending",
      responseBody: null,
      completedAt: null,
    });
  }
  return all;
}

/**
 * Clear all captured license exchanges.
 */
function clearCapturedExchanges() {
  completedExchanges.length = 0;
  trackedRequests.clear();
}

/**
 * Get a summary of active interception sessions.
 *
 * @returns {Object} Summary with active session count and tracked request count
 */
function getStatus() {
  return {
    activeSessions: Array.from(activeSessions.keys()),
    sessionCount: activeSessions.size,
    trackedRequests: trackedRequests.size,
    completedExchanges: completedExchanges.length,
  };
}

// ─── Key Extraction Pipeline Integration ────────────────────────────────────

/**
 * Send a captured license exchange through the Go binary's key extraction pipeline.
 *
 * This should be called after a license exchange is completed (response received).
 * It sends the request through: extension → native host → Go binary for key extraction.
 *
 * @param {Object} exchange - A completed exchange from getCapturedExchanges().
 * @param {Function} nativeRequestFn - Function to send native messaging requests.
 * @returns {Promise<{ok: boolean, keys?: Array, l1Only?: boolean, error?: string}>}
 */
async function extractKeysFromExchange(exchange, nativeRequestFn) {
  if (!exchange || !exchange.responseBody) {
    return { ok: false, error: "Completed license exchange with responseBody required." };
  }

  const sessionId = `${exchange.tabId || 0}_${exchange.requestId || Date.now()}`;

  try {
    const response = await nativeRequestFn(
      {
        type: "extractKeys",
        id: `extract_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        sessionId,
        responseB64: exchange.responseBody,
        challengeB64: exchange.postData || "",
        initDataB64: "",
      },
      60000,
    );

    return {
      ok: response?.ok !== false,
      sessionId: response?.sessionId || sessionId,
      keys: response?.keys || [],
      l1Only: Boolean(response?.l1Only),
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `Key extraction failed: ${error.message || error}` };
  }
}

/**
 * Extract keys from ALL completed exchanges.
 *
 * @param {Function} nativeRequestFn - Function to send native messaging requests.
 * @returns {Promise<Array<{exchange: Object, result: Object}>>}
 */
async function extractKeysFromAllExchanges(nativeRequestFn) {
  const exchanges = getCapturedExchanges();
  const completed = exchanges.filter((ex) => ex.status === "completed" && ex.responseBody);

  const results = [];
  for (const exchange of completed) {
    const result = await extractKeysFromExchange(exchange, nativeRequestFn);
    results.push({ exchange, result });
  }

  return results;
}

export {
  isWidevineUrl,
  initIntercept,
  stopIntercept,
  stopAll,
  getCapturedExchanges,
  clearCapturedExchanges,
  getStatus,
  extractKeysFromExchange,
  extractKeysFromAllExchanges,
};
