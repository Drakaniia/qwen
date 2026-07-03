"use strict";

import { browserApi } from "../shared/browser_api.js";

// ── Constants ────────────────────────────────────────────────────────────

// Import isBlockedUrlWithFilters lazily to avoid circular deps.
// Set by background.js at startup.
let isBlockedUrlCheck = null;

function setBlockedUrlCheck(fn) {
  isBlockedUrlCheck = fn;
}

const NATIVE_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "x-requested-with",
]);

const MAX_CAPTURED_REQUEST_HEADERS = 250;

/** Maximum length of the combined Cookie header value.
 *
 * Prevents HTTP 413 "Request Entity Too Large" errors from sites like
 * YouTube/Google that enforce strict header size limits. When the browser
 * has many cookies for a domain (common with Google services), the
 * concatenated cookie string can exceed the server's limit.
 *
 * 4096 bytes keeps all common cookies (session, pref, SAPISID, etc.)
 * while staying well under typical 8 KB server limits.
 */
const MAX_COOKIE_HEADER_LENGTH = 4096;

// ── State ────────────────────────────────────────────────────────────────

const requestHeadersByUrl = {};

// ── Pure utility functions ───────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return String(url || "").split("#")[0];
  }
}

function normalizeHeaderName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function canonicalHeaderName(name) {
  return normalizeHeaderName(name)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("-");
}

function cleanHeaderValue(value) {
  const text = String(value || "")
    .replace(/[\r\n]/g, " ")
    .trim();
  return text.length > 8192 ? text.slice(0, 8192) : text;
}

function addNativeHeader(headerMap, name, value, overwrite = false) {
  const normalizedName = normalizeHeaderName(name);
  const cleanedValue = cleanHeaderValue(value);
  if (!normalizedName || !cleanedValue || !NATIVE_HEADER_NAMES.has(normalizedName)) {
    return;
  }
  if (!overwrite && headerMap.has(normalizedName)) {
    return;
  }
  headerMap.set(normalizedName, {
    name: canonicalHeaderName(normalizedName),
    value: cleanedValue,
  });
}

function capturedNativeHeaders(headers) {
  const headerMap = new Map();
  for (const header of headers || []) {
    addNativeHeader(headerMap, header.name, header.value);
  }
  return Array.from(headerMap.values());
}

function pruneCapturedRequestHeaders() {
  const entries = Object.entries(requestHeadersByUrl);
  if (entries.length <= MAX_CAPTURED_REQUEST_HEADERS) {
    return;
  }

  entries
    .sort((left, right) => Number(left[1].lastSeen || 0) - Number(right[1].lastSeen || 0))
    .slice(0, entries.length - MAX_CAPTURED_REQUEST_HEADERS)
    .forEach(([key]) => {
      delete requestHeadersByUrl[key];
    });
}

function rememberRequestHeaders(details) {
  if (!details || !details.url) {
    return;
  }

  // Skip header capture for URLs blocked by filter lists
  if (isBlockedUrlCheck && isBlockedUrlCheck(details.url)) {
    return;
  }

  const headers = capturedNativeHeaders(details.requestHeaders || []);
  if (!headers.length) {
    return;
  }

  requestHeadersByUrl[normalizeUrl(details.url)] = {
    headers,
    lastSeen: Date.now(),
  };
  pruneCapturedRequestHeaders();
}

function pageOrigin(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch (_error) {
    return "";
  }
}

async function cookieHeaderForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
  } catch (_error) {
    return "";
  }

  const cookies = await browserApi.cookies.getAll({ url });
  let cookieStr = cookies
    .filter((cookie) => cookie && cookie.name)
    .sort((left, right) => String(right.path || "").length - String(left.path || "").length)
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");

  // Truncate oversized cookie headers to prevent HTTP 413 errors.
  // Cut at the last complete cookie boundary within the limit.
  if (cookieStr.length > MAX_COOKIE_HEADER_LENGTH) {
    const truncated = cookieStr.slice(0, MAX_COOKIE_HEADER_LENGTH);
    const lastSep = truncated.lastIndexOf("; ");
    cookieStr = lastSep > 0 ? truncated.slice(0, lastSep) : truncated;
  }

  return cookieStr;
}

async function nativeRequestHeadersForVideo(videoUrl, pageUrl) {
  const headerMap = new Map();
  const captured = requestHeadersByUrl[normalizeUrl(videoUrl)] || {};
  for (const header of captured.headers || []) {
    addNativeHeader(headerMap, header.name, header.value);
  }

  if (pageUrl) {
    addNativeHeader(headerMap, "Referer", pageUrl);
    addNativeHeader(headerMap, "Origin", pageOrigin(pageUrl));
  }

  addNativeHeader(headerMap, "Accept", "*/*");
  addNativeHeader(headerMap, "Accept-Language", "en-US,en;q=0.9");

  const cookieHeader = await cookieHeaderForUrl(videoUrl);
  if (cookieHeader) {
    addNativeHeader(headerMap, "Cookie", cookieHeader);
  }

  return Array.from(headerMap.values());
}

function getRequestHeadersForUrl(url) {
  return requestHeadersByUrl[normalizeUrl(url)] || null;
}

export {
  // Constants
  NATIVE_HEADER_NAMES,
  MAX_CAPTURED_REQUEST_HEADERS,
  MAX_COOKIE_HEADER_LENGTH,

  // State accessor (for testing/inspection)
  getRequestHeadersForUrl,

  // DI: allows background.js to inject the filter-block check
  setBlockedUrlCheck,

  // Core utilities
  normalizeUrl,
  normalizeHeaderName,
  canonicalHeaderName,
  cleanHeaderValue,
  addNativeHeader,
  capturedNativeHeaders,
  pageOrigin,

  // Stateful operations
  rememberRequestHeaders,
  cookieHeaderForUrl,
  nativeRequestHeadersForVideo,
};
