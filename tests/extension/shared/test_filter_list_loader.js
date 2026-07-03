import assert from "node:assert/strict";

import * as loader from "../../../src/shared/filter_list_loader.js";

// ── parseFilterList ────────────────────────────────────────────────────────

// Rule type constants
const RULE_BLOCK = "block";
const RULE_EXCEPTION = "exception";
const RULE_REGEX = "regex";

// 1. Parses domain blocking rule (||domain.com^)
assert.equal(
  loader.parseFilterList("||doubleclick.net^")[0].type,
  RULE_BLOCK,
  "||doubleclick.net^ should be parsed as block rule",
);

assert.equal(
  loader.parseFilterList("||doubleclick.net^")[0].domain,
  "doubleclick.net",
  "||doubleclick.net^ should extract domain doubleclick.net",
);

// 2. Parses exception rule (@@||domain.com^)
const exceptionRules = loader.parseFilterList("@@||cdn.example.com^$media");
assert.equal(exceptionRules[0].type, RULE_EXCEPTION, "@@ rule should be parsed as exception");
assert.equal(exceptionRules[0].domain, "cdn.example.com", "@@ rule should extract domain");

// 3. Parses domain-scoped rule ($domain=)
const scopedRules = loader.parseFilterList("||adserver.com^$domain=twitch.tv|youtube.com");
assert.ok(scopedRules[0].scopeDomains instanceof Set, "scopeDomains should be a Set");
assert.ok(scopedRules[0].scopeDomains.has("twitch.tv"), "scopeDomains should include twitch.tv");
assert.ok(scopedRules[0].scopeDomains.has("youtube.com"), "scopeDomains should include youtube.com");

// 4. Parses filter options ($script, $media, $xhr)
const optionRules = loader.parseFilterList("||adserver.com/video$media");
assert.ok(optionRules[0].optionTags.has("media"), "optionTags should include media");

const scriptRules = loader.parseFilterList("||analytics.com/track.js$script");
assert.ok(scriptRules[0].optionTags.has("script"), "optionTags should include script");

// 5. Ignores cosmetic filters (##)
assert.equal(loader.parseFilterList("example.com##.ad-banner").length, 0, "cosmetic filters (##) should be ignored");

assert.equal(
  loader.parseFilterList("example.com##+js(set, var, value)").length,
  0,
  "scriptlet injection filters should be ignored",
);

// 6. Ignores empty and comment lines
const mixedRules = loader.parseFilterList("\n! comment\n||example.com^\n");
assert.equal(mixedRules.length, 1, "should skip blank lines and comments");
assert.equal(mixedRules[0].domain, "example.com", "comment-skipped rule should have correct domain");

// 7. Ignores section headers ([Adblock Plus 3.8])
assert.equal(loader.parseFilterList("[Adblock Plus 3.8]").length, 0, "section headers should be ignored");

assert.equal(
  loader.parseFilterList("! Title: uBlock filters").length,
  0,
  "comment lines starting with ! should be ignored",
);

// 8. Parses rule with path
const pathRules = loader.parseFilterList("||ads.example.com/path/to/ad");
assert.equal(pathRules[0].domain, "ads.example.com", "path rule should extract domain");
assert.equal(pathRules[0].path, "/path/to/ad", "path rule should extract path");

// 9. Parses regex pattern rules (/pattern/)
const regexRules = loader.parseFilterList("/ads\\d+\\.example\\.com/");
assert.equal(regexRules[0].type, RULE_REGEX, "regex pattern should be parsed as regex type");

// 10. Parses $important option
const importantRules = loader.parseFilterList("||adserver.com^$important");
assert.ok(importantRules[0].optionTags.has("important"), "optionTags should include important");

// 11. Parses $third-party option
const thirdPartyRules = loader.parseFilterList("||tracker.com^$third-party");
assert.ok(thirdPartyRules[0].optionTags.has("third-party"), "optionTags should include third-party");

// 12. Preserves raw rule text
const rawRules = loader.parseFilterList("||doubleclick.net^");
assert.equal(rawRules[0].raw, "||doubleclick.net^", "raw rule text should be preserved");

// 13. Handles rule with $domain and $script options together
const multiOptionRules = loader.parseFilterList("||adserver.com^$script,domain=twitch.tv|youtube.com");
assert.ok(multiOptionRules[0].optionTags.has("script"), "multi-option rule should include script tag");
assert.ok(multiOptionRules[0].scopeDomains.has("twitch.tv"), "multi-option rule scopeDomains should include twitch.tv");

// ── extractVideoRelevantRules ──────────────────────────────────────────────

// 14. Keeps $media rules
const mediaRules = loader.parseFilterList("||adserver.com/video$media");
assert.equal(loader.extractVideoRelevantRules(mediaRules).length, 1, "$media rules should be kept as video-relevant");

// 15. Keeps exception rules (@@)
const exceptionRulesForExtract = loader.parseFilterList("@@||cdn.example.com^$media");
assert.equal(
  loader.extractVideoRelevantRules(exceptionRulesForExtract).length,
  1,
  "exception rules should be kept as video-relevant",
);

// 16. Keeps blocking rules for ad domains
const blockRules = loader.parseFilterList("||doubleclick.net^\n||popads.net^");
assert.equal(
  loader.extractVideoRelevantRules(blockRules).length,
  2,
  "blocking rules for known ad domains should be kept",
);

// 17. Filters out cosmetic and irrelevant rules
const mixedIrrelevant = loader.parseFilterList("! comment\nexample.com##.ad-banner\n||doubleclick.net^\n");
assert.equal(
  loader.extractVideoRelevantRules(mixedIrrelevant).length,
  1,
  "irrelevant rules should be filtered out, keeping only relevant ones",
);

// 18. extractVideoRelevantRules preserves rule structure
const preservedRule = loader.extractVideoRelevantRules(loader.parseFilterList("||doubleclick.net^$media"));
assert.equal(preservedRule[0].type, RULE_BLOCK, "extracted rule should preserve type");
assert.equal(preservedRule[0].domain, "doubleclick.net", "extracted rule should preserve domain");

// ── listKeys / configureList ───────────────────────────────────────────────

// 19. getConfiguredLists returns default list configs
const lists = loader.getConfiguredLists();
assert.ok(Array.isArray(lists), "getConfiguredLists should return an array");
assert.ok(lists.length >= 6, "should have at least 6 configured filter lists");
const unbreakList = lists.find((l) => l.key === "unbreak");
assert.ok(unbreakList, "unbreak list should be configured");
assert.ok(unbreakList.url.includes("unbreak.txt"), "unbreak list should have correct URL");

console.log("filter list loader tests passed");
