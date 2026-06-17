"use strict";

const VIDEO_EXTENSION_RE = /(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:$|[?#])|\.ism(?:\/Manifest)?(?:$|[?#]))/i;
const AUDIO_EXTENSION_RE = /\.(?:mp3|m4a|aac|ogg|opus|flac|wav)(?:$|[?#])/i;
const HLS_RE = /\.m3u8(?:$|[?#])/i;
const DASH_RE = /\.mpd(?:$|[?#])/i;
const ISM_RE = /\.ism(?:\/Manifest)?(?:$|[?#])/i;
const GIF_RE = /\.(gif|gifv)(?:$|[?#])/i;
const WEB_APP_MANIFEST_RE = /(?:\.webmanifest|(?:^|[/?#._-])manifest\.json)(?:$|[?#])/i;
const STATIC_PLAYER_ASSET_RE = /\.(?:hlsjs|js|mjs|cjs|css|map)(?:$|[?#])/i;
const MUSIC_CDN_RE = /(?:spotifycdn|audio-ak|audio-fa|audio-[\w-]+\.spotify|cadenas\.|audio-pa\.spotifycdn)/i;
const AUDIO_ONLY_HOST_RE = /(?:audio[-.])/i;
const GIF_VIDEO_RE =
  /(?:^|[/?#._-])(?:gif|gifs|gifv|animated-gif|giphy|tenor|gifpreview|gif-preview|loop-preview)(?:[/?#._-]|$)/i;
const SEGMENT_EXTENSION_RE = /\.(ts|mp2t|m4s|cmfv|cmfa)(?:$|[?#])/i;
const SEGMENT_NAME_RE = /(?:^|[/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part)[._-]?\d+(?:[/?#._-]|$)/i;
const FRAGMENTED_STREAM_CONTEXT_RE =
  /(?:^|[/?#._-])(?:hls|dash|cmaf|fmp4|m3u8|mpd|fragments?|segments?|chunks?|parts?)(?:[/?#._-]|$)/i;
const NUMBERED_MEDIA_FRAGMENT_RE = /\/(?:\d{3,}|[a-f0-9]{12,})(?:\.(?:mp4|m4v|webm)|(?:$|[?#]))/i;
const AD_RE =
  /(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|\/ads?\/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola)/i;
// Streaming sites whose page URLs (no video extension) are not valid yt-dlp sources.
// They use HLS/DASH streams loaded dynamically — the page URL itself is never
// the actual download URL. Actual stream URLs from their CDNs still pass through.
const STREAMING_PAGE_HOST_RE = /(?:^|[/.])vidfast\.pro(?:$|[/?#])/i;
const EMBED_PLAYER_HOST_RE = /(?:^|[/.])player\.hanime\.tv(?:$|[/?#])/i;
const CDN_HINT_RE =
  /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey)/i;
const YOUTUBE_PAGE_PATH_RE = /^\/(?:embed|shorts|live)\/([^/?#]+)/i;

function lower(value) {
  return String(value || "").toLowerCase();
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "blob:";
  } catch (_error) {
    return false;
  }
}

function isLikelyAudioUrl(url, contentType = "") {
  const text = lower(url);
  const type = lower(contentType);
  if (AUDIO_EXTENSION_RE.test(text)) {
    return true;
  }
  if (type.startsWith("audio/")) {
    return true;
  }
  if (MUSIC_CDN_RE.test(text) || (AUDIO_ONLY_HOST_RE.test(text) && !VIDEO_EXTENSION_RE.test(text))) {
    return true;
  }
  return false;
}

function isEphemeralMediaUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) && parsed.pathname === "/videoplayback";
  } catch (_error) {
    return false;
  }
}

function youtubeVideoIdFromPageUrl(url) {
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
      const pathMatch = parsed.pathname.match(/^\/embed\/([^/?#]+)/i);
      return pathMatch ? pathMatch[1] : "";
    }
  } catch (_error) {
    return "";
  }
  return "";
}

function isYouTubeVideoPageUrl(url) {
  return Boolean(youtubeVideoIdFromPageUrl(url));
}

function normalizeYouTubeVideoPageUrl(url) {
  const videoId = youtubeVideoIdFromPageUrl(url);
  if (!videoId) {
    return "";
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith("/shorts/")) {
      return `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;
    }
    if (path.startsWith("/live/")) {
      return `https://www.youtube.com/live/${encodeURIComponent(videoId)}`;
    }
  } catch (_error) {
    // Fall through to the canonical watch URL.
  }

  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function isBlockedMediaUrl(url, contentType = "") {
  const text = String(url || "");
  const type = lower(contentType);
  if (!text) {
    return true;
  }
  if (
    [
      "application/javascript",
      "application/ecmascript",
      "application/json",
      "application/x-javascript",
      "text/css",
      "text/ecmascript",
      "text/html",
      "text/javascript",
    ].includes(type.split(";", 1)[0].trim()) ||
    type.startsWith("font/") ||
    type.startsWith("image/")
  ) {
    return true;
  }
  if (isEphemeralMediaUrl(text)) {
    return true;
  }
  if (STATIC_PLAYER_ASSET_RE.test(text)) {
    return true;
  }
  if (type.includes("manifest+json") || type.includes("webmanifest") || WEB_APP_MANIFEST_RE.test(text)) {
    return true;
  }
  if (type.includes("image/gif") || GIF_RE.test(text) || GIF_VIDEO_RE.test(text)) {
    return true;
  }
  if (
    type.includes("video/mp2t") ||
    SEGMENT_EXTENSION_RE.test(text) ||
    SEGMENT_NAME_RE.test(text) ||
    (FRAGMENTED_STREAM_CONTEXT_RE.test(text) && NUMBERED_MEDIA_FRAGMENT_RE.test(text))
  ) {
    return true;
  }
  if (EMBED_PLAYER_HOST_RE.test(text)) {
    return true;
  }
  // Block page URLs from streaming sites that aren't real download sources.
  // These sites embed HLS/DASH streams — the page URL is not a direct video URL.
  // Stream URLs from their CDNs (with actual video extensions) are still allowed.
  if (STREAMING_PAGE_HOST_RE.test(text) && !VIDEO_EXTENSION_RE.test(text) && !SEGMENT_EXTENSION_RE.test(text)) {
    return true;
  }
  return AD_RE.test(text);
}

function classifyMediaUrl(url, contentType = "") {
  const text = lower(url);
  const type = lower(contentType);
  if (isYouTubeVideoPageUrl(url)) {
    return "YOUTUBE";
  }
  if (HLS_RE.test(text) || type.includes("mpegurl") || type.includes("x-mpegurl")) {
    return "M3U8";
  }
  if (DASH_RE.test(text) || type.includes("dash+xml")) {
    return "MPD";
  }
  if (ISM_RE.test(text)) {
    return "ISM";
  }
  if (/\.webm(?:$|[?#])/i.test(text) || type.includes("video/webm")) {
    return "WEBM";
  }
  if (/\.(mp4|m4v)(?:$|[?#])/i.test(text) || type.includes("video/mp4")) {
    return "MP4";
  }
  if (isLikelyAudioUrl(url, contentType)) {
    return "AUDIO";
  }
  if (type.startsWith("video/")) {
    return type.replace("video/", "").toUpperCase();
  }
  if (text.startsWith("blob:")) {
    return "BLOB";
  }
  return "VIDEO";
}

function isPlaylistLike(details) {
  if (!details || typeof details !== "object") {
    return false;
  }
  const format = String(details.format || classifyMediaUrl(details.url || "", details.contentType || "")).toUpperCase();
  const type = lower(details.contentType);
  return (
    format === "M3U8" ||
    format === "MPD" ||
    format === "ISM" ||
    format === "YOUTUBE" ||
    format === "PAGE" ||
    HLS_RE.test(details.url || "") ||
    DASH_RE.test(details.url || "") ||
    ISM_RE.test(details.url || "") ||
    type.includes("mpegurl") ||
    type.includes("dash+xml")
  );
}

function isDownloadableMediaUrl(url, contentType = "") {
  return isHttpUrl(url) && !isBlockedMediaUrl(url, contentType);
}

function isLikelyVideoRequest(url, resourceType = "", contentType = "") {
  const type = lower(contentType);
  if (isBlockedMediaUrl(url, type)) {
    return false;
  }
  if (VIDEO_EXTENSION_RE.test(url)) {
    return true;
  }
  if (type.startsWith("video/") || type.includes("mpegurl") || type.includes("dash+xml")) {
    return true;
  }
  return resourceType === "media" && CDN_HINT_RE.test(url);
}

const DIRECT_VIDEO_EXTENSION_RE = /\.(mp4|m4v|webm)(?:$|[?#])/i;

export {
  classifyMediaUrl,
  isBlockedMediaUrl,
  isDownloadableMediaUrl,
  isEphemeralMediaUrl,
  isHttpUrl,
  isLikelyAudioUrl,
  isLikelyVideoRequest,
  isPlaylistLike,
  isYouTubeVideoPageUrl,
  normalizeYouTubeVideoPageUrl,
  youtubeVideoIdFromPageUrl,
  // Exported regex constants for use by other modules (background.js, tests)
  // to avoid duplicating pattern definitions.
  VIDEO_EXTENSION_RE,
  HLS_RE,
  DASH_RE,
  CDN_HINT_RE,
  SEGMENT_EXTENSION_RE,
  DIRECT_VIDEO_EXTENSION_RE,
};
