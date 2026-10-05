/**
 * The media lexicon — every regex the classifier matches on, plus the two URL facts
 * the rules ask about, plus the two shapes the rules are written against.
 *
 * Split out from `media_rules.ts` (the rule tables) and `media_candidates.ts` (the
 * functions) so each file holds one concern and stays under the repo's 400-line rule.
 * All three are re-exported from `media_candidates.ts`, which is the module everything
 * else imports.
 *
 * Nothing here makes a decision — that is the rule tables' job. These are the
 * patterns, copied verbatim from `media_candidates.js` when it still had its if/else
 * chains, plus two literals that were inline in `classifyMediaUrl`.
 *
 * Most constants are exported for `media_rules.ts` only, not as public API;
 * `media_candidates.ts` re-exports the five the background actually imports.
 */

/** A video extension or manifest — the gate for "this URL is media at all". */
export const VIDEO_EXTENSION_RE = /(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])|\.ism(?:\/Manifest)?(?:$|[?#]))/i;

/** Progressive-download container subset of {@link VIDEO_EXTENSION_RE}, re-exported for `background/video_utils.js`. */
export const DIRECT_VIDEO_EXTENSION_RE = /\.(mp4|m4v|webm)(?:$|[?#])/i;

/** Inline literals from `classifyMediaUrl`; NOT {@link VIDEO_EXTENSION_RE}, which also matches m3u8/mpd/ism. */
export const MP4_EXTENSION_RE = /\.(mp4|m4v)(?:$|[?#])/i;
export const WEBM_EXTENSION_RE = /\.webm(?:$|[?#])/i;

export const AUDIO_EXTENSION_RE = /\.(?:mp3|m4a|aac|ogg|opus|flac|wav)(?:$|[?#])/i;
export const HLS_RE = /\.m3u8(?:$|[?#])/i;
export const DASH_RE = /\.mpd(?:$|[?#])/i;
export const ISM_RE = /\.ism(?:\/Manifest)?(?:$|[?#])/i;
export const GIF_RE = /\.(gif|gifv)(?:$|[?#])/i;
export const WEB_APP_MANIFEST_RE = /(?:\.webmanifest|(?:^|[/?#._-])manifest\.(?:json|webm)(?:$|[?#]))/i;
export const STATIC_PLAYER_ASSET_RE = /\.(?:hlsjs|js|mjs|cjs|css|map)(?:$|[?#])/i;
export const STATIC_PAGE_ASSET_RE =
  /\/(?:stylesheet|theme-color|browserconfig|X-UA-Compatible|overflow-y-hidden)(?:$|[?#])/i;

// Domain-scoped static asset blocking: .js/.css from known ad/analytics domains.
// This is a refinement of STATIC_PLAYER_ASSET_RE — when that pattern is relaxed,
// this ensures ad-domain assets are still blocked.
export const AD_STATIC_ASSET_RE =
  /(?:doubleclick|googlesyndication|googleads|adservice|adserver|adnxs|clmbtech|chartbeat|scorecardresearch)\.(?:net|com)\/.*\.(?:js|css)$/i;

// Ad SDK path patterns: block player SDK files from ad SDK paths.
export const AD_SDK_RE = /(?:\/vast\.js|\/ad-plugin\/|ad-manager|admanager)\/[^/]+\.js/i;

export const MUSIC_CDN_RE = /(?:spotifycdn|audio-ak|audio-fa|audio-[\w-]+\.spotify|cadenas\.|audio-pa\.spotifycdn)/i;
export const AUDIO_ONLY_HOST_RE = /(?:audio[-.])/i;
export const GIF_VIDEO_RE =
  /(?:^|[/?#._-])(?:gif|gifs|gifv|animated-gif|giphy|tenor|gifpreview|gif-preview|loop-preview)(?:[/?#._-]|$)/i;
export const SEGMENT_EXTENSION_RE = /\.(ts|mp2t|m4s|cmfv|cmfa)(?:$|[?#])/i;
export const SEGMENT_NAME_RE = /(?:^|[/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part)[._-]?\d+(?:[/?#._-]|$)/i;
export const FRAGMENTED_STREAM_CONTEXT_RE =
  /(?:^|[/?#._-])(?:hls|dash|cmaf|fmp4|m3u8|mpd|fragments?|segments?|chunks?|parts?)(?:[/?#._-]|$)/i;
export const NUMBERED_MEDIA_FRAGMENT_RE = /\/(?:\d{3,}|[a-f0-9]{12,})(?:\.(?:mp4|m4v|webm)|(?:$|[?#]))/i;
export const AD_RE =
  /(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|\/ads?\/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola|adnxs|clmbtech|crwdcntrl|chartbeat|adobedtm|ensighten|fwmrm\.net|spotx(?:cdn)?\.(?:tv|com)|smartclip|adaptv\.advertising|2mdn\.net|youbora(?:nqs01)?\.com|popads\.net)/i;
// Streaming sites whose page URLs (no video extension) are not valid yt-dlp sources.
// They use HLS/DASH streams loaded dynamically — the page URL itself is never
// the actual download URL. Actual stream URLs from their CDNs still pass through.
export const STREAMING_PAGE_HOST_RE = /(?:^|[/.])vidfast\.pro(?:$|[/?#])/i;
export const EMBED_PLAYER_HOST_RE = /(?:^|[/.])(?:player\.hanime\.tv|vidsrc-embed\.ru|vsembed\.ru)(?:$|[/?#])/i;

// Video hosting sites whose page URLs are not real yt-dlp sources
// Actual CDN stream URLs from these sites still pass through with video extensions.
export const VIDEO_HOSTING_SITES_RE =
  /(?:^|[\/.])(?:flashx|thevideo|hdvid|vidoza|powvideo|vidtech|streamplay|fileone|beeg|khanime|playmogo|doodstream|streamtape|mixdrop|lulustream|mp4upload|vidstream|filemoon|streama2z|supervideo|streamruby|streamwish|earnvids|goodstream|filegram|savefiles|netu|oneupload|sendvid|dropload|media|darkibox)\.(?:pw|tv|to|net|pro|com|co|ag|sx|cc|one|cm)(?:$|[\/?#])/i;

// P2P streaming platforms (Chinese streaming — douyu, huya)
export const P2P_STREAMING_HOSTS_RE = /(?:^|[\/.])(?:douyu|huya)\.(?:com|cn)(?:$|[\/?#])/i;

// Streaming platforms whose page URLs are not video sources
export const LIVE_STREAMING_HOSTS_RE = /(?:^|[\/.])(?:twitch|trovo|dlive|kick)\.(?:tv|com|live)(?:$|[\/?#])/i;

// Chinese streaming P2P CDN URLs (block individual segment URLs, not the player).
export const CHINESE_STREAMING_CDN_RE = /(?:douyucdn\.cn|msstatic\.com|huya\.com\/.*p2p)/i;

// P2P SDK path used by Chinese streaming platforms.
export const CHINESE_STREAMING_P2P_RE = /\/front-publish\/stream-sdk-lib-master\//i;
// Cloudflare infra endpoints (challenge, beacon, rum) — never media.
export const CLOUDFLARE_INFRA_RE = /\/cdn-cgi(?:\/|$|[?#])/i;
export const CDN_HINT_RE =
  /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey|edgesuite|msavideo|hdliveextra|espncdn|turner\.com|cbsistatic|cbsnews|gotraffic|litix\.io|ooyala|jwpcdn|streamroot|msstatic|douyucdn|qbrick|embed-cdn|flashx|vidoza)/i;
const YOUTUBE_PAGE_PATH_RE = /^\/(?:embed|shorts|live)\/([^/?#]+)/i;
const YOUTUBE_NOCOOKIE_PATH_RE = /^\/embed\/([^/?#]+)/i;

/**
 * Content types that are never video, compared *after* stripping parameters.
 *
 * A Set, not a RegExp: the old check was `[...].includes(type.split(";", 1)[0].trim())`
 * — membership over a derived string, which a flat pattern array cannot express
 * without also matching "text/htmlfoo". Adding a mime type is still appending one
 * entry; only that one rule carries a predicate.
 */
export const BLOCKED_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/javascript",
  "application/ecmascript",
  "application/json",
  "application/x-javascript",
  "text/css",
  "text/ecmascript",
  "text/html",
  "text/javascript",
]);

/** Format names that make a candidate "playlist-like" regardless of how it was classified. */
export const PLAYLIST_LIKE_FORMATS: ReadonlySet<string> = new Set(["M3U8", "MPD", "ISM", "YOUTUBE", "PAGE"]);

/**
 * `String(value || "").toLowerCase()` — the null-safe lowercasing every matcher in
 * `shared/` expects. It had three identical private copies (`media_candidates.ts`,
 * `video_filters.ts`, `background/video_utils.ts`); it lives here because this module
 * imports nothing, so all three can reach it without a cycle.
 */
export function lower(value: unknown): string {
  return String(value || "").toLowerCase();
}

/** A finite number, or 0, for normalizing header/JSON values that may be junk. */
export function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Order a rule table by `priority` so precedence is stated in the data instead of
 * implied by the literal's line order. Stable, so entries sharing a priority keep the
 * order they were written in. Two different rule types used this verbatim.
 */
export function byPriority<T extends { priority: number }>(rules: T[]): T[] {
  return rules.sort((left, right) => left.priority - right.priority);
}

/**
 * The loose record the shared predicates read.
 *
 * Every layer builds candidates differently — DOM metrics from the content script,
 * response headers from the service worker, SSR JSON from a page config — so these
 * functions read a structural subset and ignore the rest instead of importing one
 * layer's candidate type. `contracts.ts:DetectedVideo` is the wire shape; this is
 * the part the pure helpers depend on. Numeric fields accept `string` because they
 * arrive from JSON/attribute parsing on the way in and go through `finiteNumber()`
 * anyway.
 */
export interface MediaCandidateLike {
  id?: string;
  url?: string;
  pageUrl?: string;
  frameUrl?: string;
  title?: string;
  label?: string;
  note?: string;
  format?: string;
  contentType?: string;
  source?: string;
  downloadable?: boolean;
  width?: number | string | null;
  height?: number | string | null;
  duration?: number | string | null;
  bitrate?: number | string | null;
  tbr?: number | string | null;
  size?: string;
  sizeBytes?: number | string | null;
  filesize?: number | string | null;
  filesize_approx?: number | string | null;
  fileSize?: number | string | null;
  thumbnailUrl?: string;
  firstSeen?: number | string | null;
  lastSeen?: number | string | null;
  complete?: boolean;
  partial?: boolean;
  loop?: boolean;
  muted?: boolean;
  autoplay?: boolean;
  variants?: MediaCandidateLike[];
}

/** What a rule is matched against. Case convention is per-function and load-bearing — see each caller. */
export interface MediaContext {
  /** The URL exactly as the caller received it. */
  rawUrl: string;
  /** The URL as the caller's own chain used to test it (lowercased, or raw where the patterns are `/i`). */
  text: string;
  /** Lowercased Content-Type header value. */
  type: string;
  /** `webRequest` resource type — only `isLikelyVideoRequest` reads it. */
  resourceType: string;
}

/**
 * googlevideo.com/videoplayback URLs expire per byte range, so they are never reusable.
 *
 * A rule predicate rather than a pattern: it needs a parsed URL.
 */
export function isEphemeralMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) && parsed.pathname === "/videoplayback";
  } catch (_error) {
    return false;
  }
}

/**
 * The YouTube video id a page URL points at, or "" when it is not one.
 *
 * A rule predicate for the same reason as {@link isEphemeralMediaUrl}: it needs a
 * parsed URL. `media_candidates.ts` re-exports the boolean form.
 */
export function youtubeVideoIdFromPageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (host === "youtu.be") {
      return pathParts[0] || "";
    }

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v") || "";
      }
      const pathMatch = parsed.pathname.match(YOUTUBE_PAGE_PATH_RE);
      return pathMatch ? pathMatch[1] : "";
    }

    if (host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
      const pathMatch = parsed.pathname.match(YOUTUBE_NOCOOKIE_PATH_RE);
      return pathMatch ? pathMatch[1] : "";
    }
  } catch (_error) {
    return "";
  }
  return "";
}
