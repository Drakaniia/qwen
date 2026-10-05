/**
 * Filter List Configuration — constants, domain sets, filter-list definitions and the
 * rule shape the parser produces and the cache serializes.
 *
 * Extracted from filter_list_loader.js for modularity; imported by the parser and the
 * cache so all three modules agree on what a "rule" is.
 */

// ── Rule type constants ────────────────────────────────────────────────────

const RULE_BLOCK = "block";
const RULE_EXCEPTION = "exception";
const RULE_REGEX = "regex";

/** One configured remote filter list. */
export interface FilterListDefinition {
  /** Cache-key suffix (`filter_cache:<key>`) and the Options row's identity. */
  readonly key: string;
  readonly url: string;
  readonly label: string;
  /** Shown in the Options list so a 0-byte fetch reads as a failure. */
  readonly expectedSize: string;
  /** How often the background re-fetches it. */
  readonly refreshDays: number;
}

// ── Configured filter lists ────────────────────────────────────────────────

const FILTER_LISTS: readonly FilterListDefinition[] = [
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

// ── Parsed rule shape ──────────────────────────────────────────────────────

/**
 * One parsed adblock rule.
 *
 * `compiled` is deliberately not serializable: the cache stores everything else and
 * recompiles on load, because a `RegExp` does not survive `JSON.stringify`.
 */
export interface FilterRule {
  /** `RULE_BLOCK`, `RULE_EXCEPTION` or `RULE_REGEX`. */
  type: string;
  /** The source line, kept for diagnostics. */
  raw: string;
  domain: string | null;
  path: string | null;
  /** The raw `$options` suffix, including the `$`. */
  options: string | null;
  /** Option names, e.g. `media`, `script`, `domain` (the latter also lands in `scopeDomains`). */
  optionTags: Set<string>;
  /** `$domain=` targets, or null when the rule is not domain-scoped. */
  scopeDomains: Set<string> | null;
  compiled: RegExp | null;
}

/**
 * A rule as it sits in `storage.local`: same fields, `Set`s flattened to arrays.
 *
 * `compiled` is absent by construction — a `RegExp` does not survive
 * `JSON.stringify`, so the cache drops it and `deserializeRules` sets it to `null`.
 */
export interface SerializedFilterRule extends Omit<FilterRule, "optionTags" | "scopeDomains" | "compiled"> {
  optionTags: string[];
  scopeDomains: string[] | null;
}

/** What one list's cache entry holds. */
export interface FilterCacheEntry {
  fetchedAt: number;
  etag: string | null;
  rules: SerializedFilterRule[];
}

/** The compiled, deduplicated domain sets the URL classifier consults. */
export interface CompiledFilterPatterns {
  adDomains: string[];
  exceptionDomains: string[];
  cdnDomains: string[];
}

// ── Domain-level ad/analytics detect (for extractVideoRelevantRules) ───────

/** Known ad and analytics domains — used to keep block rules for these. */
const KNOWN_AD_DOMAINS: ReadonlySet<string> = new Set([
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
const KNOWN_VIDEO_CDN_DOMAINS: ReadonlySet<string> = new Set([
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
const KNOWN_STREAMING_DOMAINS: ReadonlySet<string> = new Set([
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

export {
  RULE_BLOCK,
  RULE_EXCEPTION,
  RULE_REGEX,
  FILTER_LISTS,
  CACHE_KEY_PREFIX,
  COMPILED_PATTERNS_KEY,
  KNOWN_AD_DOMAINS,
  KNOWN_VIDEO_CDN_DOMAINS,
  KNOWN_STREAMING_DOMAINS,
};
