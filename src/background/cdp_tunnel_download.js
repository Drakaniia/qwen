"use strict";

/**
 * CDP Tunnel Download Module
 *
 * When all other download methods fail (Cloudflare blocks, DRM, broken
 * CDNs), this module tunnels download requests through the browser's
 * authenticated network stack via CDP-injected fetch() calls.
 *
 * Strategy:
 * 1. Attach chrome.debugger to the tab (via shared cdp_helpers)
 * 2. Inject a fetch() call via Runtime.evaluate that returns the response
 * 3. Convert the ArrayBuffer response to base64 and return it
 * 4. Assemble segments in the background
 *
 * CDP helpers (attach, sendCommand, cleanup) are imported from the
 * shared cdp_helpers.js module to avoid code duplication.
 * cf_clearance extraction delegates to cloudflare_solver.js.
 */

import { attach, sendCommand, cleanup } from "./cdp_helpers.js";
import { extractCFClearance } from "./cloudflare_solver.js";

// ─── Script Building ──────────────────────────────────────────────────

/**
 * Build a fetch expression that downloads a segment and returns base64 data.
 * @param {string} url
 * @param {Object} [headers]
 * @returns {string}
 */
function buildFetchScript(url, headers) {
  const headerStr = JSON.stringify(headers || {});
  return `(async function(){
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "GET",
        credentials: "include",
        headers: ${headerStr}
      });
      if (!r.ok) return {ok:false,status:r.status,statusText:r.statusText};
      const b = await r.arrayBuffer();
      const bytes = new Uint8Array(b);
      let bin = "";
      for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      const contentType = r.headers.get("content-type") || "";
      return {ok:true,data:btoa(bin),byteLength:b.byteLength,contentType:contentType};
    } catch(e) {
      return {ok:false,error:e.message};
    }
  })()`;
}

/**
 * Build a fetch expression that downloads a manifest and returns text.
 * @param {string} url
 * @param {Object} [headers]
 * @returns {string}
 */
function buildManifestFetchScript(url, headers) {
  const headerStr = JSON.stringify(headers || {});
  return `(async function(){
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: "GET",
        credentials: "include",
        headers: ${headerStr}
      });
      if (!r.ok) return {ok:false,status:r.status,statusText:r.statusText};
      const text = await r.text();
      return {ok:true,data:text,contentType:r.headers.get("content-type")||""};
    } catch(e) {
      return {ok:false,error:e.message};
    }
  })()`;
}

// ─── Tunnel Download ───────────────────────────────────────────────────

/**
 * Download a single segment through the browser tunnel.
 * @param {number} tabId
 * @param {string} url
 * @param {Object} [requestHeaders]
 * @param {Object} [options]
 * @param {number} [options.timeout=30000]
 * @returns {Promise<{ok: boolean, data?: string, byteLength?: number, contentType?: string, status?: number, error?: string}>}
 */
async function tunnelSegmentDownload(tabId, url, requestHeaders, options = {}) {
  const timeout = options.timeout || 30000;

  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, error: `Could not attach debugger: ${attachResult.error}` };
  }

  const script = buildFetchScript(url, requestHeaders);
  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeout,
  });

  if (!evalResult.ok) {
    return { ok: false, error: evalResult.error || "Runtime.evaluate failed" };
  }

  const result = evalResult.result?.result?.value;
  if (!result) {
    return { ok: false, error: "No result from fetch evaluation" };
  }

  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error || `HTTP ${result.status || "error"}` };
  }

  return {
    ok: true,
    data: result.data,
    byteLength: result.byteLength,
    contentType: result.contentType,
  };
}

/**
 * Download a manifest (M3U8/MPD) through the browser tunnel.
 * @param {number} tabId
 * @param {string} url
 * @param {Object} [requestHeaders]
 * @returns {Promise<{ok: boolean, data?: string, contentType?: string, error?: string}>}
 */
async function tunnelManifestDownload(tabId, url, requestHeaders) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, error: `Could not attach debugger: ${attachResult.error}` };
  }

  const script = buildManifestFetchScript(url, requestHeaders);
  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: true,
    timeout: 15000,
  });

  if (!evalResult.ok) {
    return { ok: false, error: evalResult.error };
  }

  const result = evalResult.result?.result?.value;
  if (!result || !result.ok) {
    return { ok: false, error: result?.error || "Manifest fetch failed" };
  }

  return {
    ok: true,
    data: result.data,
    contentType: result.contentType,
  };
}

/**
 * Extract cf_clearance cookie from the tab (for Cloudflare bypass).
 * Delegates to cloudflare_solver.js which shares the extractCookies dependency.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function extractCfClearanceCookie(tabId) {
  return extractCFClearance(tabId);
}

export {
  tunnelSegmentDownload,
  tunnelManifestDownload,
  extractCfClearanceCookie,
  cleanup,
  // Exported for testing
  buildFetchScript,
  buildManifestFetchScript,
};
