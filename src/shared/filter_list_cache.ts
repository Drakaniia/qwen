/**
 * Filter List Cache — chrome.storage.local persistence for parsed filter rules.
 *
 * Extracted from filter_list_loader.js for modularity.
 *
 * Uses `chrome.storage.local` directly rather than the `browser_api` shim: the
 * service worker is the only caller, and the shim's promise/callback branching would
 * add nothing here. The `typeof chrome === "undefined"` guards are what let the same
 * module load in a page context with no extension APIs.
 */

import {
  CACHE_KEY_PREFIX,
  COMPILED_PATTERNS_KEY,
  type CompiledFilterPatterns,
  type FilterCacheEntry,
  type FilterRule,
  type SerializedFilterRule,
} from "./filter_list_config.js";

// ── Cache management ───────────────────────────────────────────────────────

/** Whether `chrome.storage.local` is reachable from here. */
function hasStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage) && Boolean(chrome.storage.local);
}

/** One `storage.local.get` as a promise. A read error resolves to `{}`, not a rejection. */
function readStorage(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (data) => {
      void chrome.runtime.lastError;
      resolve((data || {}) as Record<string, unknown>);
    });
  });
}

/** One `storage.local.set` as a promise. */
function writeStorage(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, resolve);
  });
}

/**
 * Load cached rules from chrome.storage.local.
 * Returns null if no cache exists.
 *
 * @param listKey — e.g. "unbreak"
 */
async function loadFromCache(listKey: string): Promise<FilterCacheEntry | null> {
  if (!listKey || !hasStorage()) {
    return null;
  }

  const cacheKey = CACHE_KEY_PREFIX + listKey;
  try {
    const result = await readStorage(cacheKey);
    return (result[cacheKey] as FilterCacheEntry) || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Save parsed rules to chrome.storage.local with metadata.
 *
 * @param listKey — e.g. "unbreak"
 * @param rules — Parsed FilterRule objects
 * @param meta — Optional metadata (etag, etc.)
 */
async function saveToCache(listKey: string, rules: FilterRule[], meta: { etag?: string | null } = {}): Promise<void> {
  if (!listKey || !hasStorage()) {
    return;
  }

  const cacheKey = CACHE_KEY_PREFIX + listKey;
  const cacheEntry = {
    fetchedAt: Date.now(),
    etag: meta.etag || null,
    rules: serializeRules(rules),
  };

  try {
    await writeStorage({ [cacheKey]: cacheEntry });
  } catch (_error) {
    // Silently fail — cache is best-effort
  }
}

/**
 * Serialize rules for storage (strip non-serializable fields like compiled RegExp).
 */
function serializeRules(rules: FilterRule[]): SerializedFilterRule[] {
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
 */
function deserializeRules(serialized: SerializedFilterRule[]): FilterRule[] {
  return (serialized || []).map((rule) => ({
    ...rule,
    optionTags: Array.isArray(rule.optionTags) ? new Set(rule.optionTags) : new Set<string>(),
    scopeDomains: Array.isArray(rule.scopeDomains) ? new Set(rule.scopeDomains) : null,
    compiled: null,
  }));
}

/**
 * Load previously compiled patterns from cache.
 */
async function loadCompiledPatterns(): Promise<(CompiledFilterPatterns & { lastCompiled?: number }) | null> {
  if (!hasStorage()) {
    return null;
  }

  try {
    const result = await readStorage(COMPILED_PATTERNS_KEY);
    return (result[COMPILED_PATTERNS_KEY] as CompiledFilterPatterns & { lastCompiled?: number }) || null;
  } catch (_error) {
    return null;
  }
}

/**
 * Save compiled patterns to cache.
 */
async function saveCompiledPatterns(patterns: CompiledFilterPatterns): Promise<void> {
  if (!hasStorage()) {
    return;
  }

  const entry = {
    lastCompiled: Date.now(),
    ...patterns,
  };

  try {
    await writeStorage({ [COMPILED_PATTERNS_KEY]: entry });
  } catch (_error) {
    // Best-effort
  }
}

export { loadFromCache, saveToCache, serializeRules, deserializeRules, loadCompiledPatterns, saveCompiledPatterns };
