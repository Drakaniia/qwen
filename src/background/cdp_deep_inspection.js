"use strict";

/**
 * Deep Network Inspection (GAP 8)
 *
 * When enabled, the CDP debugger captures WebSocket frames and extra
 * request info (HTTP/3, QUIC) and forwards them to the native host.
 *
 * Extracted from cdp_relay.js for modularity. Uses a factory that
 * accepts core CDP functions (attach, detach, sendCommand) and relay
 * utilities (forwardNetworkEvent, isRelayConnected) to avoid circular
 * dependencies.
 *
 * @param {Object} deps
 * @param {(tabId: number) => Promise<{ok: boolean, error?: string}>} deps.attach
 * @param {(tabId: number) => Promise<{ok: boolean, error?: string}>} deps.detach
 * @param {(tabId: number, method: string, params?: Object) => Promise<{ok: boolean, result?: any, error?: string}>} deps.sendCommand
 */
export function createDeepInspection(deps) {
  /** @type {Set<number>} */
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

    const attachResult = await deps.attach(tabId);
    if (!attachResult.ok) {
      return attachResult;
    }
    try {
      await deps.sendCommand(tabId, "Network.enable", {});
      deepInspectionTabs.add(tabId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  /**
   * Disable deep network inspection on a given tab.
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
      await deps.sendCommand(tabId, "Network.disable", {});
    } catch (_error) {
      // Ignore errors if debugger already detached
    }

    deepInspectionTabs.delete(tabId);

    if (detachAfter) {
      await deps.detach(tabId);
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
   * Get the set of tabs with active deep inspection.
   * @returns {Set<number>}
   */
  function getDeepInspectionTabs() {
    return deepInspectionTabs;
  }

  /**
   * Called by cdp_relay when a debugger detach event fires,
   * so deep inspection state is cleaned up in sync.
   *
   * @param {number} tabId
   */
  function onDebuggerDetach(tabId) {
    deepInspectionTabs.delete(tabId);
  }

  return {
    enableDeepNetworkInspection,
    disableDeepNetworkInspection,
    isDeepInspectionActive,
    getDeepInspectionTabs,
    onDebuggerDetach,
  };
}
