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

// Chinese streaming CDNs — use manifest URLs (not blocked by A.6)
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://msstatic.com/huya/live/playlist.m3u8", "media", ""),
  true,
  "msstatic manifest should be detected as Chinese streaming CDN",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://douyucdn.cn/live/stream.m3u8", "media", ""),
  true,
  "douyucdn manifest should be detected as Douyu streaming CDN",
);

// Video hosting platforms — use CDN-level media URLs (not page URLs which are blocked by A.3)
assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.flashx.pw/hls/stream.m3u8", "media", ""),
  true,
  "flashx CDN with .m3u8 should be detected via CDN_HINT_RE",
);

assert.equal(
  mediaCandidates.isLikelyVideoRequest("https://cdn.vidoza.net/stream.mp4", "media", ""),
  true,
  "vidoza CDN with .mp4 should be detected via VIDEO_EXTENSION_RE and CDN_HINT_RE",
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

// ── Phase A.3 — Streaming platform host patterns (block page URLs, allow stream URLs) ──

// Video hosting sites: page URLs should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://flashx.pw/player/embed"),
  true,
  "flashx.pw page URL should be blocked (not a real download source)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://vidoza.net/video/12345"),
  true,
  "vidoza.net page URL should be blocked (not a real download source)",
);

// Video hosting sites: actual stream CDN URLs with video extensions should NOT be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.flashx.pw/hls/master.m3u8"),
  false,
  "flashx.pw CDN with .m3u8 should NOT be blocked (real stream URL)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.vidoza.net/stream.mp4"),
  false,
  "vidoza.net CDN with .mp4 should NOT be blocked (real stream URL)",
);

// Streaming platforms: page URLs should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://streamplay.to/video/abc123"),
  true,
  "streamplay.to page URL should be blocked",
);

// Live streaming: page URLs should be blocked (not direct video sources)
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://twitch.tv/example"),
  true,
  "twitch.tv page URL should be blocked (not a direct video source)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://trovo.live/example"),
  true,
  "trovo.live page URL should be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://kick.com/example"),
  true,
  "kick.com page URL should be blocked",
);

// Live streaming: actual CDN stream URLs with video extensions should NOT be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://video.twitch.tv/hls/stream.m3u8"),
  false,
  "twitch.tv CDN with .m3u8 should NOT be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.kick.com/stream.m3u8"),
  false,
  "kick.com CDN with .m3u8 should NOT be blocked",
);

// P2P streaming platforms: page URLs should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://www.douyu.com/room/12345"),
  true,
  "douyu.com page URL should be blocked (not a direct video source)",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://www.huya.com/room/12345"),
  true,
  "huya.com page URL should be blocked",
);

// P2P streaming: actual CDN stream URLs should NOT be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://hdliplive.douyucdn.cn/live/stream.m3u8"),
  false,
  "douyucdn.cn CDN with .m3u8 should NOT be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://msstatic.com/huya/live/stream.m3u8"),
  false,
  "msstatic.com CDN with .m3u8 should NOT be blocked",
);

// Negative: dlive (not in any pattern but should work too)
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://dlive.tv/example"),
  true,
  "dlive.tv page URL should be blocked",
);

// ── Phase A.4 — STATIC_ASSET refinements ──

// AD_SDK_RE: ad SDK paths should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/vast.js"),
  true,
  "vast.js should be blocked as ad SDK",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/ad-plugin/tracker.js"),
  true,
  "ad-plugin path should be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/ad-manager/loader.js"),
  true,
  "ad-manager path should be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/admanager/init.js"),
  true,
  "admanager path should be blocked",
);

// AD_STATIC_ASSET_RE: JS/CSS from known ad domains should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://adnxs.com/assets/tracker.js"),
  true,
  "adnxs.com JS should be blocked via AD_STATIC_ASSET_RE",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://clmbtech.com/loader.css"),
  true,
  "clmbtech.com CSS should be blocked via AD_STATIC_ASSET_RE",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://chartbeat.com/ping.js"),
  true,
  "chartbeat.com JS should be blocked via AD_STATIC_ASSET_RE",
);

// Negative: non-ad-domain JS passes through (STATIC_PLAYER_ASSET_RE blocks it)
// AD_STATIC_ASSET_RE targets only ad domains; non-ad .js is still caught by STATIC_PLAYER_ASSET_RE.
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://cdn.example.com/player.js"),
  true,
  "non-ad-domain JS should still be blocked by STATIC_PLAYER_ASSET_RE",
);

// ── Phase A.5 — Video Player SDK Patterns (from video_filters.js) ──

import * as videoFilters from "../../src/shared/video_filters.js";

// Video player SDK paths should be recognized as video-related
assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://imasdk.googleapis.com/js/sdkloader/ima3.js"),
  true,
  "ima3.js should be recognized as video player SDK",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://imasdk.googleapis.com/js/sdkloader/ima3_dai.js"),
  true,
  "ima3_dai.js should be recognized as video player SDK",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://imasdk.googleapis.com/js/sdkloader/ima3_debug.js"),
  true,
  "ima3_debug.js should be recognized as video player SDK",
);

// Video analytics patterns should be recognized
assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://cbsistatic.com/comscore.streaming/metrics"),
  true,
  "comscore.streaming should be recognized as video analytics",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://src.litix.io/core/player/mux.js"),
  true,
  "mux.js should be recognized as video analytics",
);

// Video framework URLs should be recognized
assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://analytics.edgesuite.net/html5/akamaihtml5-min.js"),
  true,
  "akamaihtml5 should be recognized as video framework",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://player.ooyala.com/static/ooyala-player.min.js"),
  true,
  "ooyala should be recognized as video framework",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://p.jwpcdn.com/player/jwplayer.core.js"),
  true,
  "jwplayer should be recognized as video framework",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://cdn.brightcove.com/player/brightcove-player.min.js"),
  true,
  "brightcove should be recognized as video framework",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://cdn.kaltura.com/p/123/sp/123/player.js"),
  true,
  "kaltura should be recognized as video framework",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://cdn.shaka-player.org/shaka-player.compiled.js"),
  true,
  "shaka should be recognized as video framework",
);

// Non-video URLs should not be recognized
assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://doubleclick.net/ddm/ad.js"),
  false,
  "doubleclick ad URLs should not be recognized as video SDK",
);

assert.equal(
  videoFilters.isVideoPlayerSdkUrl("https://cdn.example.com/analytics.js"),
  false,
  "generic analytics should not be recognized as video SDK",
);

// ── Phase A.6 — P2P / Chinese Streaming Patterns ──

// Chinese streaming CDN segment URLs should be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://douyucdn.cn/stream/segment-001.ts"),
  true,
  "douyucdn.cn segment URL should be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://msstatic.com/huya/p2plib-001.m4s"),
  true,
  "msstatic.com P2P segment URL should be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://www.huya.com/front-publish/stream-sdk-lib-master/sdk.js"),
  true,
  "huya P2P SDK path should be blocked",
);

// Chinese streaming CDN stream manifest URLs should NOT be blocked
assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://hdliplive.douyucdn.cn/live/stream.m3u8"),
  false,
  "douyucdn.cn manifest .m3u8 should NOT be blocked",
);

assert.equal(
  mediaCandidates.isBlockedMediaUrl("https://msstatic.com/huya/live/playlist.m3u8"),
  false,
  "msstatic.com manifest .m3u8 should NOT be blocked",
);

console.log("filter integration tests passed");
