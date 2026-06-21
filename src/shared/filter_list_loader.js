"use strict";

/**
 * Filter List Loader for Qwin Video Downloader
 *
 * Downloads uBlock Origin filter lists and extracts domain patterns
 * relevant to video detection and ad filtering.
 *
 * Lifecycle:
 *   1. fetchFilterList(url) — Raw download with HTTP caching
 *   2. parseFilterList(text) — Parse adblock filter syntax
 *   3. extractVideoRelevantRules(rules) — Filter to video-relevant subset
 *   4. saveToCache / loadFromCache — chrome.storage.local persistence
 *   5. compileActivePatterns — Convert to Qwin's pattern format
 *   6. getActivePatterns / refreshAllLists — Orchestration entry points
 */

// ── Rule type constants ────────────────────────────────────────────────────

const RULE_BLOCK = "block";
const RULE_EXCEPTION = "exception";
const RULE_REGEX = "regex";

// ── Configured filter lists ────────────────────────────────────────────────

const FILTER_LISTS = [
  {
    key: "ublock-filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    label: "uBlock filters",
    expectedSize: "~500 KB",
    refreshDays: 5,
  },
  {
    key: "unbreak",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
    label: "uBlock filters – Unbreak",
    expectedSize: "~50 KB",
    refreshDays: 5,
  },
  {
    key: "resource-abuse",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
    label: "uBlock filters – Resource abuse",
    expectedSize: "~20 KB",
    refreshDays: 5,
  },
  {
    key: "privacy",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
    label: "uBlock filters – Privacy",
    expectedSize: "~100 KB",
    refreshDays: 5,
  },
  {
    key: "easylist",
    url: "https://easylist.to/easylist/easylist.txt",
    label: "EasyList",
    expectedSize: "~1 MB",
    refreshDays: 1,
  },
  {
    key: "easyprivacy",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    label: "EasyPrivacy",
    expectedSize: "~500 KB",
    refreshDays: 1,
  },
];

// Cache key prefix used in chrome.storage.local
const CACHE_KEY_PREFIX = "filter_cache:";
const COMPILED_PATTERNS_KEY = "filter_compiled_patterns";

// ── Domain-level ad/analytics detect (for extractVideoRelevantRules) ───────

/** Known ad and analytics domains — used to keep block rules for these. */
const KNOWN_AD_DOMAINS = new Set([
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googleads.g.doubleclick.net",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adservice.google.com",
  "adsrvr.org",
  "adnxs.com",
  "advertising.com",
  "adobedtm.com",
  "ensighten.com",
  "moatads.com",
  "scorecardresearch.com",
  "outbrain.com",
  "taboola.com",
  "popads.net",
  "fwmrm.net",
  "clmbtech.com",
  "crwdcntrl.net",
  "chartbeat.com",
  "2mdn.net",
]);

/** Video CDN domains — exception rules for these are video-relevant. */
const KNOWN_VIDEO_CDN_DOMAINS = new Set([
  "akamaihd.net",
  "akamaized.net",
  "edgesuite.net",
  "edgekey.net",
  "cloudfront.net",
  "fastly.net",
  "mux.com",
  "jwplatform.com",
  "jwpcdn.com",
  "brightcove.com",
  "kaltura.com",
  "turner.com",
  "espncdn.com",
  "cbsistatic.com",
  "cbsnews.com",
  "gotraffic.net",
  "litix.io",
  "ooyala.com",
  "streamroot.io",
  "qbrick.com",
  "embed-cdn.com",
]);

/** Streaming platforms whose domains suggest video relevance. */
const KNOWN_STREAMING_DOMAINS = new Set([
  "twitch.tv",
  "youtube.com",
  "vimeo.com",
  "dailymotion.com",
  "hulu.com",
  "netflix.com",
  "disneyplus.com",
  "hbomax.com",
  "paramountplus.com",
  "peacocktv.com",
  "nbcsports.com",
  "foxnews.com",
  "cnn.com",
  "espn.com",
  "bloomberg.com",
  "discovery.com",
  "foodnetwork.com",
  "hgtv.com",
  "destinationamerica.com",
  "bbc.co.uk",
  "cbsnews.com",
  "abc.go.com",
  "ign.com",
  "sbs.com.au",
  "seattlepi.com",
  "sfgate.com",
  "camwhores.tv",
  "streamplay.to",
  "m4ufree.com",
  "costco.com",
  "sonycrackle.com",
  "iheartradio.ca",
]);

// ── parseFilterList ────────────────────────────────────────────────────────

/**
 * Parse raw Adblock/uBO filter syntax into structured FilterRule objects.
 *
 * @param {string} text — Raw filter list content
 * @returns {Array<object>} Array of FilterRule objects
 *
 * Each FilterRule:
 *   { type: 'block'|'exception'|'regex',
 *     raw: string,
 *     domain: string|null,
 *     path: string|null,
 *     options: string|null,
 *     optionTags: Set<string>,
 *     scopeDomains: Set<string>|null,
 *     compiled: RegExp|null }
 */
function parseFilterList(text) {
  const rules = [];
  const lines = String(text || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, and section headers
    if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("[")) {
      continue;
    }

    // Skip cosmetic filters (## — CSS hide or scriptlet injection)
    if (trimmed.includes("##")) {
      continue;
    }

    // Detect exception rule (starts with @@)
    const isException = trimmed.startsWith("@@");

    // Detect regex pattern (starts and ends with /)
    if (trimmed.startsWith("/") && trimmed.endsWith("/") && !isException) {
      try {
        const pattern = trimmed.slice(1, -1);
        rules.push({
          type: RULE_REGEX,
          raw: trimmed,
          domain: null,
          path: null,
          options: null,
          optionTags: new Set(),
          scopeDomains: null,
          compiled: new RegExp(pattern, "i"),
        });
      } catch (_error) {
        // Invalid regex — skip
      }
      continue;
    }

    // Strip @@ prefix for exception rules
    let ruleText = isException ? trimmed.slice(2) : trimmed;

    // Extract $options suffix
    let options = null;
    let optionTags = new Set();
    let scopeDomains = null;
    const dollarIndex = ruleText.indexOf("$");
    if (dollarIndex >= 0) {
      options = ruleText.slice(dollarIndex);
      ruleText = ruleText.slice(0, dollarIndex);
      // Parse options string
      const parsedOptions = parseOptions(options);
      optionTags = parsedOptions.tags;
      scopeDomains = parsedOptions.scopeDomains;
    }

    // Detect domain pattern (starts with ||)
    let domain = null;
    let path = null;
    if (ruleText.startsWith("||")) {
      const afterPrefix = ruleText.slice(2);
      // Remove trailing ^ (separator character)
      const cleaned = afterPrefix.replace(/\^+$/, "");
      // Split domain and path
      const slashIndex = cleaned.indexOf("/");
      if (slashIndex >= 0) {
        domain = cleaned.slice(0, slashIndex);
        path = cleaned.slice(slashIndex);
      } else {
        domain = cleaned;
      }
    } else {
      // URL prefix pattern or other — extract domain from URL if possible
      // For patterns like "example.com/path" without ||
      const slashIndex = ruleText.indexOf("/");
      if (slashIndex >= 0) {
        domain = ruleText.slice(0, slashIndex).replace(/\^+$/, "");
        path = ruleText.slice(slashIndex);
      } else {
        domain = ruleText.replace(/\^+$/, "") || null;
      }
    }

    rules.push({
      type: isException ? RULE_EXCEPTION : RULE_BLOCK,
      raw: trimmed,
      domain: domain || null,
      path: path || null,
      options: options || null,
      optionTags,
      scopeDomains: scopeDomains && scopeDomains.size > 0 ? scopeDomains : null,
      compiled: null,
    });
  }

  return rules;
}

/**
 * Parse the $options portion of an adblock filter rule.
 *
 * @param {string} optionsStr — e.g. "$script,domain=twitch.tv|youtube.com"
 * @returns {{ tags: Set<string>, scopeDomains: Set<string>|null }}
 */
function parseOptions(optionsStr) {
  const tags = new Set();
  let scopeDomains = null;

  if (!optionsStr || !optionsStr.startsWith("$")) {
    return { tags, scopeDomains };
  }

  const parts = optionsStr.slice(1).split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    // Domain restriction: $domain=site1|site2
    if (trimmed.startsWith("domain=")) {
      const domainList = trimmed.slice("domain=".length);
      scopeDomains = new Set(
        domainList
          .split("|")
          .map((d) => d.trim())
          .filter(Boolean),
      );
      continue;
    }

    // Option with value like $redirect=noopjs — store the tag name
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex >= 0) {
      tags.add(trimmed.slice(0, equalsIndex));
    } else {
      tags.add(trimmed);
    }
  }

  return { tags, scopeDomains };
}

// ── extractVideoRelevantRules ─────────────────────────────────────────────

/**
 * Extract only the rules relevant to video/media detection.
 *
 * Keeps rules that:
 * - Target $media requests
 * - Are exception rules (@@) on known video CDN domains
 * - Are blocking rules for known ad domains
 * - Are domain-scoped ($domain=) to known streaming platforms
 *
 * @param {Array<object>} rules — Parsed FilterRule objects
 * @returns {Array<object>} — Filtered subset of rules
 */
function extractVideoRelevantRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }

  return rules.filter((rule) => {
    if (!rule || typeof rule !== "object") {
      return false;
    }

    // Always keep $media rules (video/audio content type)
    if (rule.optionTags && rule.optionTags.has("media")) {
      return true;
    }

    // Keep exception rules (@@) — especially for video CDNs
    if (rule.type === RULE_EXCEPTION) {
      // Exception on a known video domain
      if (rule.domain && isKnownVideoDomain(rule.domain)) {
        return true;
      }
      // Exception scoped to streaming platforms
      if (rule.scopeDomains && rule.scopeDomains.size > 0) {
        for (const d of rule.scopeDomains) {
          if (isKnownStreamingDomain(d)) {
            return true;
          }
        }
      }
      return false;
    }

    // Keep blocking rules for known ad/analytics domains
    if (rule.type === RULE_BLOCK && rule.domain && isKnownAdDomain(rule.domain)) {
      return true;
    }

    // Keep rules scoped to streaming platforms
    if (rule.scopeDomains && rule.scopeDomains.size > 0) {
      for (const d of rule.scopeDomains) {
        if (isKnownStreamingDomain(d)) {
          return true;
        }
      }
    }

    // Keep regex rules (they're usually specific enough to be relevant)
    if (rule.type === RULE_REGEX) {
      return true;
    }

    return false;
  });
}

/** Check if a domain matches a known ad domain (exact or suffix). */
function isKnownAdDomain(domain) {
  const lower = String(domain || "").toLowerCase();
  for (const known of KNOWN_AD_DOMAINS) {
    if (lower === known || lower.endsWith("." + known)) {
      return true;
    }
  }
  return false;
}

/** Check if a domain matches a known video CDN domain. */
function isKnownVideoDomain(domain) {
  const lower = String(domain || "").toLowerCase();
  for (const known of KNOWN_VIDEO_CDN_DOMAINS) {
    if (lower === known || lower.endsWith("." + known)) {
      return true;
    }
  }
  // Also check CDN_HINT_RE-like patterns
  return /(?:akamaihd|akamaized|cloudfront|fastly|edgesuite|edgekey)/i.test(lower);
}

/** Check if a domain matches a known streaming platform. */
function isKnownStreamingDomain(domain) {
  const lower = String(domain || "").toLowerCase();
  for (const known of KNOWN_STREAMING_DOMAINS) {
    if (lower === known || lower.endsWith("." + known)) {
      return true;
    }
  }
  return false;
}

// ── getConfiguredLists ─────────────────────────────────────────────────────

/**
 * Returns the list of configured filter list definitions.
 * @returns {Array<{key: string, url: string, label: string, refreshDays: number}>}
 */
function getConfiguredLists() {
  return FILTER_LISTS.map((list) => ({ ...list }));
}

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

// ── Exports ────────────────────────────────────────────────────────────────

export {
  parseFilterList,
  extractVideoRelevantRules,
  fetchFilterList,
  loadFromCache,
  saveToCache,
  loadCompiledPatterns,
  saveCompiledPatterns,
  compileActivePatterns,
  refreshAllLists,
  getActivePatterns,
  getConfiguredLists,
  isCacheExpired,
  // Constants (for tests)
  RULE_BLOCK,
  RULE_EXCEPTION,
  RULE_REGEX,
};
