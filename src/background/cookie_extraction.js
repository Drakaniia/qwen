"use strict";

/**
 * Cookie Extraction Module
 *
 * Uses Chrome DevTools Protocol (via chrome.debugger) to extract cookies,
 * request headers, and localStorage tokens from a browser tab. These are
 * then injected into download backends to authenticate requests through
 * Cloudflare, signed-URL CDNs, and other session-gated endpoints.
 *
 * CDP helpers (attach, detach, sendCommand, cleanup) are imported from
 * the shared cdp_helpers.js module to avoid code duplication.
 */

import { attach, sendCommand, cleanup } from "./cdp_helpers.js";

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Extract all cookies for all domains from the tab.
 * @param {number} tabId
 * @returns {Promise<Array<{name: string, value: string, domain: string, path: string, secure: boolean, httpOnly: boolean}>>}
 */
async function extractCookies(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    console.warn("[cookie-extraction] Could not attach debugger:", attachResult.error);
    return [];
  }

  const cmdResult = await sendCommand(tabId, "Network.getAllCookies");
  if (!cmdResult.ok || !cmdResult.result) {
    return [];
  }

  const cookies = (cmdResult.result.cookies || []).map((c) => ({
    name: c.name || "",
    value: c.value || "",
    domain: c.domain || "",
    path: c.path || "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
  }));

  // Don't detach — caller may call extractHeaders or extractLocalStorage afterward.
  // Caller must call cleanup() when done.
  return cookies;
}

/**
 * Extract HTTP headers from the tab's active frame via Runtime.evaluate.
 * Grabs document.referrer and any meta-tag-sourced headers.
 * @param {number} tabId
 * @returns {Promise<Array<{name: string, value: string}>>}
 */
async function extractHeaders(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return [];
  }

  const script = `(function() {
    var headers = [];
    try {
      var ref = document.referrer;
      if (ref) headers.push({ name: "Referer", value: ref });
    } catch(e) {}
    try {
      var ua = navigator.userAgent;
      if (ua) headers.push({ name: "User-Agent", value: ua });
    } catch(e) {}
    return headers;
  })()`;

  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: 5000,
  });

  if (!evalResult.ok || !evalResult.result || !evalResult.result.result || !evalResult.result.result.value) {
    return [];
  }
  return evalResult.result.result.value;
}

/**
 * Extract localStorage and IndexedDB tokens from the tab.
 * Some sites store API tokens in localStorage rather than cookies.
 * @param {number} tabId
 * @returns {Promise<Record<string, string>>}
 */
async function extractLocalStorage(tabId) {
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return {};
  }

  const script = `(function() {
    var result = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key) || "";
      }
    } catch(e) {}
    return result;
  })()`;

  const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: 5000,
  });

  if (!evalResult.ok || !evalResult.result || !evalResult.result.result || !evalResult.result.result.value) {
    return {};
  }
  return evalResult.result.result.value;
}

/**
 * Format an array of cookie objects into a semicolon-separated Cookie header string.
 * @param {Array|null|undefined} cookies
 * @returns {string}
 */
function cookiesToCookieString(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return "";
  }
  return cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export { extractCookies, extractHeaders, extractLocalStorage, cookiesToCookieString, cleanup };
