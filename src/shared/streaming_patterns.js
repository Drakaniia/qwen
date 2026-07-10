"use strict";

/**
 * Smart URL Extractor — Streaming Pattern Library
 *
 * Inspired by Coc Coc Browser's "Savior" extension approach.
 *
 * Coc Coc detects video URLs by scanning ALL network responses for media
 * Content-Type headers and matching URLs against an extensive library of
 * streaming CDN patterns — including URLs that don't have obvious file
 * extensions like .mp4 or .m3u8.
 *
 * This module provides:
 *   1. A comprehensive URL pattern library for streaming CDNs and platforms
 *   2. Content-Type analysis helpers (treat any response with media content-type
 *      as a potential video source)
 *   3. URL classification: detect if a URL is a manifest, segment, direct video,
 *      or streaming CDN endpoint without relying solely on file extensions
 *   4. CORS proxy signalling: mark URLs that need background-worker fetch
 *
 * Used by:
 *   - background_webrequest.js — broad onHeadersReceived scanning
 *   - content.js / page_detection.js — inline script and config scanning
 *   - media_candidates.js — enhanced URL classification
 */

// ─── Streaming CDN URL Patterns ─────────────────────────────────────────
//
// These patterns detect streaming video URLs that DON'T have a standard
// video file extension (.mp4, .m3u8, etc.). Many CDNs serve video through
// token-authenticated or obfuscated URLs. Matching these patterns allows
// the extension to flag them as video candidates and send them to yt-dlp.

/** Known streaming host/CDN signatures found in video delivery URLs. */
const STREAMING_HOST_RE =
  /\b(?:stream(?:ing|play|tape|ruby|wish|a2z|sb)?|hls|dash|cdn|media[-\d]*|manifest|playlist|m3u8|mpd|video[-\d]*|vod|live|edge[-\w]*|akamai|cloudfront|fastly|cloudflare|jwp(?:cdn|layer)?|brightcove|kaltura|ooyala|bitmovin|theoplayer|shaka|jwplatform|mux\.com|uplynk|wistia|vimeo(?:cdn)?|dailymotion|twitch|kick|trovo|dlive|douyu|huya)(?:\.|\b)/i;

/** List-based video platform config URLs (API endpoints that return video data). */
const VIDEO_CONFIG_API_RE =
  /\/video\/(\d+)\/config(?:\?|$)|^\/(?:api|get)_video_info|\/player\/|\.googlevideo\.com\/|\/videoplayback\//i;

/** Token/signed URL patterns — indicator of CDN-protected video delivery. */
const SIGNED_STREAM_RE =
  /[?&](?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id|X-Amz-Expires|AWSAccessKeyId|hmac|auth_key|secure|wmsAuthSign|token_key|session|jwt|bearer)=/i;

/** Fragment/chunk naming patterns used by HLS/DASH segment URLs. */
const FRAGMENT_PATTERN_RE =
  /(?:^|[\/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part|init)[._-]?\d*(?:\.(?:ts|m4s|m4v|m4a|cmfv|cmfa|mp4))?(?:[?#]|$)/i;

/** Sequential numeric patterns in paths — HLS/DASH segment indicator. */
const SEQUENTIAL_SEGMENT_RE =
  /\/(?:\d{3,}|[a-f0-9]{12,})(?:\.(?:ts|m4s|mp4|m4v|webm)|(?:\?|$))/i;

/** Vietnamese streaming CDN patterns (from Coc Coc's isSpecialUrls). */
const VN_STREAMING_CDN_RE =
  /(?:hls\.mediacdn\.vn|hls\.tuoitre\.vn|vdrm\.vtvgiaitri\.vn|nixcdn\.com|vcmedia\.vn|kenhhd\.tv|vnecdn\.net|vhw\.vnecdn\.net|stream\.vltv\.xyz)/i;

/** Vietnamese streaming URL patterns with non-standard extensions. */
const VN_STREAMING_URL_RE =
  /(?:https?:)?\/\/hls\.(?:mediacdn|tuoitre)\.vn\/.+\/\S+\.mp4\.json|vdrm\.vtvgiaitri\.vn\/stream/i;

/** SoundCloud API media endpoint pattern. */
const SOUNDCLOUD_MEDIA_RE =
  /api(?:-v[0-9]+)?\.soundcloud\.com\/media\/soundcloud:tracks:[0-9]+/i;

/** ZingMP3 API endpoint pattern. */
const ZINGMP3_API_RE =
  /zingmp3\.vn\/api\/v2\/.+\?id=/i;

/** StreamSB playlist pattern. */
const STREAMSB_PLAYLIST_RE =
  /streamsb\.biz\/playlist\/json\/[a-z0-9]+\/[a-z0-9]+/i;

/** SSPlay streaming pattern. */
const SSPLAY_STREAM_RE =
  /ssplay\.net\/[a-z0-9]{2,4}\/(?:\d+\/\d+\/[a-z0-9]+\/[a-z0-9]+|[a-z\d]+\/[a-z\d]+)/i;

/** Discord attachment video URLs. */
const DISCORD_VIDEO_RE =
  /discord(?:app)?\.com\/attachments\/\d+\/\d+\/[a-z0-9_\- ]+\.(?:mp4|webm|mov|m4v)/i;

/** MyCDN (Vietnamese video hosting) pattern. */
const MYCDN_VIDEO_RE =
  /vkvd\d*\.mycdn\.me/i;

/** Douyu (Chinese streaming) API pattern. */
const DOUYU_STREAM_RE =
  /v\.douyu\.com\/api\/stream\/getStreamUrl/i;

/** Cuoiia (Vietnamese streaming) HLS pattern. */
const CUOIIA_HLS_RE =
  /cam-hls.*\.cuoiia\.top\/cdn/i;

/** Bongngo / Manga123 / StreamAsia playlist patterns. */
const STREAMASIA_PLAYLIST_RE =
  /(?:streamasia|bongngo|manga123)\.(?:net|com|xyz)[\s\S]*\/playlist\//i;

/** IamPlayer manifest pattern. */
const IAMPLAYER_MANIFEST_RE =
  /iamplayer\.xyz\/stream.*\/Manifest/i;

/** Khophim18 m3u8 pattern. */
const KHOPHIM_M3U8_RE =
  /khophim18\.net\/m3u8/i;

/** Apix Googlevideo player (YouTube fallback). */
const APIX_GOOGLEVIDEO_RE =
  /apix\.gooqlevideo\.com\/player/i;

/** Nimblesessionid pattern (HLS with mp4+ts segments). */
const NIMBLESESSIONID_RE =
  /\.mp4.+?\.ts\?nimblesessionid=/i;

/** Meo.saku player pattern. */
const MEO_SAKU_RE =
  /meo\.saku\.net\/player/i;

/** Sequence-based HLS patterns (/sequence/play/...). */
const SEQUENCE_PLAYLIST_RE =
  /^\/sequence\/(?:play|full)\/[a-z0-9]+/i;

/** Generic key-based encryption pattern in URLs. */
const KEY_ENCRYPTION_RE =
  /key[0-9]=[0-9a-f]{32}/i;

/** Play sex3x API iframe pattern. */
const PLAYSEX3X_API_RE =
  /api-iframe-post\.playsex3x\.xyz\/api\/playiframe/i;

/** Facebook video/tahoe endpoint patterns. */
const FACEBOOK_VIDEO_RE =
  /www\.facebook\.com\/(?:video\/tahoe\/async|api\/graphql)/i;

/** Instagram media API pattern. */
const INSTAGRAM_MEDIA_RE =
  /i\.instagram\.com\/api\/v1\/media/i;

/** NhacCuaTui flash XML pattern. */
const NHACCUATUI_XML_RE =
  /www\.nhaccuatui\.com\/flash\/xml\?key3/i;

/** Uplynk content pattern. */
const UPLYNK_STREAM_RE =
  /content-aapm1\.uplynk\.com/i;

/** PlayerX HLS master pattern. */
const PLAYERX_STREAM_RE =
  /master2?-eu\.playerx\.stream/i;

/** IMACDN pattern. */
const IMACDN_RE =
  /s\d+\.imacdn\.com/i;

/** Hydra streaming pattern. */
const HYDRA_STREAM_RE =
  /hydra/i;

/** Googlevideo (YouTube) direct stream pattern. */
const GOOGLEVIDEO_STREAM_RE =
  /get\.gooqlevideo\.com\/player/i;

/** VTVCab streaming pattern (Vietnamese TV). */
const VTVCAB_STREAM_RE =
  /vtvgiaitri\.vn/i;

// ─── Combined URL check: true if URL matches any streaming CDN pattern ──

const ALL_STREAMING_PATTERNS = [
  VN_STREAMING_CDN_RE,
  VN_STREAMING_URL_RE,
  SOUNDCLOUD_MEDIA_RE,
  ZINGMP3_API_RE,
  STREAMSB_PLAYLIST_RE,
  SSPLAY_STREAM_RE,
  DISCORD_VIDEO_RE,
  MYCDN_VIDEO_RE,
  DOUYU_STREAM_RE,
  CUOIIA_HLS_RE,
  STREAMASIA_PLAYLIST_RE,
  IAMPLAYER_MANIFEST_RE,
  KHOPHIM_M3U8_RE,
  APIX_GOOGLEVIDEO_RE,
  NIMBLESESSIONID_RE,
  MEO_SAKU_RE,
  SEQUENCE_PLAYLIST_RE,
  KEY_ENCRYPTION_RE,
  PLAYSEX3X_API_RE,
  FACEBOOK_VIDEO_RE,
  INSTAGRAM_MEDIA_RE,
  NHACCUATUI_XML_RE,
  UPLYNK_STREAM_RE,
  PLAYERX_STREAM_RE,
  IMACDN_RE,
  HYDRA_STREAM_RE,
  GOOGLEVIDEO_STREAM_RE,
  VTVCAB_STREAM_RE,
];

/**
 * Check if a URL matches any known streaming CDN pattern.
 *
 * Unlike standard extension-based detection (.mp4, .m3u8), this function
 * identifies video URLs that use non-standard paths (API endpoints,
 * token-authenticated CDNs, platform-specific delivery URLs).
 *
 * When this returns true, the URL should be treated as an HLS/DASH stream
 * and sent to yt-dlp for download regardless of its file extension.
 *
 * This is the core of Coc Coc's approach — pattern-based detection
 * catches videos that extension-based filtering misses.
 *
 * @param {string} url - The URL to check
 * @returns {boolean} true if the URL matches a known streaming pattern
 */
function isStreamingUrl(url) {
  if (!url || typeof url !== "string") return false;
  return ALL_STREAMING_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Check if the URL has a structure suggestive of video streaming even without
 * a standard extension — signed URLs, CDN hostnames, manifest patterns, etc.
 *
 * This is a broader check than isStreamingUrl() — it looks for structural
 * clues in the URL rather than known platform patterns.
 *
 * @param {string} url - The URL to check
 * @returns {boolean} true if the URL looks like a video stream
 */
function isLikelyStreamingUrl(url) {
  if (!url || typeof url !== "string") return false;

  // Fast path: known streaming patterns
  if (isStreamingUrl(url)) return true;

  // Content delivery signatures
  if (SIGNED_STREAM_RE.test(url)) return true;

  // HLS/DASH context clues
  if (FRAGMENT_PATTERN_RE.test(url)) return true;
  if (SEQUENTIAL_SEGMENT_RE.test(url)) return true;

  // Video config API endpoints
  if (VIDEO_CONFIG_API_RE.test(url)) return true;

  // Known streaming hosts
  if (STREAMING_HOST_RE.test(url)) return true;

  return false;
}

/**
 * Classify a URL/content-type pair into the best format for yt-dlp.
 *
 * Coc Coc's approach: if a URL matches a known streaming pattern, treat it
 * as m3u8 (HLS) regardless of extension. This ensures yt-dlp gets a hint
 * about how to process the URL.
 *
 * @param {string} url - The URL to classify
 * @param {string} contentType - The Content-Type header value (if available)
 * @returns {{type: string, format: string, isStreaming: boolean}}
 *   type: "manifest" | "direct" | "streaming" | "unknown"
 *   format: the suggested format string for yt-dlp
 *   isStreaming: true if matched by pattern-based detection
 */
function classifyStreamingUrl(url, contentType = "") {
  const result = {
    type: "unknown",
    format: "",
    isStreaming: false,
  };

  if (!url || typeof url !== "string") return result;

  const lowerUrl = url.toLowerCase();
  const lowerType = contentType.toLowerCase().trim();

  // Content-Type based detection (Coc Coc's primary method)
  if (
    lowerType.includes("mpegurl") ||
    lowerType.includes("x-mpegurl") ||
    lowerType.includes("appl.mpegurl")
  ) {
    result.type = "manifest";
    result.format = "M3U8";
    return result;
  }

  if (lowerType.includes("dash+xml")) {
    result.type = "manifest";
    result.format = "MPD";
    return result;
  }

  if (lowerType.startsWith("video/") || lowerType.startsWith("audio/")) {
    result.type = "direct";
    result.format = classifyByExtension(lowerUrl, lowerType);
    return result;
  }

  // File extension based detection
  if (/\.m3u8(?:\?|$)/i.test(lowerUrl)) {
    result.type = "manifest";
    result.format = "M3U8";
    return result;
  }

  if (/\.mpd(?:\?|$)/i.test(lowerUrl)) {
    result.type = "manifest";
    result.format = "MPD";
    return result;
  }

  if (/\.(?:mp4|m4v|webm)(?:\?|$)/i.test(lowerUrl)) {
    result.type = "direct";
    result.format = "MP4";
    return result;
  }

  // Coc Coc's key innovation: pattern-based streaming URL detection
  if (isStreamingUrl(url)) {
    result.type = "streaming";
    result.format = "M3U8";   // Treat as HLS — yt-dlp figures out the rest
    result.isStreaming = true;
    return result;
  }

  // Broader streaming structure detection
  if (isLikelyStreamingUrl(url)) {
    result.type = "streaming";
    result.format = "M3U8";
    result.isStreaming = true;
    return result;
  }

  return result;
}

/**
 * Determine format from file extension (fallback when no content-type).
 * @param {string} lowerUrl - Lowercased URL
 * @param {string} lowerType - Lowercased content-type
 * @returns {string} Format string
 */
function classifyByExtension(lowerUrl, lowerType) {
  // Content-Type takes priority
  if (lowerType.includes("mpegurl") || lowerType.includes("x-mpegurl")) return "M3U8";
  if (lowerType.includes("dash+xml")) return "MPD";
  if (lowerType.includes("/mp4")) return "MP4";
  if (lowerType.includes("/webm")) return "WEBM";
  if (lowerType.includes("/x-flv")) return "FLV";

  // Extension-based fallback
  if (/\.m3u8(?:\?|$)/.test(lowerUrl)) return "M3U8";
  if (/\.mpd(?:\?|$)/.test(lowerUrl)) return "MPD";
  if (/\.mp4(?:\?|$)/.test(lowerUrl)) return "MP4";
  if (/\.webm(?:\?|$)/.test(lowerUrl)) return "WEBM";
  if (/\.m4v(?:\?|$)/.test(lowerUrl)) return "MP4";
  if (/\.flv(?:\?|$)/.test(lowerUrl)) return "FLV";

  return "VIDEO";
}

/**
 * Extract potential video URLs from text content (scripts, configs, responses).
 *
 * Coc Coc's content script scans inline scripts for media URLs embedded
 * in player config objects, JSON payloads, and variable assignments.
 * This goes beyond simple file-extension regex to find streaming CDN URLs.
 *
 * @param {string} text - The text to scan
 * @returns {Array<{url: string, confidence: string}>}
 */
function extractStreamingUrlsFromText(text) {
  const results = [];
  if (!text || typeof text !== "string") return results;

  // Pattern 1: Standard media URLs with video extensions
  const mediaUrlRe =
    /(?:(?:https?:)?\/\/)[^"'`<>\s)]+?(?:\.(?:mp4|m4v|webm|m3u8|mpd|flv|avi|mov|mkv)(?:[?#][^"'`<>\s)]*)?)/gi;
  for (const match of text.matchAll(mediaUrlRe)) {
    results.push({ url: match[0], confidence: "extension" });
  }

  // Pattern 2: URLs containing streaming CDN hostnames
  const cdnUrlRe =
    /(?:(?:https?:)?\/\/)[^"'`<>\s)]+?(?:\.(?:m3u8|mpd|ts|m4s)(?:[?#][^"'`<>\s)]*)?)/gi;
  for (const match of text.matchAll(cdnUrlRe)) {
    // Avoid duplicates with pattern 1
    const url = match[0];
    if (!results.some((r) => r.url === url)) {
      results.push({ url, confidence: "manifest" });
    }
  }

  // Pattern 3: URLs that match streaming CDN host patterns
  const streamingHostRe =
    /(?:(?:https?:)?\/\/)[^"'`<>\s)]*?(?:cloudfront|akamaihd|akamaized|cloudflare|fastly|edgekey|edgesuite|stream(?:ing|play|tape|ruby|wish|a2z)?|cdn[-\d]*|jwp(?:cdn|layer)?|brightcove|kaltura|mux\.com|uplynk)[^"'`<>\s)]*/gi;
  for (const match of text.matchAll(streamingHostRe)) {
    const url = match[0];
    if (!results.some((r) => r.url === url)) {
      results.push({ url, confidence: "cdn" });
    }
  }

  // Pattern 4: Player config objects with 'file', 'src', 'url' containing video URLs
  const configUrlRe =
    /(?:file|src|url|video|source)\s*[:=]\s*["']((?:https?:)?\/\/[^"']+?)["']/gi;
  for (const match of text.matchAll(configUrlRe)) {
    const url = match[1];
    // Only include if it looks like a media URL
    if (
      /\.(?:mp4|m4v|webm|m3u8|mpd|flv|avi|mov|mkv|ts)/i.test(url) ||
      isStreamingUrl(url) ||
      isLikelyStreamingUrl(url)
    ) {
      if (!results.some((r) => r.url === url)) {
        results.push({ url, confidence: "config" });
      }
    }
  }

  // Pattern 5: URLs with signed/token parameters (indicates CDN delivery)
  const signedUrlRe =
    /((?:https?:)?\/\/[^"'`<>\s)]+?(?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id)[^"'`<>\s)]*)/gi;
  for (const match of text.matchAll(signedUrlRe)) {
    const url = match[1];
    if (!results.some((r) => r.url === url)) {
      results.push({ url, confidence: "signed" });
    }
  }

  return results;
}

/**
 * Determine if a URL likely needs to be fetched via the background
 * service worker (CORS proxy).
 *
 * Coc Coc uses this approach: when the content script cannot fetch a URL
 * due to CORS restrictions, it sends a message to the background page
 * which performs the fetch and returns the result.
 *
 * @param {string} url - The URL to check
 * @returns {boolean} true if the URL likely requires background proxy fetch
 */
function needsBackgroundProxy(url) {
  if (!url || typeof url !== "string") return false;

  // URLs from CDNs that typically block content-script requests
  const corsRestrictedHosts = [
    /\.googlevideo\.com/i,
    /\.akamaihd\.net/i,
    /\.akamaized\.net/i,
    /\.cloudfront\.net/i,
    /\.fastly\.net/i,
    /\.edgesuite\.net/i,
    /\.edgekey\.net/i,
    /\.cloudflare\.com\/.*stream/i,
    /\.mux\.com/i,
    /\.jwplatform\.com/i,
    /\.brightcove\.com/i,
    /\.kaltura\.com/i,
    /\.uplynk\.com/i,
    /\.wistia\.com/i,
    /nixcdn\.com/i,
    /vcmedia\.vn/i,
    /mediacdn\.vn/i,
  ];

  return corsRestrictedHosts.some((pattern) => pattern.test(url));
}

export {
  // Pattern classification
  isStreamingUrl,
  isLikelyStreamingUrl,
  classifyStreamingUrl,
  needsBackgroundProxy,

  // Text extraction
  extractStreamingUrlsFromText,

  // Individual pattern exports (for testing/customization)
  STREAMING_HOST_RE,
  VIDEO_CONFIG_API_RE,
  SIGNED_STREAM_RE,
  VN_STREAMING_CDN_RE,
  SOUNDCLOUD_MEDIA_RE,
  GOOGLEVIDEO_STREAM_RE,
  FACEBOOK_VIDEO_RE,
  DISCORD_VIDEO_RE,

  // All patterns combined
  ALL_STREAMING_PATTERNS,
};
