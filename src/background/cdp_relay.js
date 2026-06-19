"use strict";

/**
 * CDP Relay — bridges CDP commands from the Go companion binary to
 * chrome.debugger API.
 *
 * Architecture:
 *   Go binary → (stdio JSON) → Python host → (native msg) → Extension → chrome.debugger
 *
 * The Go binary sends CDP method calls (Network.enable, Runtime.evaluate, etc.)
 * which are relayed through the Python host to the extension's background script,
 * which executes them via chrome.debugger.sendCommand.
 */

// Map of active debugger sessions: tabId → attached state
const activeSessions = new Map();

// Map of pending CDP command callbacks: commandId → { resolve, reject, timeout }
const pendingCommands = new Map();

let commandCounter = 0;

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @param {string} [targetUrl] - Optional URL to match for the target.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function attach(tabId, targetUrl) {
  if (activeSessions.has(tabId)) {
    return { ok: true };
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.attach(
        { tabId },
        "1.3",
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message || "Failed to attach debugger" });
            return;
          }
          activeSessions.set(tabId, true);
          resolve({ ok: true });
        },
      );
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
      chrome.debugger.detach(
        { tabId },
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message || "Failed to detach debugger" });
            return;
          }
          activeSessions.delete(tabId);
          resolve({ ok: true });
        },
      );
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
      chrome.debugger.sendCommand(
        { tabId },
        method,
        params || {},
        (result) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message || "CDP command failed" });
            return;
          }
          resolve({ ok: true, result });
        },
      );
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
}

/**
 * Initialize the CDP relay module.
 * Registers a chrome.debugger event listener for detach events.
 */
function init() {
  if (typeof chrome !== "undefined" && chrome.debugger && chrome.debugger.onEvent) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      // Chrome debugger events are forwarded through the relay chain.
      // Currently no-op in scaffold — will be used for CDM license interception.
      void source;
      void method;
      void params;
    });

    chrome.debugger.onDetach.addListener((source) => {
      activeSessions.delete(source.tabId);
    });
  }
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
};
