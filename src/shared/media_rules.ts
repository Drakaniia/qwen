/**
 * The media rule tables and the one matcher that reads them (spec D4: "same —
 * data-driven pattern list").
 *
 * Adding a blocked host, a format, or a playlist shape is appending one entry to one
 * of the arrays below; no function's control flow is edited. The five arrays mirror
 * the five if/else chains `media_candidates.js` used to have, in the same order, with
 * every regex copied verbatim from `media_patterns.ts`:
 *
 *   - {@link MEDIA_BLOCK_RULES}      ← `isBlockedMediaUrl`'s chain
 *   - {@link MEDIA_CLASSIFY_RULES}   ← `classifyMediaUrl`'s chain (`id` is the label it returns)
 *   - {@link AUDIO_URL_RULES}         ← `isLikelyAudioUrl`'s chain
 *   - {@link PLAYLIST_LIKE_RULES}     ← the tail of `isPlaylistLike` (its head is a format-name Set)
 *   - {@link VIDEO_REQUEST_RULES}     ← `isLikelyVideoRequest`'s chain, minus its blocked check
 *
 * Two escape hatches exist because a flat `RegExp` field cannot express what those
 * branches actually did, and both are documented on {@link MediaRule}: `when` for an
 * alternative that is a call rather than a pattern, `require` for a guard ANDed onto
 * the alternatives ("match this pattern, but only when the URL is not already media").
 */

import {
  AD_RE,
  AD_SDK_RE,
  AD_STATIC_ASSET_RE,
  AUDIO_EXTENSION_RE,
  AUDIO_ONLY_HOST_RE,
  BLOCKED_MIME_TYPES,
  byPriority,
  CDN_HINT_RE,
  CHINESE_STREAMING_CDN_RE,
  CHINESE_STREAMING_P2P_RE,
  CLOUDFLARE_INFRA_RE,
  DASH_RE,
  EMBED_PLAYER_HOST_RE,
  FRAGMENTED_STREAM_CONTEXT_RE,
  GIF_RE,
  GIF_VIDEO_RE,
  HLS_RE,
  isEphemeralMediaUrl,
  ISM_RE,
  LIVE_STREAMING_HOSTS_RE,
  MP4_EXTENSION_RE,
  MUSIC_CDN_RE,
  NUMBERED_MEDIA_FRAGMENT_RE,
  P2P_STREAMING_HOSTS_RE,
  SEGMENT_EXTENSION_RE,
  SEGMENT_NAME_RE,
  STATIC_PAGE_ASSET_RE,
  STATIC_PLAYER_ASSET_RE,
  STREAMING_PAGE_HOST_RE,
  VIDEO_EXTENSION_RE,
  VIDEO_HOSTING_SITES_RE,
  WEB_APP_MANIFEST_RE,
  WEBM_EXTENSION_RE,
  youtubeVideoIdFromPageUrl,
  type MediaContext,
} from "./media_patterns.js";

export type { MediaCandidateLike, MediaContext } from "./media_patterns.js";

/**
 * One entry in a rule array.
 *
 * The three `…`/pattern fields are **alternatives** — a rule matches if any of them
 * does (that is how the old chains read: `A || B || C`). {@link MediaRule.require}
 * is a **guard** — it is ANDed on top, and exists because several branches were
 * "match this pattern, but only when the URL is not already media". Keeping the two
 * kinds apart is what lets the tables reproduce the old precedence exactly; folding
 * them into one field would block every page URL on every host.
 */
export interface MediaRule {
  /**
   * Diagnostic label; in {@link MEDIA_CLASSIFY_RULES} this is the format string it
   * returns. A function is only used by the single rule whose label is derived from
   * the match (a `video/<subtype>` Content-Type), resolved by {@link resolveMediaRuleId}.
   */
  readonly id: string | ((context: MediaContext) => string);
  readonly category: "video" | "playlist" | "audio" | "blocked";
  /** Lower runs first. Array order is the match order — {@link byPriority} makes that explicit in the data. */
  readonly priority: number;
  /** Alternative 1: matched against {@link MediaContext.text}. */
  readonly urlPattern?: RegExp;
  /**
   * Alternative 2: matched against {@link MediaContext.type} only. Deliberately not
   * folded into one `pattern` tested against "URL or type" — every original branch
   * named which string it looked at, and a merged test matches cases that previously
   * did not (a URL starting `video/` hitting the Content-Type rule, say).
   */
  readonly typePattern?: RegExp;
  /** Alternative 3: for the branches that are a call rather than a pattern. */
  readonly when?: (context: MediaContext) => boolean;
  /** Guard, ANDed with the alternatives — a negation the alternatives cannot carry. */
  readonly require?: (context: MediaContext) => boolean;
}

/**
 * The generic matcher — the whole of the "classification" logic. Nothing in
 * `media_candidates.ts` knows what any individual rule means.
 */
export function matchesMediaRule(rule: MediaRule, context: MediaContext): boolean {
  const matched =
    (rule.urlPattern ? rule.urlPattern.test(context.text) : false) ||
    (rule.typePattern ? rule.typePattern.test(context.type) : false) ||
    (rule.when ? rule.when(context) : false);
  return matched && (!rule.require || rule.require(context));
}

/** First matching rule, or `undefined`. */
export function findMediaRule(rules: readonly MediaRule[], context: MediaContext): MediaRule | undefined {
  return rules.find((rule) => matchesMediaRule(rule, context));
}

/** The label a rule contributes, resolving the one derived-label rule. */
export function resolveMediaRuleId(rule: MediaRule, context: MediaContext): string {
  return typeof rule.id === "function" ? rule.id(context) : rule.id;
}

/** Page URLs from these hosts are never yt-dlp sources; their CDN stream URLs (which carry a video extension) pass. */
function isPageUrlNotMedia(context: MediaContext): boolean {
  return !VIDEO_EXTENSION_RE.test(context.text) && !SEGMENT_EXTENSION_RE.test(context.text);
}

/**
 * `isBlockedMediaUrl`'s chain, in its original order.
 *
 * The old code returned `true` from inside each `if`; here the first matching entry
 * *is* the answer. `priority` values are the chain position, and the table is ordered
 * by them so precedence is stated in the data rather than implied by line order.
 */
export const MEDIA_BLOCK_RULES: MediaRule[] = byPriority([
  {
    id: "non-media-content-type",
    category: "blocked",
    priority: 10,
    when: (context) =>
      BLOCKED_MIME_TYPES.has(context.type.split(";", 1)[0].trim()) ||
      context.type.startsWith("font/") ||
      context.type.startsWith("image/"),
  },
  {
    id: "ephemeral-googlevideo",
    category: "blocked",
    priority: 20,
    when: (context) => isEphemeralMediaUrl(context.text),
  },
  { id: "player-asset", category: "blocked", priority: 30, urlPattern: STATIC_PLAYER_ASSET_RE },
  { id: "ad-sdk-path", category: "blocked", priority: 40, urlPattern: AD_SDK_RE },
  { id: "static-page-asset", category: "blocked", priority: 50, urlPattern: STATIC_PAGE_ASSET_RE },
  // Redundant with `player-asset` today, but it keeps ad-domain JS/CSS blocked if
  // that pattern is ever relaxed.
  { id: "ad-domain-static-asset", category: "blocked", priority: 60, urlPattern: AD_STATIC_ASSET_RE },
  { id: "cloudflare-infra", category: "blocked", priority: 65, urlPattern: CLOUDFLARE_INFRA_RE },
  {
    id: "web-app-manifest",
    category: "blocked",
    priority: 70,
    urlPattern: WEB_APP_MANIFEST_RE,
    typePattern: /manifest\+json|webmanifest/i,
  },
  {
    id: "gif",
    category: "blocked",
    priority: 80,
    urlPattern: GIF_RE,
    typePattern: /image\/gif/i,
    when: (context) => GIF_VIDEO_RE.test(context.text),
  },
  {
    id: "media-segment",
    category: "blocked",
    priority: 90,
    urlPattern: SEGMENT_EXTENSION_RE,
    typePattern: /video\/mp2t/i,
    when: (context) =>
      SEGMENT_NAME_RE.test(context.text) ||
      // A numbered fragment inside an HLS/DASH context is a segment — unless the URL
      // is itself the manifest, which is the one thing we want to keep.
      (FRAGMENTED_STREAM_CONTEXT_RE.test(context.text) &&
        NUMBERED_MEDIA_FRAGMENT_RE.test(context.text) &&
        !HLS_RE.test(context.text) &&
        !DASH_RE.test(context.text)),
  },
  { id: "embed-player-host", category: "blocked", priority: 100, urlPattern: EMBED_PLAYER_HOST_RE },
  // Streaming sites that embed HLS/DASH streams: the page URL is not a direct video
  // URL, but stream URLs from their CDNs (with a video extension) still pass.
  {
    id: "streaming-page-host",
    category: "blocked",
    priority: 110,
    urlPattern: STREAMING_PAGE_HOST_RE,
    require: isPageUrlNotMedia,
  },
  {
    id: "video-hosting-site",
    category: "blocked",
    priority: 120,
    urlPattern: VIDEO_HOSTING_SITES_RE,
    require: isPageUrlNotMedia,
  },
  {
    id: "p2p-streaming-host",
    category: "blocked",
    priority: 130,
    urlPattern: P2P_STREAMING_HOSTS_RE,
    require: isPageUrlNotMedia,
  },
  {
    id: "live-streaming-host",
    category: "blocked",
    priority: 140,
    urlPattern: LIVE_STREAMING_HOSTS_RE,
    require: isPageUrlNotMedia,
  },
  {
    // Block segment/P2P URLs, allow manifests.
    id: "chinese-streaming-cdn",
    category: "blocked",
    priority: 150,
    urlPattern: CHINESE_STREAMING_CDN_RE,
    require: (context) => !VIDEO_EXTENSION_RE.test(context.text) || SEGMENT_EXTENSION_RE.test(context.text),
  },
  { id: "chinese-streaming-p2p-sdk", category: "blocked", priority: 160, urlPattern: CHINESE_STREAMING_P2P_RE },
  { id: "ad-network", category: "blocked", priority: 170, urlPattern: AD_RE },
]);

/**
 * `classifyMediaUrl`'s chain, in its original order. `id` is the format string the
 * function returns — unchanged casing, because `displayVideoFormat`,
 * `video_sorting.formatPriority` and the background's yt-dlp format lookup all
 * compare these labels as-is.
 *
 * The `video/*` Content-Type entry is the one rule whose label is derived from the
 * match (the subtype, uppercased) rather than fixed, so its `id` is a function.
 */
export const MEDIA_CLASSIFY_RULES: MediaRule[] = byPriority([
  {
    id: "YOUTUBE",
    category: "playlist",
    priority: 10,
    when: (context) => Boolean(youtubeVideoIdFromPageUrl(context.rawUrl)),
  },
  { id: "M3U8", category: "playlist", priority: 20, urlPattern: HLS_RE, typePattern: /mpegurl|x-mpegurl/i },
  { id: "MPD", category: "playlist", priority: 30, urlPattern: DASH_RE, typePattern: /dash\+xml/i },
  { id: "ISM", category: "playlist", priority: 40, urlPattern: ISM_RE },
  { id: "WEBM", category: "video", priority: 50, urlPattern: WEBM_EXTENSION_RE, typePattern: /video\/webm/i },
  { id: "MP4", category: "video", priority: 60, urlPattern: MP4_EXTENSION_RE, typePattern: /video\/mp4/i },
  // Reuses the audio table through the same matcher rather than repeating it.
  {
    id: "AUDIO",
    category: "audio",
    priority: 70,
    when: (context) => Boolean(findMediaRule(AUDIO_URL_RULES, context)),
  },
  {
    id: (context) => context.type.replace("video/", "").toUpperCase(),
    category: "video",
    priority: 80,
    typePattern: /^video\//i,
  },
  { id: "BLOB", category: "video", priority: 90, urlPattern: /^blob:/i },
]);

/** `isLikelyAudioUrl`'s chain. The last entry is the "audio host, but not a video URL" guard. */
export const AUDIO_URL_RULES: MediaRule[] = byPriority([
  { id: "audio-extension", category: "audio", priority: 10, urlPattern: AUDIO_EXTENSION_RE },
  { id: "audio-content-type", category: "audio", priority: 20, typePattern: /^audio\//i },
  { id: "music-cdn", category: "audio", priority: 30, urlPattern: MUSIC_CDN_RE },
  {
    id: "audio-only-host",
    category: "audio",
    priority: 40,
    when: (context) => AUDIO_ONLY_HOST_RE.test(context.text) && !VIDEO_EXTENSION_RE.test(context.text),
  },
]);

/** The URL/Content-Type half of `isPlaylistLike`; its other half is `PLAYLIST_LIKE_FORMATS`. */
export const PLAYLIST_LIKE_RULES: MediaRule[] = byPriority([
  { id: "hls", category: "playlist", priority: 10, urlPattern: HLS_RE },
  { id: "dash", category: "playlist", priority: 20, urlPattern: DASH_RE },
  { id: "ism", category: "playlist", priority: 30, urlPattern: ISM_RE },
  { id: "hls-content-type", category: "playlist", priority: 40, typePattern: /mpegurl/i },
  { id: "dash-content-type", category: "playlist", priority: 50, typePattern: /dash\+xml/i },
]);

/**
 * `isLikelyVideoRequest`'s chain, minus its blocked check — that one is a call, not
 * a pattern, so it stays in the function.
 */
export const VIDEO_REQUEST_RULES: MediaRule[] = byPriority([
  { id: "video-extension", category: "video", priority: 10, urlPattern: VIDEO_EXTENSION_RE },
  { id: "media-content-type", category: "video", priority: 20, typePattern: /^video\/|mpegurl|dash\+xml/i },
  {
    id: "media-resource-cdn",
    category: "video",
    priority: 30,
    urlPattern: CDN_HINT_RE,
    require: (context) => context.resourceType === "media",
  },
]);
