"use strict";

/**
 * Shared CDP Helper Module
 *
 * Provides common Chrome DevTools Protocol operations (attach, detach,
 * sendCommand, cleanup) used by cookie_extraction.js and
 * cdp_tunnel_download.js. Extracted to eliminate code duplication.
 */

/** @type {Map<number, boolean>} */
const activeSessions = new Map();

/**
 * Attach the debugger to a tab if not already attached.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }
  if (typeof chrome === "undefined" || !chrome.debugger) {
    return Promise.resolve({ ok: false, error: "chrome.debugger API not available" });
  }
  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || "Failed to attach debugger" });
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
 * @returns {Promise<void>}
 */
function detach(tabId) {
  if (!activeSessions.has(tabId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        activeSessions.delete(tabId);
        resolve();
      });
    } catch (_error) {
      activeSessions.delete(tabId);
      resolve();
    }
  });
}

/**
 * Send a CDP command.
 * @param {number} tabId
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    if (!activeSessions.has(tabId)) {
      resolve({ ok: false, error: "Debugger not attached to this tab." });
      return;
    }
    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message || "CDP command failed" });
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
 * @returns {Promise<void>}
 */
async function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    await detach(tabId);
  }
}

export { activeSessions, attach, detach, sendCommand, cleanup };
