(function attachQwinVideoFilters(root, factory) {
  const filters = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = filters;
  }
  root.QwinVideoFilters = filters;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinVideoFilters() {
  "use strict";

  const VIDEO_EXTENSION_RE = /\.(mp4|m4v|webm|m3u8|mpd)(?:$|[?#])/i;
  const HLS_RE = /\.m3u8(?:$|[?#])/i;
  const DASH_RE = /\.mpd(?:$|[?#])/i;
  const GIF_RE = /\.(gif|gifv)(?:$|[?#])/i;
  const GIF_VIDEO_RE =
    /(?:^|[/?#._-])(?:gif|gifs|gifv|animated-gif|giphy|tenor|gifpreview|gif-preview|loop-preview)(?:[/?#._-]|$)/i;
  const SEGMENT_EXTENSION_RE = /\.(ts|m4s|cmfv|cmfa)(?:$|[?#])/i;
  const SEGMENT_NAME_RE =
    /(?:^|[/?#._-])(?:seg(?:ment)?|frag(?:ment)?|chunk|part)[._-]?\d+(?:[/?#._-]|$)/i;
  const FRAGMENTED_STREAM_CONTEXT_RE =
    /(?:^|[/?#._-])(?:hls|dash|cmaf|fmp4|m3u8|mpd|fragments?|segments?|chunks?|parts?)(?:[/?#._-]|$)/i;
  const NUMBERED_MEDIA_FRAGMENT_RE = /\/(?:\d{3,}|[a-f0-9]{12,})(?:\.(?:mp4|m4v|webm)|(?:$|[?#]))/i;
  const AD_RE =
    /(?:doubleclick|googlesyndication|googleads|imasdk|adservice|adserver|\/ads?\/|[._-]ads?[._-]|vast|vpaid|prebid|preroll|midroll|postroll|companionad|moatads|scorecardresearch|outbrain|taboola)/i;
  const CDN_HINT_RE =
    /(videoplayback|video[-_/]?cdn|\/video\/|\/videos\/|hls|dash|manifest|playlist|master\.m3u8|akamaihd|akamaized|cloudfront|mux\.com|jwplatform|brightcove|kaltura|fastly|edgekey)/i;

  function lower(value) {
    return String(value || "").toLowerCase();
  }

  function isBlockedVideoUrl(url, contentType = "") {
    const text = String(url || "");
    const type = lower(contentType);
    if (!text) {
      return true;
    }
    if (type.includes("image/gif") || GIF_RE.test(text) || GIF_VIDEO_RE.test(text)) {
      return true;
    }
    if (
      SEGMENT_EXTENSION_RE.test(text) ||
      SEGMENT_NAME_RE.test(text) ||
      (FRAGMENTED_STREAM_CONTEXT_RE.test(text) && NUMBERED_MEDIA_FRAGMENT_RE.test(text))
    ) {
      return true;
    }
    return AD_RE.test(text);
  }

  function classifyVideoUrl(url, contentType = "") {
    const text = lower(url);
    const type = lower(contentType);
    if (HLS_RE.test(text) || type.includes("mpegurl") || type.includes("x-mpegurl")) {
      return "M3U8";
    }
    if (DASH_RE.test(text) || type.includes("dash+xml")) {
      return "MPD";
    }
    if (/\.webm(?:$|[?#])/i.test(text) || type.includes("video/webm")) {
      return "WEBM";
    }
    if (/\.(mp4|m4v)(?:$|[?#])/i.test(text) || type.includes("video/mp4")) {
      return "MP4";
    }
    if (type.startsWith("video/")) {
      return type.replace("video/", "").toUpperCase();
    }
    if (text.startsWith("blob:")) {
      return "BLOB";
    }
    return "VIDEO";
  }

  function displayVideoFormat(videoOrFormat) {
    const format = lower(
      typeof videoOrFormat === "object" && videoOrFormat !== null
        ? videoOrFormat.format || ""
        : videoOrFormat
    );
    if (format === "m3u8" || format === "mpd") {
      return "MP4";
    }
    return format ? format.toUpperCase() : "VIDEO";
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (_error) {
      return false;
    }
  }

  function isDownloadableUrl(url, contentType = "") {
    return isHttpUrl(url) && !isBlockedVideoUrl(url, contentType);
  }

  function isLikelyVideoRequest(url, resourceType = "", contentType = "") {
    const type = lower(contentType);
    if (isBlockedVideoUrl(url, type)) {
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

  function isLikelyRealVideoBox(details) {
    const width = Number(details.width || 0);
    const height = Number(details.height || 0);
    const duration = Number(details.duration || 0);

    if ((width && width < 220) || (height && height < 120) || width * height < 26000) {
      return false;
    }
    if (Number.isFinite(duration) && duration > 0 && duration < 1.5) {
      return false;
    }
    if (
      Number.isFinite(duration) &&
      duration > 0 &&
      duration < 5 &&
      details.loop &&
      details.muted &&
      details.autoplay
    ) {
      return false;
    }
    return true;
  }

  function isLikelyRealVideoElement(details) {
    if (!isDownloadableUrl(details.url || "", details.contentType || "")) {
      return false;
    }
    return isLikelyRealVideoBox(details);
  }

  return {
    classifyVideoUrl,
    displayVideoFormat,
    isBlockedVideoUrl,
    isDownloadableUrl,
    isLikelyRealVideoBox,
    isLikelyRealVideoElement,
    isLikelyVideoRequest,
  };
});
