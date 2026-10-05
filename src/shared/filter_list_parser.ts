/**
 * Filter List Parser — Parse Adblock/uBO filter syntax and extract video-relevant rules.
 *
 * Extracted from filter_list_loader.js for modularity.
 *
 * The domain tables this filters against are data ({@link KNOWN_AD_DOMAINS} and
 * friends in `filter_list_config.ts`), so adding a platform is adding a hostname
 * there, not editing a branch here.
 */

import {
  KNOWN_AD_DOMAINS,
  KNOWN_STREAMING_DOMAINS,
  KNOWN_VIDEO_CDN_DOMAINS,
  RULE_BLOCK,
  RULE_EXCEPTION,
  RULE_REGEX,
  type FilterRule,
} from "./filter_list_config.js";

export type { FilterRule } from "./filter_list_config.js";

// ── parseFilterList ────────────────────────────────────────────────────────

/**
 * Parse raw Adblock/uBO filter syntax into structured FilterRule objects.
 *
 * Skips what cannot affect video detection: comments, section headers, cosmetic
 * filters (`##`) and blank lines. Regex rules (`/…/`) are compiled here; everything
 * else keeps `compiled: null` because only domain/path/option fields are read
 * downstream.
 */
function parseFilterList(text: string): FilterRule[] {
  const rules: FilterRule[] = [];
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
    let options: string | null = null;
    let optionTags = new Set<string>();
    let scopeDomains: Set<string> | null = null;
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
    let domain: string | null = null;
    let path: string | null = null;
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

/** The `$options` suffix split into its tags and its `$domain=` scope. */
interface ParsedOptions {
  tags: Set<string>;
  scopeDomains: Set<string> | null;
}

/**
 * Parse the $options portion of an adblock filter rule.
 *
 * @param optionsStr — e.g. "$script,domain=twitch.tv|youtube.com"
 */
function parseOptions(optionsStr: string): ParsedOptions {
  const tags = new Set<string>();
  let scopeDomains: Set<string> | null = null;

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
 * - Are regex rules (they're specific enough to be relevant by construction)
 *
 * The whole point is to shrink a ~1 MB list down to a few hundred domains, so the
 * order matters: `$media` short-circuits before the three table lookups.
 */
function extractVideoRelevantRules(rules: FilterRule[]): FilterRule[] {
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

/** Match `domain` against one of `domains`, exact or as a subdomain. */
function matchesDomainTable(domains: ReadonlySet<string>, domain: string): boolean {
  const lower = domain.toLowerCase();
  for (const known of domains) {
    if (lower === known || lower.endsWith("." + known)) {
      return true;
    }
  }
  return false;
}

/** Check if a domain matches a known ad domain (exact or suffix). */
function isKnownAdDomain(domain: string): boolean {
  return matchesDomainTable(KNOWN_AD_DOMAINS, String(domain || ""));
}

/**
 * Check if a domain matches a known video CDN domain.
 *
 * No "CDN hint" regex fallback here: `matchesDomainTable` already matches all six table
 * entries exactly or as a `.suffix`, and each of their stems (`akamaihd`, `fastly` and
 * the other four) is a substring of its own entry, so such a regex could never be true
 * where this is false. Add a CDN by adding a hostname to `KNOWN_VIDEO_CDN_DOMAINS`.
 */
function isKnownVideoDomain(domain: string): boolean {
  return matchesDomainTable(KNOWN_VIDEO_CDN_DOMAINS, String(domain || ""));
}

/** Check if a domain matches a known streaming platform. */
function isKnownStreamingDomain(domain: string): boolean {
  return matchesDomainTable(KNOWN_STREAMING_DOMAINS, String(domain || ""));
}

export { parseFilterList, parseOptions, extractVideoRelevantRules };
