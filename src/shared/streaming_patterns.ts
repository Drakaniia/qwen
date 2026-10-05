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
 *
 * Every pattern below is one entry in one of three tables (spec D4), so adding a
 * platform is appending a row: `STREAMING_PATTERNS` for detection,
 * `STREAMING_CLASSIFY_RULES` for the yt-dlp format hint, `TEXT_EXTRACTION_RULES`
 * for the text scanner.
 */

/** One detectable streaming signature. */
export interface StreamingPattern {
  /** Platform or signal name — diagnostics only; nothing branches on it today. */
  readonly id: string;
  readonly pattern: RegExp;
  /**
   * `known` = a platform/CDN we recognize outright (`isStreamingUrl`);
   * `structural` = a shape that suggests video delivery without naming a platform
   * (signed URLs, segment numbering, generic CDN hostnames — `isLikelyStreamingUrl`).
   *
   * `isLikelyStreamingUrl` matches both kinds, which is why the structural entries
   * can live in this one table instead of a second hand-written if/else chain.
   */
  readonly kind: "known" | "structural";
}

/** Known streaming host/CDN signatures and structural signals, verbatim from the old constants. */
export const STREAMING_PATTERNS: StreamingPattern[] = [
  // Known streaming host/CDN signatures found in video delivery URLs.
  {
    id: "streaming-host",
    kind: "structural",
    pattern:
      /\b(?:stream(?:ing|play|tape|ruby|wish|a2z|sb)?|hls|dash|cdn|media[-\d]*|manifest|playlist|m3u8|mpd|video[-\d]*|vod|live|edge[-\w]*|akamai|cloudfront|fastly|cloudflare|jwp(?:cdn|layer)?|brightcove|kaltura|ooyala|bitmovin|theoplayer|shaka|jwplatform|mux\.com|uplynk|wistia|vimeo(?:cdn)?|dailymotion|twitch|kick|trovo|dlive|douyu|huya)(?:\.|\b)/i,
  },
  // List-based video platform config URLs (API endpoints that return video data).
  {
    id: "video-config-api",
    kind: "structural",
    pattern:
      /\/video\/(\d+)\/config(?:\?|$)|^\/(?:api|get)_video_info|\/player\/|\.googlevideo\.com\/|\/videoplayback\//i,
  },
  // Token/signed URL patterns — indicator of CDN-protected video delivery.
  {
    id: "signed-stream",
    kind: "structural",
    pattern:
      /[?&](?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id|X-Amz-Expires|AWSAccessKeyId|hmac|auth_key|secure|wmsAuthSign|token_key|session|jwt|bearer)=/i,
  },
  // Fragment/chunk naming patterns used by HLS/DASH segment URLs.
  {
    id: "fragment-name",
    kind: "structural",
    pattern:
      /(?:^|[\/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part|init)[._-]?\d*(?:\.(?:ts|m4s|m4v|m4a|cmfv|cmfa|mp4))?(?:[?#]|$)/i,
  },
  // Sequential numeric patterns in paths — HLS/DASH segment indicator.
  {
    id: "sequential-segment",
    kind: "structural",
    pattern: /\/(?:\d{3,}|[a-f0-9]{12,})(?:\.(?:ts|m4s|mp4|m4v|webm)|(?:\?|$))/i,
  },
  // Vietnamese streaming CDN patterns (from Coc Coc's isSpecialUrls).
  {
    id: "vn-streaming-cdn",
    kind: "known",
    pattern:
      /(?:hls\.mediacdn\.vn|hls\.tuoitre\.vn|vdrm\.vtvgiaitri\.vn|nixcdn\.com|vcmedia\.vn|kenhhd\.tv|vnecdn\.net|vhw\.vnecdn\.net|stream\.vltv\.xyz)/i,
  },
  // Vietnamese streaming URL patterns with non-standard extensions.
  {
    id: "vn-streaming-url",
    kind: "known",
    pattern: /(?:https?:)?\/\/hls\.(?:mediacdn|tuoitre)\.vn\/.+\/\S+\.mp4\.json|vdrm\.vtvgiaitri\.vn\/stream/i,
  },
  // SoundCloud API media endpoint pattern.
  {
    id: "soundcloud-media",
    kind: "known",
    pattern: /api(?:-v[0-9]+)?\.soundcloud\.com\/media\/soundcloud:tracks:[0-9]+/i,
  },
  // ZingMP3 API endpoint pattern.
  { id: "zingmp3-api", kind: "known", pattern: /zingmp3\.vn\/api\/v2\/.+\?id=/i },
  // StreamSB playlist pattern.
  { id: "streamsb-playlist", kind: "known", pattern: /streamsb\.biz\/playlist\/json\/[a-z0-9]+\/[a-z0-9]+/i },
  // SSPlay streaming pattern.
  {
    id: "ssplay-stream",
    kind: "known",
    pattern: /ssplay\.net\/[a-z0-9]{2,4}\/(?:\d+\/\d+\/[a-z0-9]+\/[a-z0-9]+|[a-z\d]+\/[a-z\d]+)/i,
  },
  // Discord attachment video URLs.
  {
    id: "discord-video",
    kind: "known",
    pattern: /discord(?:app)?\.com\/attachments\/\d+\/\d+\/[a-z0-9_\- ]+\.(?:mp4|webm|mov|m4v)/i,
  },
  // MyCDN (Vietnamese video hosting) pattern.
  { id: "mycdn-video", kind: "known", pattern: /vkvd\d*\.mycdn\.me/i },
  // Douyu (Chinese streaming) API pattern.
  { id: "douyu-stream", kind: "known", pattern: /v\.douyu\.com\/api\/stream\/getStreamUrl/i },
  // Cuoiia (Vietnamese streaming) HLS pattern.
  { id: "cuoiia-hls", kind: "known", pattern: /cam-hls.*\.cuoiia\.top\/cdn/i },
  // Bongngo / Manga123 / StreamAsia playlist patterns.
  {
    id: "streamasia-playlist",
    kind: "known",
    pattern: /(?:streamasia|bongngo|manga123)\.(?:net|com|xyz)[\s\S]*\/playlist\//i,
  },
  // IamPlayer manifest pattern.
  { id: "iamplayer-manifest", kind: "known", pattern: /iamplayer\.xyz\/stream.*\/Manifest/i },
  // Khophim18 m3u8 pattern.
  { id: "khophim-m3u8", kind: "known", pattern: /khophim18\.net\/m3u8/i },
  // Apix Googlevideo player (YouTube fallback).
  { id: "apix-googlevideo", kind: "known", pattern: /apix\.gooqlevideo\.com\/player/i },
  // Nimblesessionid pattern (HLS with mp4+ts segments).
  { id: "nimblesessionid", kind: "known", pattern: /\.mp4.+?\.ts\?nimblesessionid=/i },
  // Meo.saku player pattern.
  { id: "meo-saku", kind: "known", pattern: /meo\.saku\.net\/player/i },
  // Sequence-based HLS patterns (/sequence/play/...).
  { id: "sequence-playlist", kind: "known", pattern: /^\/sequence\/(?:play|full)\/[a-z0-9]+/i },
  // Generic key-based encryption pattern in URLs.
  { id: "key-encryption", kind: "known", pattern: /key[0-9]=[0-9a-f]{32}/i },
  // Play sex3x API iframe pattern.
  { id: "playsex3x-api", kind: "known", pattern: /api-iframe-post\.playsex3x\.xyz\/api\/playiframe/i },
  // Facebook video/tahoe endpoint patterns.
  { id: "facebook-video", kind: "known", pattern: /www\.facebook\.com\/(?:video\/tahoe\/async|api\/graphql)/i },
  // Instagram media API pattern.
  { id: "instagram-media", kind: "known", pattern: /i\.instagram\.com\/api\/v1\/media/i },
  // NhacCuaTui flash XML pattern.
  { id: "nhaccuatui-xml", kind: "known", pattern: /www\.nhaccuatui\.com\/flash\/xml\?key3/i },
  // Uplynk content pattern.
  { id: "uplynk-stream", kind: "known", pattern: /content-aapm1\.uplynk\.com/i },
  // PlayerX HLS master pattern.
  { id: "playerx-stream", kind: "known", pattern: /master2?-eu\.playerx\.stream/i },
  // IMACDN pattern.
  { id: "imacdn", kind: "known", pattern: /s\d+\.imacdn\.com/i },
  // Hydra streaming pattern.
  { id: "hydra-stream", kind: "known", pattern: /hydra/i },
  // Googlevideo (YouTube) direct stream pattern.
  { id: "googlevideo-stream", kind: "known", pattern: /get\.gooqlevideo\.com\/player/i },
  // VTVCab streaming pattern (Vietnamese TV).
  { id: "vtvcab-stream", kind: "known", pattern: /vtvgiaitri\.vn/i },
];

/** The generic matcher: does the URL match any pattern of this kind? */
function matchesAny(patterns: readonly StreamingPattern[], kind: StreamingPattern["kind"], url: string): boolean {
  return patterns.some((entry) => entry.kind === kind && entry.pattern.test(url));
}

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
 */
export function isStreamingUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  return matchesAny(STREAMING_PATTERNS, "known", url);
}

/**
 * Check if the URL has a structure suggestive of video streaming even without
 * a standard extension — signed URLs, CDN hostnames, manifest patterns, etc.
 *
 * This is a broader check than isStreamingUrl() — it looks for structural
 * clues in the URL rather than known platform patterns, so it matches both
 * kinds in {@link STREAMING_PATTERNS}.
 */
export function isLikelyStreamingUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  return STREAMING_PATTERNS.some((entry) => entry.pattern.test(url));
}

/** What {@link classifyStreamingUrl} decides for a URL. */
export interface StreamingClassification {
  type: "manifest" | "direct" | "streaming" | "unknown";
  /** The format string to suggest to yt-dlp. */
  format: string;
  /** True when matched by pattern-based detection rather than by extension/type. */
  isStreaming: boolean;
}

/** One step of {@link classifyStreamingUrl}'s chain, in the order it is tried. */
interface StreamingClassifyRule {
  readonly id: string;
  readonly type: StreamingClassification["type"];
  /** Fixed label, or a function for the one step that re-derives it from the URL. */
  readonly format: string | ((lowerUrl: string, lowerType: string) => string);
  readonly typePattern?: RegExp;
  readonly urlPattern?: RegExp;
  /** For the last step, which asks the pattern tables rather than a pattern. */
  readonly when?: (url: string) => boolean;
  readonly isStreaming?: boolean;
}

/**
 * Coc Coc's classification chain: Content-Type first (its primary method), then
 * file extension, then pattern-based detection. Every `return` in the old if/else
 * chain is one row here; the first match wins.
 */
const STREAMING_CLASSIFY_RULES: StreamingClassifyRule[] = [
  { id: "hls-content-type", type: "manifest", format: "M3U8", typePattern: /(?:x-mpegurl|appl\.mpegurl|mpegurl)/i },
  { id: "dash-content-type", type: "manifest", format: "MPD", typePattern: /dash\+xml/i },
  {
    id: "media-content-type",
    type: "direct",
    format: (lowerUrl, lowerType) => classifyByExtension(lowerUrl, lowerType),
    typePattern: /^(?:video|audio)\//i,
  },
  { id: "hls-extension", type: "manifest", format: "M3U8", urlPattern: /\.m3u8(?:\?|$)/i },
  { id: "dash-extension", type: "manifest", format: "MPD", urlPattern: /\.mpd(?:\?|$)/i },
  { id: "video-extension", type: "direct", format: "MP4", urlPattern: /\.(?:mp4|m4v|webm)(?:\?|$)/i },
  {
    id: "streaming-pattern",
    type: "streaming",
    // Coc Coc's key innovation: pattern-based streaming URL detection. One call,
    // because `isLikelyStreamingUrl` matches the `known` patterns too.
    format: "M3U8", // Treat as HLS — yt-dlp figures out the rest
    when: (url) => isLikelyStreamingUrl(url),
    isStreaming: true,
  },
];

/**
 * Classify a URL/content-type pair into the best format for yt-dlp.
 *
 * Coc Coc's approach: if a URL matches a known streaming pattern, treat it
 * as m3u8 (HLS) regardless of extension. This ensures yt-dlp gets a hint
 * about how to process the URL.
 */
export function classifyStreamingUrl(url: string, contentType = ""): StreamingClassification {
  const result: StreamingClassification = {
    type: "unknown",
    format: "",
    isStreaming: false,
  };

  if (!url || typeof url !== "string") return result;

  const lowerUrl = url.toLowerCase();
  const lowerType = contentType.toLowerCase().trim();

  const rule = STREAMING_CLASSIFY_RULES.find((entry) => {
    if (entry.when) {
      return entry.when(url);
    }
    return Boolean(
      (entry.urlPattern && entry.urlPattern.test(lowerUrl)) || (entry.typePattern && entry.typePattern.test(lowerType)),
    );
  });

  if (!rule) {
    return result;
  }

  result.type = rule.type;
  result.format = typeof rule.format === "function" ? rule.format(lowerUrl, lowerType) : rule.format;
  result.isStreaming = Boolean(rule.isStreaming);
  return result;
}

/** Content-Type wins over the extension, because a manifest served as `video/mp4` is still a manifest. */
const EXTENSION_TYPE_RULES: readonly { format: string; pattern: RegExp }[] = [
  { format: "M3U8", pattern: /(?:mpegurl|x-mpegurl)/ },
  { format: "MPD", pattern: /dash\+xml/ },
  { format: "MP4", pattern: /mp4/ },
  { format: "WEBM", pattern: /webm/ },
  { format: "FLV", pattern: /x-flv/ },
];

const EXTENSION_URL_RULES: readonly { format: string; pattern: RegExp }[] = [
  { format: "M3U8", pattern: /\.m3u8(?:\?|$)/ },
  { format: "MPD", pattern: /\.mpd(?:\?|$)/ },
  { format: "MP4", pattern: /\.mp4(?:\?|$)/ },
  { format: "WEBM", pattern: /\.webm(?:\?|$)/ },
  { format: "MP4", pattern: /\.m4v(?:\?|$)/ },
  { format: "FLV", pattern: /\.flv(?:\?|$)/ },
];

/** Determine format from file extension (fallback when no content-type). */
function classifyByExtension(lowerUrl: string, lowerType: string): string {
  const byType = EXTENSION_TYPE_RULES.find((rule) => rule.pattern.test(lowerType));
  if (byType) {
    return byType.format;
  }
  const byUrl = EXTENSION_URL_RULES.find((rule) => rule.pattern.test(lowerUrl));
  return byUrl ? byUrl.format : "VIDEO";
}

/** One scanner in {@link extractStreamingUrlsFromText}, in scan order. */
interface TextExtractionRule {
  readonly id: string;
  /** Reported on every hit — how the URL was recognized. */
  readonly confidence: string;
  readonly pattern: RegExp;
  /** Capture group holding the URL; defaults to the whole match. */
  readonly group?: number;
  /** Extra gate — the config-object scanner only keeps media-looking URLs. */
  readonly accept?: (url: string) => boolean;
  /**
   * Skip a URL an earlier scanner already reported. Defaults to true; the first
   * scanner opts out, because its loop pushed every match unconditionally in the
   * code this table replaced and a caller may be counting occurrences.
   */
  readonly dedupe?: boolean;
}

/**
 * The five scanners Coc Coc's content script runs over inline scripts and configs.
 *
 * Order is the contract: the extension scanner runs first so its hits claim the
 * `extension` label, and the CDN/host scanners only add what is not already found.
 */
const TEXT_EXTRACTION_RULES: readonly TextExtractionRule[] = [
  {
    id: "media-extension",
    confidence: "extension",
    // Standard media URLs with video extensions
    pattern: /(?:(?:https?:)?\/\/)[^"'`<>\s)]+?(?:\.(?:mp4|m4v|webm|m3u8|mpd|flv|avi|mov|mkv)(?:[?#][^"'`<>\s)]*)?)/gi,
    dedupe: false,
  },
  {
    id: "media-cdn-extension",
    confidence: "manifest",
    // URLs containing streaming CDN hostnames
    pattern: /(?:(?:https?:)?\/\/)[^"'`<>\s)]+?(?:\.(?:m3u8|mpd|ts|m4s)(?:[?#][^"'`<>\s)]*)?)/gi,
  },
  {
    id: "cdn-hostname",
    confidence: "cdn",
    // URLs that match streaming CDN host patterns
    pattern:
      /(?:(?:https?:)?\/\/)[^"'`<>\s)]*?(?:cloudfront|akamaihd|akamaized|cloudflare|fastly|edgekey|edgesuite|stream(?:ing|play|tape|ruby|wish|a2z)?|cdn[-\d]*|jwp(?:cdn|layer)?|brightcove|kaltura|mux\.com|uplynk)[^"'`<>\s)]*/gi,
  },
  {
    id: "player-config",
    confidence: "config",
    // Player config objects with 'file', 'src', 'url' containing video URLs
    pattern: /(?:file|src|url|video|source)\s*[:=]\s*["']((?:https?:)?\/\/[^"']+?)["']/gi,
    group: 1,
    // Only include if it looks like a media URL
    accept: (url) =>
      /\.(?:mp4|m4v|webm|m3u8|mpd|flv|avi|mov|mkv|ts)/i.test(url) || isStreamingUrl(url) || isLikelyStreamingUrl(url),
  },
  {
    id: "signed-url",
    confidence: "signed",
    // URLs with signed/token parameters (indicates CDN delivery)
    pattern:
      /((?:https?:)?\/\/[^"'`<>\s)]+?(?:expires?|e|exp|se|st|token|signature|sig|Policy|Key-Pair-Id)[^"'`<>\s)]*)/gi,
    group: 1,
  },
];

/** One URL the text scanner pulled out, and how it was recognized. */
export interface ExtractedStreamingUrl {
  url: string;
  confidence: string;
}

/**
 * Extract potential video URLs from text content (scripts, configs, responses).
 *
 * Coc Coc's content script scans inline scripts for media URLs embedded
 * in player config objects, JSON payloads, and variable assignments.
 * This goes beyond simple file-extension regex to find streaming CDN URLs.
 */
export function extractStreamingUrlsFromText(text: string): ExtractedStreamingUrl[] {
  const results: ExtractedStreamingUrl[] = [];
  if (!text || typeof text !== "string") return results;

  for (const rule of TEXT_EXTRACTION_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const url = rule.group ? match[rule.group] : match[0];
      const accepted = !rule.accept || rule.accept(url);
      const seen = rule.dedupe === false ? false : results.some((found) => found.url === url);
      if (accepted && !seen) {
        results.push({ url, confidence: rule.confidence });
      }
    }
  }

  return results;
}

/** URLs from CDNs that typically block content-script requests. */
const CORS_RESTRICTED_HOST_PATTERNS: readonly RegExp[] = [
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

/**
 * Determine if a URL likely needs to be fetched via the background
 * service worker (CORS proxy).
 *
 * Coc Coc uses this approach: when the content script cannot fetch a URL
 * due to CORS restrictions, it sends a message to the background page
 * which performs the fetch and returns the result.
 */
export function needsBackgroundProxy(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  return CORS_RESTRICTED_HOST_PATTERNS.some((pattern) => pattern.test(url));
}
