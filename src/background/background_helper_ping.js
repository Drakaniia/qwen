"use strict";

import { browserApi } from "../shared/browser_api.js";

// ── Cached helper status ────────────────────────────────────────────────

export const HELPER_PING_INTERVAL_MS = 30000;

/**
 * @type {{ connected: boolean, version: string, dependencies: Object, lastChecked: number, error: string }}
 */
export let cachedHelperStatus = {
  connected: false,
  version: "",
  dependencies: {},
  lastChecked: 0,
  error: "",
};
let helperPingTimer = null;

/**
 * Run a ping check and update the cached status.
 * If the status changed from the previous check, broadcast to popups.
 * @param {Function} notifyPopup - Function to send messages to popup
 * @param {string} hostName - Native messaging host name to ping
 */
export async function refreshCachedHelperStatus(notifyPopup, hostName) {
  const result = await pingNativeHost(hostName);
  const previousConnected = cachedHelperStatus.connected;

  if (result && result.ok) {
    cachedHelperStatus = {
      connected: true,
      version: result.version || "",
      dependencies: result.dependencies || {},
      lastChecked: Date.now(),
      error: "",
    };
  } else {
    cachedHelperStatus = {
      connected: false,
      version: "",
      dependencies: {},
      lastChecked: Date.now(),
      error: result && result.error ? result.error : "Native helper is not registered or could not start.",
    };
  }

  // Broadcast to popups if status changed
  if (previousConnected !== cachedHelperStatus.connected) {
    notifyPopup({ type: "helperStatusChanged", status: { ...cachedHelperStatus } });
  }
}

/**
 * Start the periodic helper ping interval.
 * Runs immediately on start, then every HELPER_PING_INTERVAL_MS.
 * @param {Function} notifyPopup - Function to send messages to popup
 * @param {string} hostName - Native messaging host name to ping
 */
export function startHelperPing(notifyPopup, hostName) {
  // Clear any existing timer
  if (helperPingTimer !== null) {
    clearInterval(helperPingTimer);
  }

  // Run immediately
  refreshCachedHelperStatus(notifyPopup, hostName);

  // Then run periodically
  helperPingTimer = setInterval(() => refreshCachedHelperStatus(notifyPopup, hostName), HELPER_PING_INTERVAL_MS);
}

// ── Native host ping ─────────────────────────────────────────────────────

/**
 * Ping the native host to check if it's running and get version/dependency info.
 * @param {string} hostName - The native messaging host name
 * @param {Object} [runtimeApi] - The browser.runtime API (falls back to browserApi.raw)
 * @returns {Promise<{ok: boolean, version?: string, dependencies?: Object, error?: string}>}
 */
export function pingNativeHost(hostName, runtimeApi) {
  const api = runtimeApi || browserApi.raw;
  return new Promise((resolve) => {
    const id = `ping_${Date.now()}`;
    let settled = false;
    const port = browserApi.runtime.connectNative(hostName);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      try {
        if (port) {
          port.disconnect();
        }
      } catch (_error) {}
    };

    if (!port) {
      finish({ ok: false, error: "Native messaging is not available in this browser." });
      return;
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Native helper did not respond." });
    }, 5000);

    port.onMessage.addListener((message) => {
      if (message && message.id === id && message.type === "pong") {
        clearTimeout(timeout);
        finish({ ok: true, version: message.version, dependencies: message.dependencies || {} });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
      console.warn(
        "[helper-ping] Native messaging port disconnected:",
        runtimeError || "no error message",
      );
      finish({
        ok: false,
        error: runtimeError || "Native helper is not registered or could not start.",
      });
    });

    port.postMessage({ type: "ping", id });
  });
}
