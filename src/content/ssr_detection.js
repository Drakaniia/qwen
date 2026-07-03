"use strict";

/**
 * SSR Detection Module
 *
 * Extracts HLS/DASH manifest URLs from server-rendered JSON globals
 * embedded in the DOM by SSR frameworks (Next.js, Nuxt.js, and custom).
 *
 * Per spec: Phase 1 — SSR Detection (Content Script)
 *
 * Exports:
 *   - init(seenUrls, videoFilters, pageDetection)  — Entry point
 *   - scanSSRGlobals(seenUrls, videoFilters, pageDetection) — Scan DOM for SSR globals
 *   - extractHLSUrlsFromJSON(jsonData) — Recursive JSON walker for HLS URLs
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const SSR_GLOBAL_IDS = ["__NEXT_DATA__", "__NUXT__", "__NUXT_STATE__"];

const SSR_WINDOW_GLOBALS = ["__INITIAL_STATE__", "__PRELOADED_STATE__", "__DATA__"];

/** Maximum depth for recursive JSON walking to avoid stack overflow on circular refs. */
const MAX_JSON_DEPTH = 10;

/** Maximum size of JSON text to parse (5 MB) to avoid freezing the tab. */
const MAX_JSON_SIZE_BYTES = 5 * 1024 * 1024;

const HLS_URL_RE = /\.m3u8($|\?)/i;

const MEDIA_TYPE_RE = /mpegurl|x-mpegurl|dash\+xml|dash/i;

// ─── JSON Walker ───────────────────────────────────────────────────────────

/**
 * Recursively walk a JSON-parsed value looking for HLS manifest URLs.
 *
 * Returns an array of { url, source } objects, deduplicated by URL.
 *
 * @param {*} data - The parsed JSON value to walk (object, array, string, etc.)
 * @param {number} [maxDepth=MAX_JSON_DEPTH] - Maximum recursion depth.
 * @returns {Array<{url: string, source: string}>}
 */
function extractHLSUrlsFromJSON(data, maxDepth = MAX_JSON_DEPTH) {
  const results = [];
  const seen = new Set();

  function walk(value, depth, path) {
    if (depth > maxDepth || value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (HLS_URL_RE.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        results.push({ url: trimmed, source: `ssr-json:${path}` });
      }
      return;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], depth + 1, `${path}[${i}]`);
      }
      return;
    }

    if (typeof value === "object") {
      // Check for { url, type } or { src, type } patterns first
      const urlVal = value.url || value.src || value.file || value.link || "";
      const typeVal = value.type || value.mimeType || "";
      if (typeof urlVal === "string" && HLS_URL_RE.test(urlVal)) {
        if (!seen.has(urlVal)) {
          seen.add(urlVal);
          results.push({ url: urlVal, source: `ssr-json:${path}.url` });
        }
        return;
      }
      if (typeof typeVal === "string" && MEDIA_TYPE_RE.test(typeVal)) {
        const foundUrl = value.url || value.src || "";
        if (typeof foundUrl === "string" && foundUrl.trim() && !seen.has(foundUrl)) {
          seen.add(foundUrl);
          results.push({ url: foundUrl, source: `ssr-json:${path}.type` });
        }
        return;
      }

      // Recursively walk object keys — priority keys first for performance
      const priorityKeys = ["sources", "src", "url", "manifest", "playlist", "hls", "video", "media", "file", "link"];
      const keys = Object.keys(value);
      const otherKeys = keys.filter((k) => !priorityKeys.includes(k));

      for (const key of [...priorityKeys, ...otherKeys]) {
        const child = value[key];
        if (child !== null && child !== undefined) {
          const childType = typeof child;
          if (childType === "object" || childType === "string") {
            walk(child, depth + 1, `${path}.${key}`);
          }
        }
      }
    }
  }

  walk(data, 0, "root");
  return results;
}

// ─── SSR Global Scanning ───────────────────────────────────────────────────

/**
 * Scan DOM for SSR script elements by ID.
 *
 * @param {Document} document - The page document.
 * @returns {Array<{source: string, data: *}>} Parsed SSR data objects.
 */
function scanScriptElements(document) {
  const results = [];

  for (const id of SSR_GLOBAL_IDS) {
    try {
      const el = document.getElementById(id);
      if (!el) continue;

      const text = el.textContent || "";
      if (!text || text.length > MAX_JSON_SIZE_BYTES) continue;

      const data = JSON.parse(text);
      if (data !== null && data !== undefined) {
        results.push({ source: id, data });
      }
    } catch (_e) {
      // Malformed JSON — skip silently
    }
  }

  // data-state script tags
  try {
    const stateEl = document.querySelector("script[data-state]");
    if (stateEl) {
      const text = stateEl.textContent || "";
      if (text && text.length <= MAX_JSON_SIZE_BYTES) {
        const data = JSON.parse(text);
        if (data !== null && data !== undefined) {
          results.push({ source: "data-state", data });
        }
      }
    }
  } catch (_e) {
    // Skip silently
  }

  return results;
}

/**
 * Scan window globals for SSR state objects.
 *
 * @param {Window} window - The page window object.
 * @returns {Array<{source: string, data: *}>} Parsed SSR data objects.
 */
function scanWindowGlobals(window) {
  const results = [];

  for (const globalName of SSR_WINDOW_GLOBALS) {
    try {
      const data = window[globalName];
      if (data !== null && data !== undefined && typeof data === "object") {
        results.push({ source: globalName, data });
      }
    } catch (_e) {
      // Skip if access is denied (e.g., cross-origin)
    }
  }

  return results;
}

/**
 * Scan all SSR sources (DOM elements + window globals) and extract HLS URLs.
 *
 * @param {Document} [doc=document] - The page document.
 * @param {Window} [win=window] - The page window.
 * @returns {Array<{url: string, source: string}>} Deduplicated HLS URLs.
 */
function scanSSRGlobals(doc, win) {
  const results = [];
  const seenUrls = new Set();
  const document = doc || (typeof globalThis !== "undefined" && globalThis.document) || null;
  const window = win || (typeof globalThis !== "undefined" && globalThis.window) || null;

  // Scan DOM script elements
  if (document) {
    const scriptSources = scanScriptElements(document);
    for (const ssr of scriptSources) {
      const urls = extractHLSUrlsFromJSON(ssr.data);
      for (const u of urls) {
        if (!seenUrls.has(u.url)) {
          seenUrls.add(u.url);
          results.push(u);
        }
      }
    }
  }

  // Scan window globals
  if (window) {
    const globalSources = scanWindowGlobals(window);
    for (const ssr of globalSources) {
      const urls = extractHLSUrlsFromJSON(ssr.data);
      for (const u of urls) {
        if (!seenUrls.has(u.url)) {
          seenUrls.add(u.url);
          results.push(u);
        }
      }
    }
  }

  return results;
}

// ─── Mutation Observer for SPA Rehydration ─────────────────────────────────

/**
 * Install a MutationObserver that re-scans SSR globals when new
 * script tags with SSR IDs are added (e.g., SPA route changes).
 *
 * @param {Function} onNewSSR - Callback fired when new SSR content is detected.
 * @returns {MutationObserver} The observer instance (for disconnection).
 */
function installSSRObserver(onNewSSR) {
  const SSR_IDS = new Set(SSR_GLOBAL_IDS);

  const observer = new MutationObserver((mutations) => {
    let shouldRescan = false;

    for (const mutation of mutations) {
      if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;

      for (const node of mutation.addedNodes) {
        if (!node || node.nodeType !== 1) continue; // ELEMENT_NODE

        // Check if the added node is an SSR script
        if (node.matches && node.matches("script")) {
          const id = node.id || node.getAttribute?.("id") || "";
          if (SSR_IDS.has(id) || node.getAttribute?.("data-state")) {
            shouldRescan = true;
            break;
          }
        }

        // Check if the added node contains SSR script descendants
        if (node.querySelector) {
          const scripts = node.querySelectorAll("script");
          for (const script of scripts) {
            const id = script.id || "";
            if (SSR_IDS.has(id) || script.getAttribute?.("data-state")) {
              shouldRescan = true;
              break;
            }
          }
          if (shouldRescan) break;
        }
      }
      if (shouldRescan) break;
    }

    if (shouldRescan && typeof onNewSSR === "function") {
      // Debounce: wait a tick for the DOM to settle
      clearTimeout(observer._debounceTimer);
      observer._debounceTimer = setTimeout(() => {
        onNewSSR();
      }, 100);
    }
  });

  try {
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  } catch (_e) {
    // Fail silently if we can't observe (e.g., during early page load)
  }

  return observer;
}

// ─── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialize SSR detection.
 *
 * Performs an immediate scan of SSR globals and installs a mutation observer
 * for SPA rehydration. Detected candidates are merged into the page detection
 * pipeline via the publishScan callback.
 *
 * @param {Object} [options]
 * @param {Document} [options.document] - Page document (injectable for testing).
 * @param {Window} [options.window] - Page window (injectable for testing).
 * @param {Function} [options.onCandidates] - Callback(Array<{url, source}>)
 * @returns {{ active: boolean, candidates: Array<{url: string, source: string}>, observer: MutationObserver|null }}
 */
function init(options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  const win = options.window || (typeof window !== "undefined" ? window : null);
  const onCandidates = options.onCandidates || null;

  // Immediate scan
  const candidates = scanSSRGlobals(doc, win);

  // Install mutation observer for SPA rehydration
  // Note: MutationObserver may not be available in all environments
  // (e.g., Node.js test runners, workers). Handle gracefully.
  let observer = null;
  if (doc && typeof MutationObserver !== "undefined") {
    try {
      observer = installSSRObserver(() => {
        const newCandidates = scanSSRGlobals(doc, win);
        if (newCandidates.length > 0 && typeof onCandidates === "function") {
          onCandidates(newCandidates);
        }
      });
    } catch (_e) {
      // MutationObserver failed — skip observer installation
    }
  }

  return {
    active: true,
    candidates,
    observer,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { extractHLSUrlsFromJSON, init, installSSRObserver, scanSSRGlobals };
