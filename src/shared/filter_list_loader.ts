/**
 * Filter List Loader for Qwin Video Downloader
 *
 * Downloads uBlock Origin filter lists and extracts domain patterns
 * relevant to video detection and ad filtering.
 *
 * This is the main entry point that orchestrates the sub-modules:
 *   - filter_list_config.ts — Constants, domain sets, list definitions
 *   - filter_list_parser.ts — Parse adblock filter syntax
 *   - filter_list_cache.ts  — chrome.storage.local persistence
 *
 * Lifecycle:
 *   1. fetchFilterList(url) — Raw download with HTTP caching
 *   2. parseFilterList(text) — Parse adblock filter syntax
 *   3. extractVideoRelevantRules(rules) — Filter to video-relevant subset
 *   4. saveToCache / loadFromCache — chrome.storage.local persistence
 *   5. compileActivePatterns — Convert to Qwin's pattern format
 *   6. getActivePatterns / refreshAllLists — Orchestration entry points
 */

import { FILTER_LISTS, RULE_BLOCK, RULE_EXCEPTION, type CompiledFilterPatterns } from "./filter_list_config.js";

import { extractVideoRelevantRules, parseFilterList } from "./filter_list_parser.js";

import {
  deserializeRules,
  loadCompiledPatterns,
  loadFromCache,
  saveCompiledPatterns,
  saveToCache,
} from "./filter_list_cache.js";

// ── fetchFilterList ────────────────────────────────────────────────────────

/** Cached validators for a conditional request. */
interface CachedHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

/** The outcome of one list fetch. `cached: true` means 304 — the cached copy stands. */
interface FilterListResponse {
  ok: boolean;
  text: string | null;
  etag: string | null;
  lastModified: string | null;
  cached: boolean;
}

const FAILED_FETCH: FilterListResponse = { ok: false, text: null, etag: null, lastModified: null, cached: false };

/**
 * Download a filter list from a URL with HTTP caching support.
 * Returns the text content and any caching headers.
 *
 * @param url — Filter list URL
 * @param cachedHeaders — Previously cached headers
 */
async function fetchFilterList(url: string, cachedHeaders: CachedHeaders = {}): Promise<FilterListResponse> {
  if (!url) {
    return { ...FAILED_FETCH };
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

    let response: Response;
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
      return { ...FAILED_FETCH };
    }

    const text = await response.text();

    // Extract caching headers
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    return { ok: true, text, etag, lastModified, cached: false };
  } catch (_error) {
    // Network error, timeout, etc.
    return { ...FAILED_FETCH };
  }
}

// ── compileActivePatterns ──────────────────────────────────────────────────

/**
 * Compile rules from cached filter lists into Qwin's pattern format.
 */
async function compileActivePatterns(): Promise<CompiledFilterPatterns> {
  const adDomains: string[] = [];
  const exceptionDomains: string[] = [];
  const cdnDomains: string[] = [];

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
  const result: CompiledFilterPatterns = {
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
 */
async function refreshAllLists(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  for (const list of FILTER_LISTS) {
    let success = false;

    try {
      // Check if we have a cached version with ETag
      let cachedEtag: string | null = null;
      const cachedLastModified: string | null = null;

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
 */
async function getActivePatterns(): Promise<CompiledFilterPatterns> {
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

export {
  // Orchestrator API — the only surface filter_integration.js consumes.
  refreshAllLists,
  getActivePatterns,
};
