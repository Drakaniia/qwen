"use strict";

/**
 * CDP Relay — bridges CDP commands from the Go companion binary to
 * chrome.debugger API, via a persistent native messaging port.
 *
 * Architecture:
 *   Go binary → (stdio JSON) → Python host → (native msg port) → Extension → chrome.debugger
 *
 * Deep network inspection has been extracted into cdp_deep_inspection.js
 * and is composed via dependency injection.
 */

import { createDeepInspection } from "./cdp_deep_inspection.js";

const HOST_NAME = "com.qwin.video_downloader";

// Map of active debugger sessions: tabId → attached state
const activeSessions = new Map();

// Persistent native messaging port for the CDP relay chain.
let relayPort = null;
let relayPortConnected = false;

// ─── Relay port management ────────────────────────────────────────────────

/**
 * Open a persistent native messaging port for the CDP relay chain.
 * @returns {boolean} True if the port was opened successfully.
 */
function connectRelay() {
  if (relayPortConnected && relayPort) {
    return true;
  }

  try {
    relayPort = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    console.warn("[cdpRelay] Could not open relay port:", error.message || error);
    return false;
  }

  if (!relayPort) {
    return false;
  }

  relayPortConnected = true;

  relayPort.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "cdpRelayForward") {
      handleRelayForward(message);
      return;
    }

    if (message.type === "cdpRelayResult" || message.type === "cdpRelayError") {
      return;
    }
  });

  relayPort.onDisconnect.addListener(() => {
    relayPortConnected = false;
    const lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
    if (lastError) {
      console.warn("[cdpRelay] Relay port disconnected:", lastError);
    }
  });

  return true;
}

/**
 * Close the persistent CDP relay port.
 */
function disconnectRelay() {
  if (relayPort) {
    try {
      relayPort.disconnect();
    } catch (_error) {}
  }
  relayPort = null;
  relayPortConnected = false;
}

/**
 * Check if the CDP relay port is connected.
 * @returns {boolean}
 */
function isRelayConnected() {
  return relayPortConnected && relayPort !== null;
}

// ─── Relay forwarding ─────────────────────────────────────────────────────

/**
 * Handle a CDP relay forward message from the Python host.
 * @param {Object} message - With tabId, method, params, forwardId
 */
function handleRelayForward(message) {
  const tabId = Number(message.tabId) || 0;
  const method = String(message.method || "").trim();
  const params = message.params || {};
  const forwardId = String(message.forwardId || message.id || "");

  if (!tabId || !method) {
    sendRelayResult(forwardId, null, "Invalid CDP relay: tabId and method are required.");
    return;
  }

  attach(tabId).then((attachResult) => {
    if (!attachResult.ok) {
      sendRelayResult(forwardId, null, attachResult.error || "Failed to attach debugger");
      return;
    }

    sendCommand(tabId, method, params).then((commandResult) => {
      if (commandResult.ok) {
        sendRelayResult(forwardId, commandResult.result || {}, "");
      } else {
        sendRelayResult(forwardId, null, commandResult.error || "CDP command failed");
      }
    });
  });
}

/**
 * Send a CDP relay result back through the native messaging port.
 * @param {string} forwardId
 * @param {Object|null} result
 * @param {string} error
 */
function sendRelayResult(forwardId, result, error) {
  if (!relayPort || !relayPortConnected) {
    console.warn("[cdpRelay] Cannot send result: relay port not connected");
    return;
  }

  const message = {
    type: error ? "cdpRelayError" : "cdpRelayResult",
    forwardId: forwardId,
    ok: !error,
  };

  if (result !== null && result !== undefined) {
    message.result = result;
  }
  if (error) {
    message.error = error;
  }

  try {
    relayPort.postMessage(message);
  } catch (err) {
    console.warn("[cdpRelay] Failed to send relay result:", err.message || err);
  }
}

// ─── CDP wrappers ────────────────────────────────────────────────────────

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return { ok: true };
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Failed to attach debugger" });
          return;
        }
        activeSessions.set(tabId, true);
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error) });
    }
  });
}

/**
 * Detach the debugger from a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function detach(tabId) {
  if (!activeSessions.has(tabId)) {
    return { ok: true };
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Failed to detach debugger" });
          return;
        }
        activeSessions.delete(tabId);
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error) });
    }
  });
}

/**
 * Send a CDP command via chrome.debugger.sendCommand.
 * @param {number} tabId
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    if (!activeSessions.has(tabId)) {
      resolve({ ok: false, error: "Debugger is not attached to this tab." });
      return;
    }

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
      resolve({ ok: false, error: error.message || String(error) });
    }
  });
}

// ─── Message handlers ────────────────────────────────────────────────────

/**
 * Handle a "cdpCommand" message from the native host.
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function handleCdpCommand(message) {
  const tabId = Number(message.tabId) || 0;
  const method = String(message.method || "").trim();
  const params = message.params || {};

  if (!tabId || !method) {
    return { ok: false, error: "Invalid CDP command: tabId and method are required." };
  }

  if (!activeSessions.has(tabId)) {
    const attachResult = await attach(tabId);
    if (!attachResult.ok) {
      return attachResult;
    }
  }

  return sendCommand(tabId, method, params);
}

/**
 * Handle a "cdpAttach" message.
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function handleCdpAttach(message) {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "Invalid tabId." };
  }
  return attach(tabId);
}

/**
 * Handle a "cdpDetach" message.
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function handleCdpDetach(message) {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "Invalid tabId." };
  }
  return detach(tabId);
}

/**
 * Handle a "cdpStatus" message.
 * @returns {Promise<Object>}
 */
async function handleCdpStatus() {
  const debuggerAvailable = typeof chrome !== "undefined" && !!chrome.debugger;
  const sessions = Array.from(activeSessions.keys());
  return {
    ok: true,
    debuggerAvailable,
    activeSessions: sessions,
    sessionCount: sessions.length,
    relayConnected: relayPortConnected,
  };
}

/**
 * Get the set of tabs with active debugger sessions.
 * @returns {number[]}
 */
function getActiveSessionTabIds() {
  return Array.from(activeSessions.keys());
}

/**
 * Clean up all active debugger sessions.
 */
function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    try {
      chrome.debugger.detach({ tabId });
    } catch (_error) {}
    activeSessions.delete(tabId);
  }
  disconnectRelay();
}

// ─── Deep Network Inspection (via injected module) ───────────────────────

const deepInspection = createDeepInspection({ attach, detach, sendCommand });

const { enableDeepNetworkInspection, disableDeepNetworkInspection, isDeepInspectionActive } = deepInspection;

// ─── Init ────────────────────────────────────────────────────────────────

/**
 * Initialize the CDP relay module.
 * Registers debugger event listeners and opens the relay port.
 */
function init() {
  if (typeof chrome !== "undefined" && chrome.debugger) {
    if (chrome.debugger.onEvent) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        // Forward deep network inspection events to the native host
        if (source && source.tabId && deepInspection.isDeepInspectionActive(source.tabId)) {
          if (
            method === "Network.webSocketFrameReceived" ||
            method === "Network.webSocketFrameSent" ||
            method === "Network.webSocketFrameError" ||
            method === "Network.requestWillBeSentExtraInfo" ||
            method === "Network.responseReceivedExtraInfo"
          ) {
            forwardNetworkEvent(method, source.tabId, params || {});
            return;
          }
        }
      });
    }

    if (chrome.debugger.onDetach) {
      chrome.debugger.onDetach.addListener((source) => {
        activeSessions.delete(source.tabId);
        deepInspection.onDebuggerDetach(source.tabId);
      });
    }
  }

  // Open persistent relay port for Go → Python → Extension CDP relay
  connectRelay();
}

// ─── Network event forwarding ────────────────────────────────────────────

/**
 * Forward a captured CDP event to the native host.
 * @param {string} eventType
 * @param {number} tabId
 * @param {Object} params
 */
function forwardNetworkEvent(eventType, tabId, params) {
  if (!relayPort || !relayPortConnected) {
    return;
  }

  try {
    relayPort.postMessage({
      type: "networkEvent",
      eventType,
      tabId,
      params,
      timestamp: Date.now(),
    });
  } catch (_error) {}
}

export {
  attach,
  detach,
  sendCommand,
  handleCdpCommand,
  handleCdpAttach,
  handleCdpDetach,
  handleCdpStatus,
  getActiveSessionTabIds,
  cleanup,
  init,
  connectRelay,
  disconnectRelay,
  isRelayConnected,
  enableDeepNetworkInspection,
  disableDeepNetworkInspection,
  isDeepInspectionActive,
  forwardNetworkEvent,
};
