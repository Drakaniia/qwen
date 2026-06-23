"use strict";

/**
 * Filter List Loader for Qwin Video Downloader
 *
 * Downloads uBlock Origin filter lists and extracts domain patterns
 * relevant to video detection and ad filtering.
 *
 * This is the main entry point that orchestrates the sub-modules:
 *   - filter_list_config.js — Constants, domain sets, list definitions
 *   - filter_list_parser.js — Parse adblock filter syntax
 *   - filter_list_cache.js  — chrome.storage.local persistence
 *
 * Lifecycle:
 *   1. fetchFilterList(url) — Raw download with HTTP caching
 *   2. parseFilterList(text) — Parse adblock filter syntax
 *   3. extractVideoRelevantRules(rules) — Filter to video-relevant subset
 *   4. saveToCache / loadFromCache — chrome.storage.local persistence
 *   5. compileActivePatterns — Convert to Qwin's pattern format
 *   6. getActivePatterns / refreshAllLists — Orchestration entry points
 */

import {
  RULE_BLOCK,
  RULE_EXCEPTION,
  RULE_REGEX,
  FILTER_LISTS,
} from "./filter_list_config.js";

import {
  parseFilterList,
  parseOptions,
  extractVideoRelevantRules,
  isKnownAdDomain,
  isKnownVideoDomain,
  isKnownStreamingDomain,
} from "./filter_list_parser.js";

import {
  getConfiguredLists,
  loadFromCache,
  saveToCache,
  serializeRules,
  deserializeRules,
  loadCompiledPatterns,
  saveCompiledPatterns,
  isCacheExpired,
} from "./filter_list_cache.js";

// ── fetchFilterList ────────────────────────────────────────────────────────

/**
 * Download a filter list from a URL with HTTP caching support.
 * Returns the text content and any caching headers.
 *
 * @param {string} url — Filter list URL
 * @param {{ etag?: string, lastModified?: string }} [cachedHeaders] — Previously cached headers
 * @returns {Promise<{ok: boolean, text: string|null, etag: string|null, lastModified: string|null, cached: boolean}>}
 */
async function fetchFilterList(url, cachedHeaders = {}) {
  if (!url) {
    return { ok: false, text: null, etag: null, lastModified: null, cached: false };
  }

  try {
    const headers = new Headers({
      Accept: "text/plain, */*",
      "User-Agent": "QwinVideoDownloader/1.0",
    });

    // If we have cached headers, send conditional request
    if (cachedHeaders.etag) {
      headers.set("If-None-Match", cachedHeaders.etag);
    }
    if (cachedHeaders.lastModified) {
      headers.set("If-Modified-Since", cachedHeaders.lastModified);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    } finally {
      clearTimeout(timeout);
    }

    // HTTP 304 Not Modified — content hasn't changed
    if (response.status === 304) {
      return { ok: true, text: null, etag: null, lastModified: null, cached: true };
    }

    if (!response.ok) {
      return {
        ok: false,
        text: null,
        etag: null,
        lastModified: null,
        cached: false,
      };
    }

    const text = await response.text();

    // Extract caching headers
    let etag = null;
    const etagHeader = response.headers.get("etag");
    if (etagHeader) {
      etag = etagHeader;
    }

    let lastModified = null;
    const lmHeader = response.headers.get("last-modified");
    if (lmHeader) {
      lastModified = lmHeader;
    }

    return { ok: true, text, etag, lastModified, cached: false };
  } catch (_error) {
    // Network error, timeout, etc.
    return { ok: false, text: null, etag: null, lastModified: null, cached: false };
  }
}

// ── compileActivePatterns ──────────────────────────────────────────────────

/**
 * Compile rules from cached filter lists into Qwin's pattern format.
 *
 * @returns {Promise<{adDomains: string[], exceptionDomains: string[], cdnDomains: string[]}>}
 */
async function compileActivePatterns() {
  const adDomains = [];
  const exceptionDomains = [];
  const cdnDomains = [];

  for (const list of FILTER_LISTS) {
    const cache = await loadFromCache(list.key);
    if (!cache || !Array.isArray(cache.rules)) {
      continue;
    }

    const rules = deserializeRules(cache.rules);
    const relevant = extractVideoRelevantRules(rules);

    for (const rule of relevant) {
      if (rule.type === RULE_BLOCK && rule.domain) {
        adDomains.push(rule.domain);
      } else if (rule.type === RULE_EXCEPTION && rule.domain) {
        exceptionDomains.push(rule.domain);
      }
    }
  }

  // Deduplicate
  const result = {
    adDomains: [...new Set(adDomains)],
    exceptionDomains: [...new Set(exceptionDomains)],
    cdnDomains: [...new Set(cdnDomains)],
  };

  // Cache the compiled result
  await saveCompiledPatterns(result);

  return result;
}

// ── refreshAllLists ────────────────────────────────────────────────────────

/**
 * Attempt to refresh all configured filter lists.
 * Returns success/failure for each list.
 *
 * @returns {Promise<Object<string, boolean>>}
 */
async function refreshAllLists() {
  const results = {};

  for (const list of FILTER_LISTS) {
    let success = false;

    try {
      // Check if we have a cached version with ETag
      let cachedEtag = null;
      let cachedLastModified = null;

      const cache = await loadFromCache(list.key);
      if (cache) {
        cachedEtag = cache.etag || null;
        // lastModified wasn't stored in the original schema, but we can add it
      }

      const response = await fetchFilterList(list.url, {
        etag: cachedEtag,
        lastModified: cachedLastModified,
      });

      if (response.ok && response.text !== null) {
        // New content received
        const rules = parseFilterList(response.text);
        const relevant = extractVideoRelevantRules(rules);
        await saveToCache(list.key, relevant, { etag: response.etag });
        success = true;
      } else if (response.ok && response.cached) {
        // Content not modified — still a success
        success = true;
      }
    } catch (_error) {
      // Failed to refresh this list
    }

    results[list.key] = success;
  }

  return results;
}

// ── getActivePatterns ─────────────────────────────────────────────────────

/**
 * Get the current set of active patterns for URL classification.
 * Checks cache first, falls back to compiling if no cached patterns exist.
 *
 * @returns {Promise<{adDomains: string[], exceptionDomains: string[], cdnDomains: string[]}>}
 */
async function getActivePatterns() {
  // Try loading previously compiled patterns first
  const cached = await loadCompiledPatterns();
  if (cached && cached.adDomains && cached.exceptionDomains) {
    return {
      adDomains: cached.adDomains || [],
      exceptionDomains: cached.exceptionDomains || [],
      cdnDomains: cached.cdnDomains || [],
    };
  }

  // Fall back to compiling from cached filter lists
  return compileActivePatterns();
}

// ── Exports ────────────────────────────────────────────────────────────────
//
// Re-export everything from child modules so existing consumers
// (filter_integration.js, test_filter_list_loader.js) are unaffected.

// ── Exports ────────────────────────────────────────────────────────────────
//
// Preserves the exact same public API as the original monolithic file.
// Private helpers (parseOptions, serializeRules, deserializeRules, domain
// check functions) are intentionally NOT re-exported — they remain internal.

export {
  // Re-exported from sub-modules (same API as original file)
  parseFilterList,
  extractVideoRelevantRules,
  getConfiguredLists,
  loadFromCache,
  saveToCache,
  loadCompiledPatterns,
  saveCompiledPatterns,
  isCacheExpired,
  // Constants (for tests)
  RULE_BLOCK,
  RULE_EXCEPTION,
  RULE_REGEX,
  // Own exports (orchestrator functions)
  fetchFilterList,
  compileActivePatterns,
  refreshAllLists,
  getActivePatterns,
};
