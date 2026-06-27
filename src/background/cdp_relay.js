"use strict";

/**
 * CDP Relay — bridges CDP commands from the Go companion binary to
 * chrome.debugger API, via a persistent native messaging port.
 *
 * Architecture:
 *   Go binary → (stdio JSON) → Python host → (native msg port) → Extension → chrome.debugger
 *
 * The relay port is a persistent chrome.runtime.connectNative connection
 * that stays open for the lifetime of the extension. CDP commands arrive
 * as messages on this port, get executed via chrome.debugger, and results
 * are sent back through the same port.
 */

const HOST_NAME = "com.qwin.video_downloader";

// Map of active debugger sessions: tabId → attached state
const activeSessions = new Map();

// Persistent native messaging port for the CDP relay chain.
// Opened by connectRelay() and kept alive until disconnectRelay().
let relayPort = null;
let relayPortConnected = false;

/**
 * Open a persistent native messaging port for the CDP relay chain.
 * This port stays open so Python can push CDP commands to the extension
 * asynchronously (triggered by Go binary's CDP relay messages).
 *
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

    // Handle CDP relay commands forwarded from Python/Go
    if (message.type === "cdpRelayForward") {
      handleRelayForward(message);
      return;
    }

    // Handle CDP relay results coming back from chrome.debugger
    // (sent back through the port when the debugger responds)
    if (message.type === "cdpRelayResult" || message.type === "cdpRelayError") {
      // These are received when the extension sends a result back.
      // The response is already handled inline in handleRelayForward's callback.
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
    } catch (_error) {
      // Ignore disconnect errors
    }
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

/**
 * Handle a CDP relay forward message from the Python host.
 * Executes the CDP command via chrome.debugger and sends the result back.
 *
 * @param {Object} message - The relay forward message with tabId, method, params, forwardId
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
 * This goes back to Python, which forwards it to the Go binary.
 *
 * @param {string} forwardId - The original forward ID from the relay message.
 * @param {Object|null} result - The CDP command result.
 * @param {string} error - Error message, if any.
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

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @param {string} [targetUrl] - Optional URL to match for the target.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function attach(tabId, _targetUrl) {
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
 * @param {string} method - CDP method name (e.g. "Network.enable")
 * @param {Object} [params] - CDP method parameters
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

/**
 * Handle a CDP command received from the native host (via Python → Go relay).
 * This is called from the background message router when "cdpCommand" is received.
 *
 * @param {Object} message - The message from the native host
 * @returns {Promise<Object>} Response to send back through the relay chain
 */
async function handleCdpCommand(message) {
  const tabId = Number(message.tabId) || 0;
  const method = String(message.method || "").trim();
  const params = message.params || {};

  if (!tabId || !method) {
    return { ok: false, error: "Invalid CDP command: tabId and method are required." };
  }

  // Auto-attach if not already attached
  if (!activeSessions.has(tabId)) {
    const attachResult = await attach(tabId);
    if (!attachResult.ok) {
      return attachResult;
    }
  }

  return sendCommand(tabId, method, params);
}

/**
 * Handle a "cdpAttach" message to explicitly attach to a tab.
 * @param {Object} message
 * @returns {Promise<Object>}
 */
async function handleCdpAttach(message) {
  const tabId = Number(message.tabId) || 0;
  if (!tabId) {
    return { ok: false, error: "Invalid tabId." };
  }
  return attach(tabId, message.url);
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
 * Handle a "cdpStatus" message — check if debugger is available.
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
 * Clean up all active debugger sessions (used for testing and error recovery).
 * Detaches the debugger from each active tab before clearing session state.
 */
function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    try {
      chrome.debugger.detach({ tabId });
    } catch (_error) {
      // Session may already be detached by the browser
    }
    activeSessions.delete(tabId);
  }
  disconnectRelay();
}

// ─── Deep Network Inspection (GAP 8) ────────────────────────────────────────

/**
 * Configuration for deep network inspection features.
 *
 * When enabled, the CDP debugger captures:
 * - WebSocket frames (Network.webSocketFrameReceived)
 * - Extra request info (Network.requestWillBeSentExtraInfo) for HTTP/3
 *
 * These events are forwarded to the native host for analysis.
 */
let deepNetworkInspectionEnabled = false;

/** Set of tabs with active deep network inspection. */
const deepInspectionTabs = new Set();

/**
 * Enable deep network inspection on a given tab.
 *
 * Attaches the debugger (if not already attached) and enables
 * Network domain events: WebSocket frame capture and request
 * extra info for HTTP/3 / QUIC traffic.
 *
 * @param {number} tabId - Tab to inspect.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function enableDeepNetworkInspection(tabId) {
  if (!tabId || !Number.isInteger(tabId)) {
    return { ok: false, error: "Invalid tabId" };
  }

  // Attach debugger
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return attachResult;
  }
  try {
    // Enable Network domain for WebSocket frame and request extra info capture
    await sendCommand(tabId, "Network.enable", {});

    deepInspectionTabs.add(tabId);
    deepNetworkInspectionEnabled = true;

    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/**
 * Disable deep network inspection on a given tab.
 *
 * Disables the Network domain and optionally detaches the debugger.
 *
 * @param {number} tabId - Tab to stop inspecting.
 * @param {boolean} [detachAfter=true] - Detach the debugger after disabling.
 * @returns {Promise<{ok: boolean}>}
 */
async function disableDeepNetworkInspection(tabId, detachAfter = true) {
  if (!deepInspectionTabs.has(tabId)) {
    return { ok: true };
  }

  try {
    await sendCommand(tabId, "Network.disable", {});
  } catch (_error) {
    // Ignore errors if debugger already detached
  }

  deepInspectionTabs.delete(tabId);
  if (deepInspectionTabs.size === 0) {
    deepNetworkInspectionEnabled = false;
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true };
}

/**
 * Check if deep network inspection is active on a tab.
 * @param {number} tabId
 * @returns {boolean}
 */
function isDeepInspectionActive(tabId) {
  return deepInspectionTabs.has(tabId);
}

/**
 * Forward a captured CDP event to the native host.
 *
 * @param {string} eventType - The CDP event type (e.g. "Network.webSocketFrameReceived").
 * @param {number} tabId - The tab where the event occurred.
 * @param {Object} params - The event parameters.
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
  } catch (_error) {
    // Silently ignore if relay port is disconnected
  }
}

/**
 * Initialize the CDP relay module.
 * Registers a chrome.debugger event listener for detach events
 * and deep network inspection events.
 * Opens the persistent relay port for Go → Python → Extension CDP relay.
 */
function init() {
  if (typeof chrome !== "undefined" && chrome.debugger) {
    if (chrome.debugger.onEvent) {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        // Forward deep network inspection events to the native host
        if (source && source.tabId && deepInspectionTabs.has(source.tabId)) {
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

        void method;
        void params;
      });
    }

    if (chrome.debugger.onDetach) {
      chrome.debugger.onDetach.addListener((source) => {
        activeSessions.delete(source.tabId);
        deepInspectionTabs.delete(source.tabId);
        if (deepInspectionTabs.size === 0) {
          deepNetworkInspectionEnabled = false;
        }
      });
    }
  }

  // Open persistent relay port for Go → Python → Extension CDP relay
  connectRelay();
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
