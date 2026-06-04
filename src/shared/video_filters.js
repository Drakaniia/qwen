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
  const SHORT_OR_PREVIEW_RE =
    /(?:^|[/?#._\s-])(?:shorts?|clips?|previews?|teasers?|trailers?|highlights?|snippets?|promos?|thumbs?|thumbnails?|stories|reels|loop-preview)(?:[/?#._\s-]|$)/i;
  const INCOMPLETE_RE =
    /(?:^|[/?#._\s-])(?:partial|incomplete|fragment|fragments|segment|segments|chunk|chunks|part|parts)(?:[/?#._\s-]|\d|$)/i;
  const RESOLUTION_RE = /(?:^|[^\d])([1-9]\d{2,3})p(?:[^\d]|$)/i;
  const DIMENSION_RE = /(?:^|[^\d])([1-9]\d{2,4})x([1-9]\d{2,4})(?:[^\d]|$)/i;
  const MBPS_RE = /(?:^|[^\d])(\d+(?:\.\d+)?)\s?mbps(?:[^\d]|$)/i;
  const KBPS_RE = /(?:^|[^\d])(\d{3,6})\s?kbps?(?:[^\d]|$)/i;
  const QUALITY_WORD_RE =
    /\b(?:144|240|360|480|540|576|720|900|1080|1440|2160|4320)p\b|\b(?:8k|4k|uhd|qhd|fhd|hd|sd|low|medium|high|best|source|copy)\b/gi;
  const FORMAT_WORD_RE = /\b(?:mp4|m4v|webm|m3u8|mpd|hls|dash)\b/gi;
  const GENERIC_STEM_RE = /^(?:|video|videos|media|movie|file|download|master|playlist|index|manifest|stream)$/i;
  const MIN_FULL_LENGTH_SECONDS = 30;

  function lower(value) {
    return String(value || "").toLowerCase();
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function textForVideoSignals(details) {
    if (!details || typeof details !== "object") {
      return String(details || "");
    }
    return [
      details.url,
      details.title,
      details.label,
      details.note,
      details.source,
      details.contentType,
    ]
      .filter(Boolean)
      .join(" ");
  }

  function hasShortOrIncompleteSignal(details) {
    const text = textForVideoSignals(details);
    return SHORT_OR_PREVIEW_RE.test(text) || INCOMPLETE_RE.test(text);
  }

  function isPlaylistLike(details) {
    if (!details || typeof details !== "object") {
      return false;
    }
    const format = String(details.format || classifyVideoUrl(details.url || "", details.contentType || "")).toUpperCase();
    const type = lower(details.contentType);
    return (
      format === "M3U8" ||
      format === "MPD" ||
      HLS_RE.test(details.url || "") ||
      DASH_RE.test(details.url || "") ||
      type.includes("mpegurl") ||
      type.includes("dash+xml")
    );
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

  function humanSize(numBytes) {
    const size = finiteNumber(numBytes);
    if (size <= 0) {
      return "";
    }

    let value = size;
    for (const unit of ["B", "KB", "MB", "GB"]) {
      if (value < 1024 || unit === "GB") {
        return unit === "B" ? `${Math.round(value)} B` : `${value.toFixed(1)} ${unit}`;
      }
      value /= 1024;
    }
    return "";
  }

  function numericVideoSize(value) {
    if (!value || typeof value !== "object") {
      return 0;
    }
    if (isPlaylistLike(value)) {
      return 0;
    }
    return (
      finiteNumber(value.sizeBytes) ||
      finiteNumber(value.filesize) ||
      finiteNumber(value.filesize_approx) ||
      finiteNumber(value.fileSize) ||
      0
    );
  }

  function displayVideoSize(videoOrFormat) {
    if (!videoOrFormat || typeof videoOrFormat !== "object") {
      return "";
    }

    if (typeof videoOrFormat.size === "string" && videoOrFormat.size.trim()) {
      return videoOrFormat.size.trim();
    }

    const directSize = numericVideoSize(videoOrFormat);
    if (directSize > 0) {
      return humanSize(directSize);
    }

    const variants = Array.isArray(videoOrFormat.variants) ? videoOrFormat.variants : [];
    let largestSize = 0;
    let fallbackLabel = "";
    for (const variant of variants) {
      largestSize = Math.max(largestSize, numericVideoSize(variant));
      if (!fallbackLabel && variant && typeof variant.size === "string" && variant.size.trim()) {
        fallbackLabel = variant.size.trim();
      }
    }
    return largestSize > 0 ? humanSize(largestSize) : fallbackLabel;
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

  function isLikelyFullLengthVideoCandidate(details) {
    if (!details || typeof details !== "object") {
      return false;
    }

    if (!isDownloadableUrl(details.url || "", details.contentType || "")) {
      return false;
    }

    if (details.downloadable === false) {
      return false;
    }

    if (hasShortOrIncompleteSignal(details)) {
      return false;
    }

    const duration = finiteNumber(details.duration);
    if (duration > 0 && duration < MIN_FULL_LENGTH_SECONDS) {
      return false;
    }

    if (details.complete === false || details.partial === true) {
      return false;
    }

    return true;
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
    if (!isLikelyFullLengthVideoCandidate(details)) {
      return false;
    }
    return isLikelyRealVideoBox(details);
  }

  function normalizeComparableUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return String(url || "").split("#", 1)[0];
    }
  }

  function normalizeIdentityText(value) {
    return lower(value)
      .replace(/\.(?:mp4|m4v|webm|m3u8|mpd)$/i, " ")
      .replace(/\b\d{3,4}x\d{3,4}\b/g, " ")
      .replace(QUALITY_WORD_RE, " ")
      .replace(FORMAT_WORD_RE, " ")
      .replace(/\b(?:v|version|quality|format|rendition|variant|stream)\d+\b/g, " ")
      .replace(/[_+.,()[\]{}]+/g, " ")
      .replace(/[-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTitleKey(value) {
    return normalizeIdentityText(value)
      .replace(/\b(?:watch|online|video)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeVideoStem(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const last = decodeURIComponent(parts.pop() || parsed.hostname || "");
      return normalizeIdentityText(last);
    } catch (_error) {
      const clean = String(url || "").split(/[?#]/, 1)[0].split(/[\\/]/).pop();
      return normalizeIdentityText(clean || "");
    }
  }

  function normalizePageKey(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      return parsed.href.toLowerCase();
    } catch (_error) {
      return lower(url).split("#", 1)[0].split("?", 1)[0];
    }
  }

  function isGenericStem(stem) {
    return GENERIC_STEM_RE.test(stem || "");
  }

  function videoIdentityParts(video) {
    const stemKey = normalizeVideoStem(video.url || "");
    return {
      urlKey: normalizeComparableUrl(video.url || ""),
      pageKey: normalizePageKey(video.pageUrl || video.frameUrl || ""),
      titleKey: normalizeTitleKey(video.title || ""),
      stemKey,
      genericStem: isGenericStem(stemKey),
    };
  }

  function isSameFullVideo(left, right) {
    const leftParts = videoIdentityParts(left);
    const rightParts = videoIdentityParts(right);

    if (leftParts.urlKey && leftParts.urlKey === rightParts.urlKey) {
      return true;
    }

    if (!leftParts.pageKey || leftParts.pageKey !== rightParts.pageKey) {
      return false;
    }

    if (leftParts.stemKey && rightParts.stemKey && leftParts.stemKey === rightParts.stemKey) {
      return true;
    }

    if (!leftParts.titleKey || leftParts.titleKey !== rightParts.titleKey) {
      return false;
    }

    return (
      !leftParts.stemKey ||
      !rightParts.stemKey ||
      leftParts.genericStem ||
      rightParts.genericStem ||
      leftParts.stemKey === rightParts.stemKey
    );
  }

  function inferResolutionFromText(value) {
    const text = String(value || "");
    const dimensions = text.match(DIMENSION_RE);
    if (dimensions) {
      return {
        width: Number(dimensions[1]) || 0,
        height: Number(dimensions[2]) || 0,
      };
    }

    const resolution = text.match(RESOLUTION_RE);
    if (resolution) {
      return { width: 0, height: Number(resolution[1]) || 0 };
    }

    return { width: 0, height: 0 };
  }

  function inferBitrateFromText(value) {
    const text = String(value || "");
    const mbps = text.match(MBPS_RE);
    if (mbps) {
      return Math.round(Number(mbps[1]) * 1000);
    }

    const kbps = text.match(KBPS_RE);
    if (kbps) {
      return Number(kbps[1]) || 0;
    }

    return 0;
  }

  function enrichVideoVariant(video) {
    const signalText = textForVideoSignals(video);
    const inferredResolution = inferResolutionFromText(signalText);
    const inferredBitrate = inferBitrateFromText(signalText);
    const width = finiteNumber(video.width) || inferredResolution.width || 0;
    const height = finiteNumber(video.height) || inferredResolution.height || 0;
    const bitrate = finiteNumber(video.bitrate || video.tbr) || inferredBitrate || 0;
    const format = video.format || classifyVideoUrl(video.url || "", video.contentType || "");

    return {
      ...video,
      format,
      width: width || null,
      height: height || null,
      bitrate: bitrate || null,
      tbr: finiteNumber(video.tbr) || bitrate || null,
      downloadable:
        video.downloadable === false ? false : isDownloadableUrl(video.url || "", video.contentType || ""),
    };
  }

  function formatPriority(format) {
    const value = String(format || "").toUpperCase();
    if (value === "MP4") {
      return 4;
    }
    if (value === "M3U8" || value === "MPD") {
      return 3;
    }
    if (value === "WEBM") {
      return 2;
    }
    return 1;
  }

  function fullVideoPriority(video) {
    if (isPlaylistLike(video)) {
      return 1;
    }
    const variants = Array.isArray(video && video.variants) ? video.variants : [];
    return variants.some(isPlaylistLike) ? 1 : 0;
  }

  function variantSortKey(video) {
    return [
      video.downloadable ? 1 : 0,
      fullVideoPriority(video),
      numericVideoSize(video),
      finiteNumber(video.height),
      finiteNumber(video.tbr || video.bitrate),
      formatPriority(video.format),
      finiteNumber(video.lastSeen),
    ];
  }

  function compareVariants(left, right) {
    const leftKey = variantSortKey(left);
    const rightKey = variantSortKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) {
        return rightKey[index] - leftKey[index];
      }
    }
    return 0;
  }

  function mergeVariant(existing, next) {
    return {
      ...existing,
      ...next,
      thumbnailUrl: next.thumbnailUrl || existing.thumbnailUrl || "",
      firstSeen: existing.firstSeen || next.firstSeen,
      lastSeen: Math.max(finiteNumber(existing.lastSeen), finiteNumber(next.lastSeen)),
    };
  }

  function groupedVideoSortKey(video) {
    return [
      video.downloadable ? 1 : 0,
      fullVideoPriority(video),
      numericVideoSize(video),
      finiteNumber(video.height),
      finiteNumber(video.tbr || video.bitrate),
      finiteNumber(video.duration),
      finiteNumber(video.lastSeen),
    ];
  }

  function compareGroupedVideos(left, right) {
    const leftKey = groupedVideoSortKey(left);
    const rightKey = groupedVideoSortKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) {
        return rightKey[index] - leftKey[index];
      }
    }
    return 0;
  }

  function buildGroupedVideo(group) {
    const variants = group.variants
      .map(enrichVideoVariant)
      .sort(compareVariants);
    const representative = variants[0] || group.seed;
    const firstSeenValues = variants.map((variant) => finiteNumber(variant.firstSeen)).filter(Boolean);
    const lastSeenValues = variants.map((variant) => finiteNumber(variant.lastSeen));
    const largestSizeBytes = Math.max(...variants.map(numericVideoSize), 0);
    const thumbnailVariant = variants.find((variant) => variant.thumbnailUrl);
    return {
      ...representative,
      id: group.id,
      variants,
      variantCount: variants.length,
      downloadable: variants.some((variant) => variant.downloadable),
      size: representative.size || (largestSizeBytes > 0 ? humanSize(largestSizeBytes) : ""),
      sizeBytes: numericVideoSize(representative) || largestSizeBytes || null,
      thumbnailUrl: representative.thumbnailUrl || thumbnailVariant?.thumbnailUrl || "",
      firstSeen: firstSeenValues.length ? Math.min(...firstSeenValues) : representative.firstSeen || 0,
      lastSeen: lastSeenValues.length ? Math.max(...lastSeenValues) : representative.lastSeen || 0,
    };
  }

  function groupUniqueFullVideos(videos) {
    const groups = [];

    for (const rawVideo of Array.isArray(videos) ? videos : []) {
      if (!isLikelyFullLengthVideoCandidate(rawVideo)) {
        continue;
      }

      const video = enrichVideoVariant(rawVideo);
      let group = groups.find((item) => item.variants.some((variant) => isSameFullVideo(variant, video)));
      if (!group) {
        group = {
          id: video.id || normalizeComparableUrl(video.url || ""),
          seed: video,
          variants: [],
        };
        groups.push(group);
      }

      const existingIndex = group.variants.findIndex(
        (variant) => normalizeComparableUrl(variant.url || "") === normalizeComparableUrl(video.url || "")
      );
      if (existingIndex >= 0) {
        group.variants[existingIndex] = mergeVariant(group.variants[existingIndex], video);
      } else {
        group.variants.push(video);
      }
    }

    return groups
      .map(buildGroupedVideo)
      .sort(compareGroupedVideos);
  }

  return {
    classifyVideoUrl,
    displayVideoFormat,
    displayVideoSize,
    groupUniqueFullVideos,
    humanSize,
    isBlockedVideoUrl,
    isDownloadableUrl,
    isLikelyFullLengthVideoCandidate,
    isLikelyRealVideoBox,
    isLikelyRealVideoElement,
    isLikelyVideoRequest,
    isSameFullVideo,
  };
});
