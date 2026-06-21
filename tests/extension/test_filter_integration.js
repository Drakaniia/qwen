import assert from "node:assert/strict";

import * as mediaCandidates from "../../src/shared/media_candidates.js";

// Phase A1 — AD_RE enhancements: new ad domains from uBO's filter lists

// Existing patterns should still work
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://ad.doubleclick.net/ddm/track/123"),
  true,
  "doubleclick should still be blocked (existing pattern)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://www.googleapis.com/youtube/v3/videos"),
  false,
  "legitimate API calls should not be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/movie.mp4"),
  false,
  "legitimate video URLs should not be blocked",
);

// New ad domains from uBO filter lists

// High priority
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://secure.adnxs.com/video/123"),
  true,
  "adnxs.com should be blocked as AppNexus ad exchange",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://static.clmbtech.com/ad/456"),
  true,
  "clmbtech.com should be blocked as ad tech platform",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://assets.adobedtm.com/launch.js"),
  true,
  "adobedtm.com should be blocked as Adobe Dynamic Tag Manager",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://v.fwmrm.net/ad/g/1?"),
  true,
  "fwmrm.net should be blocked as FreeWheel ad framework",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://2mdn.net/video/ad.mp4"),
  true,
  "2mdn.net should be blocked as Google/DoubleClick ad serving",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://popads.net/pop.js"),
  true,
  "popads.net should be blocked as popunder ad network",
);

// Medium priority
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://crwdcntrl.net/track/123"),
  true,
  "crwdcntrl.net should be blocked as Crowd Control ad platform",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://chartbeat.com/ping"),
  true,
  "chartbeat.com should be blocked as ad analytics",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://ensighten.com/tag-manager.js"),
  true,
  "ensighten.com should be blocked as tag manager",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://js.spotx.tv/directsdk/"),
  true,
  "spotx.tv should be blocked as SpotX video ad marketplace",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://spotxcdn.com/integration/directsdk/"),
  true,
  "spotxcdn.com should be blocked as SpotX CDN ad delivery",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://smartclip.net/ad/delivery"),
  true,
  "smartclip.net should be blocked as ad delivery platform",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://adaptv.advertising.com/ad"),
  true,
  "adaptv.advertising.com should be blocked as video ad platform",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://youbora.com/analytics/123"),
  true,
  "youbora.com should be blocked as NPAW analytics",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://youboranqs01.com/analytics/123"),
  true,
  "youboranqs01.com should be blocked as NPAW analytics (alt domain)",
);

// False-positive guard: make sure legitimate domains are NOT blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/ad-free-movie.mp4"),
  false,
  "URLs containing 'ad' in legitimate contexts should not be blocked by adjacent patterns",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://spotify.com/track/123"),
  false,
  "spotify.com should not be blocked (not an ad domain)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://netflix.com/watch/123"),
  false,
  "netflix.com should not be blocked",
);

// Phase A2 — CDN_HINT_RE enhancements: video CDN patterns from uBO's unbreak lists

// Existing CDN_HINT_RE patterns should still work
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.example.com/hls/master.m3u8", "media", ""),
  true,
  "hls in URL should be detected via CDN_HINT_RE",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.example.com/akamaihd.net/stream", "media", ""),
  true,
  "akamaihd should be detected via CDN_HINT_RE",
);

// New CDN patterns from uBO unbreak lists
// NOTE: URLs must NOT end in .js/.css (STATIC_PLAYER_ASSET_RE would block them first)
// Use no-extension paths or non-blocked extensions to exercise CDN_HINT_RE

// Akamai
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://analytics.edgesuite.net/html5/akamaihtml5-min", "media", ""),
  true,
  "edgesuite should be detected as Akamai video CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://msavideo-a.akamaihd.net/stream", "media", ""),
  true,
  "msavideo should be detected as MSN video CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://hdliveextra-a.akamaihd.net/live", "media", ""),
  true,
  "hdliveextra should be detected as NBC Sports CDN",
);

// Broadcast CDNs
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://espncdn.com/redesign/video/stream", "media", ""),
  true,
  "espncdn.com should be detected as ESPN CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.turner.com/cnn/video/stream", "media", ""),
  true,
  "turner.com should be detected as CNN/Turner CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cbsistatic.com/assets/video-data", "media", ""),
  true,
  "cbsistatic should be detected as CBS video CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cbsnews.com/video/stream", "media", ""),
  true,
  "cbsnews should be detected as CBS video CDN",
);

// Video platform CDNs
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.gotraffic.net/video/stream", "media", ""),
  true,
  "gotraffic should be detected as Bloomberg video CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://src.litix.io/core/player/core", "media", ""),
  true,
  "litix.io should be detected as Mux video platform",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://player.ooyala.com/video/stream", "media", ""),
  true,
  "ooyala should be detected as Ooyala video player",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://p.jwpcdn.com/player/embed", "media", ""),
  true,
  "jwpcdn should be detected as JW Player CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.streamroot.io/dna-client/loader", "media", ""),
  true,
  "streamroot should be detected as P2P video delivery",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://play2.qbrick.com/framework/loader", "media", ""),
  true,
  "qbrick should be detected as Qbrick video platform",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://v.embed-cdn.com/v8/player", "media", ""),
  true,
  "embed-cdn should be detected as video embed CDN",
);

// Chinese streaming CDNs
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://msstatic.com/huya/p2plib", "media", ""),
  true,
  "msstatic should be detected as Chinese streaming CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://douyucdn.cn/front-publish/sdk", "media", ""),
  true,
  "douyucdn should be detected as Douyu streaming CDN",
);

// Video hosting platforms
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://flashx.pw/player/embed", "media", ""),
  true,
  "flashx should be detected as video hosting platform",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://vidoza.net/player/embed", "media", ""),
  true,
  "vidoza should be detected as video hosting platform",
);

// Negative tests: non-media resource types should NOT trigger CDN_HINT_RE
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://espncdn.com/redesign/video/player.js", "script", ""),
  false,
  "non-media resource type should not be affected by CDN_HINT_RE",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.gotraffic.net/video/stream", "xhr", ""),
  false,
  "xhr resource type should not be affected by CDN_HINT_RE",
);

// Negative tests: URLs that are blocked should still return false
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://ads.example.com/preroll.mp4", "media", ""),
  false,
  "blocked ad URLs should not be detected as video requests",
);

// Phase A3 — Exception domain handling: whitelisted domains bypass block
// NOTE: function signature is (url, contentType = "", exceptionDomains) — pass all 3 args

// Whitelisted domain that matches AD_RE should bypass block
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://akamaihd.net/player/akamai/amp/prebid/js",
    "",
    new Set(["akamaihd.net"]),
  ),
  false,
  "whitelisted domain (akamaihd.net) should bypass AD_RE block",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://msavideo-a.akamaihd.net/stream",
    "",
    new Set(["akamaihd.net"]),
  ),
  false,
  "subdomain of whitelisted domain should also bypass block",
);

// Non-whitelisted domain should still be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://doubleclick.net/ad",
    "",
    new Set(["akamaihd.net"]),
  ),
  true,
  "non-whitelisted domain should still be blocked",
);

// URL that would NOT be blocked should pass through unaffected
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://cdn.example.com/movie.mp4",
    "",
    new Set([]),
  ),
  false,
  "already-passing URLs should not be affected by exceptions",
);

// Multiple exception domains
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://v.fwmrm.net/ad/g/1",
    "",
    new Set(["akamaihd.net", "fwmrm.net"]),
  ),
  false,
  "whitelisted fwmrm.net should bypass block when in exception set",
);

// Empty exception set should behave like regular isBlockedMediaUrl
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://popads.net/pop.js",
    "",
    new Set(),
  ),
  true,
  "empty exception set should not bypass any blocks",
);

// Exception for a domain not matching this URL should not affect blocking
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://doubleclick.net/ad",
    "",
    new Set(["some-other-domain.com"]),
  ),
  true,
  "exception for a different domain should not bypass block",
);

// Domain prefix matching: 'example.com' should not match 'not-example.com'
// Use doubleclick in the path to guarantee it's blocked by AD_RE
assert.equal(
  mediaCandidates.isBlockedMediaUrlWithExceptions(
    "https://not-akamaihd.net/doubleclick/ad",
    "",
    new Set(["akamaihd.net"]),
  ),
  true,
  "domain prefix should not cause false exception match",
);

console.log("filter integration tests passed");
