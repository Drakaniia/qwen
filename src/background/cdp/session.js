"use strict";

/**
 * CDP session management — attach, detach, sendCommand, cleanup.
 */

/** @type {Map<number, boolean>} */
const activeSessions = new Map();

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
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
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Detach the debugger from a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean}>}
 */
function detach(tabId) {
  if (!activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        activeSessions.delete(tabId);
        resolve({ ok: true });
      });
    } catch (_error) {
      activeSessions.delete(tabId);
      resolve({ ok: true });
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
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Clean up all active CDP sessions.
 */
function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    try {
      chrome.debugger.detach({ tabId });
    } catch (_error) {
      // Session may already be detached
    }
    activeSessions.delete(tabId);
  }
}

export { attach, detach, sendCommand, cleanup, activeSessions };
