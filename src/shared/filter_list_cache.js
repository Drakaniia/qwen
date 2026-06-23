"use strict";

/**
 * Filter List Cache — chrome.storage.local persistence for parsed filter rules.
 *
 * Extracted from filter_list_loader.js for modularity.
 */

import {
  CACHE_KEY_PREFIX,
  COMPILED_PATTERNS_KEY,
} from "./filter_list_config.js";

// ── Cache management ───────────────────────────────────────────────────────

/**
 * Load cached rules from chrome.storage.local.
 * Returns null if no cache exists.
 *
 * @param {string} listKey — e.g. "unbreak"
 * @returns {Promise<{fetchedAt: number, etag: string|null, rules: Array}|null>}
 */
async function loadFromCache(listKey) {
  if (!listKey || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return null;
  }

  const cacheKey = CACHE_KEY_PREFIX + listKey;
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(cacheKey, (data) => {
        void chrome.runtime.lastError;
        resolve(data || {});
      });
    });
    return result[cacheKey] || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Save parsed rules to chrome.storage.local with metadata.
 *
 * @param {string} listKey — e.g. "unbreak"
 * @param {Array<object>} rules — Parsed FilterRule objects
 * @param {object} [meta] — Optional metadata (etag, etc.)
 * @returns {Promise<void>}
 */
async function saveToCache(listKey, rules, meta = {}) {
  if (!listKey || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return;
  }

  const cacheKey = CACHE_KEY_PREFIX + listKey;
  const cacheEntry = {
    fetchedAt: Date.now(),
    etag: meta.etag || null,
    rules: serializeRules(rules),
  };

  try {
    await new Promise((resolve) => {
      chrome.storage.local.set({ [cacheKey]: cacheEntry }, resolve);
    });
  } catch (_error) {
    // Silently fail — cache is best-effort
  }
}

/**
 * Serialize rules for storage (strip non-serializable fields like compiled RegExp).
 * @param {Array<object>} rules
 * @returns {Array<object>}
 */
function serializeRules(rules) {
  return (rules || []).map((rule) => ({
    type: rule.type,
    raw: rule.raw,
    domain: rule.domain || null,
    path: rule.path || null,
    options: rule.options || null,
    optionTags: rule.optionTags ? Array.from(rule.optionTags) : [],
    scopeDomains: rule.scopeDomains ? Array.from(rule.scopeDomains) : null,
    // RegExp is not serializable — omit it; recompile on load
  }));
}

/**
 * Deserialize rules from storage (restore Set objects from arrays).
 * @param {Array<object>} serialized
 * @returns {Array<object>}
 */
function deserializeRules(serialized) {
  return (serialized || []).map((rule) => ({
    ...rule,
    optionTags: Array.isArray(rule.optionTags) ? new Set(rule.optionTags) : new Set(),
    scopeDomains: Array.isArray(rule.scopeDomains) ? new Set(rule.scopeDomains) : null,
    compiled: null,
  }));
}

/**
 * Load previously compiled patterns from cache.
 * @returns {Promise<{adDomains: string[], exceptionDomains: string[], cdnDomains: string[]}|null>}
 */
async function loadCompiledPatterns() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return null;
  }

  try {
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(COMPILED_PATTERNS_KEY, (data) => {
        void chrome.runtime.lastError;
        resolve(data || {});
      });
    });
    return result[COMPILED_PATTERNS_KEY] || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Save compiled patterns to cache.
 * @param {{adDomains: string[], exceptionDomains: string[], cdnDomains: string[]}} patterns
 * @returns {Promise<void>}
 */
async function saveCompiledPatterns(patterns) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    return;
  }

  const entry = {
    lastCompiled: Date.now(),
    ...patterns,
  };

  try {
    await new Promise((resolve) => {
      chrome.storage.local.set({ [COMPILED_PATTERNS_KEY]: entry }, resolve);
    });
  } catch (_error) {
    // Best-effort
  }
}

// ── isCacheExpired ─────────────────────────────────────────────────────────

/**
 * Check if a cached entry is expired based on the list's refresh interval.
 *
 * @param {{ fetchedAt: number }} cacheEntry
 * @param {number} refreshDays — Refresh interval in days
 * @returns {boolean}
 */
function isCacheExpired(cacheEntry, refreshDays) {
  if (!cacheEntry || !cacheEntry.fetchedAt) {
    return true;
  }
  const maxAgeMs = (refreshDays || 5) * 24 * 60 * 60 * 1000;
  return Date.now() - cacheEntry.fetchedAt > maxAgeMs;
}

export {
  loadFromCache,
  saveToCache,
  serializeRules,
  deserializeRules,
  loadCompiledPatterns,
  saveCompiledPatterns,
  isCacheExpired,
};
