(function attachQwinVideoFilters(root, factory) {
  const filters = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = filters;
  }
  root.QwinVideoFilters = filters;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinVideoFilters() {
  "use strict";

  const mediaCandidates =
    (typeof globalThis !== "undefined" && globalThis.QwinMediaCandidates) ||
    (typeof require === "function" ? require("./media_candidates.js") : null);
  if (!mediaCandidates) {
    throw new Error("QwinMediaCandidates must be loaded before QwinVideoFilters.");
  }

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
  const GENERIC_WORDS = [
    "video",
    "videos",
    "media",
    "movie",
    "file",
    "download",
    "master",
    "playlist",
    "index",
    "manifest",
    "stream",
    "site",
    "player",
    "page",
    "home",
    "tab",
    "window",
    "link",
    "none",
    "undefined",
    "null",
    "advertisement",
    "ad",
    "content",
    "container",
    "wrapper",
    "box",
    "watch",
    "online",
    "view",
    "play",
    "playing",
    "browsing",
    "searching",
  ];
  const GENERIC_STEM_RE = new RegExp(`^(?:${GENERIC_WORDS.join("|")})(?:\\s+(?:${GENERIC_WORDS.join("|")}))*$`, "i");
  const GENERIC_TITLE_RE = new RegExp(
    `^(?:video|video player|media player|html5 video|player|none|undefined|null|advertisement|ad|movie|${GENERIC_WORDS.join("|")})$`,
    "i",
  );
  const MIN_FULL_LENGTH_SECONDS = 30;
  const MIN_DIRECT_MEDIA_BYTES = 1024;

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
    return [details.url, details.title, details.label, details.note, details.source, details.contentType]
      .filter(Boolean)
      .join(" ");
  }

  function hasShortOrIncompleteSignal(details) {
    const text = textForVideoSignals(details);
    return SHORT_OR_PREVIEW_RE.test(text) || INCOMPLETE_RE.test(text);
  }

  function isPlaylistLike(details) {
    return mediaCandidates.isPlaylistLike(details);
  }

  function isBlockedVideoUrl(url, contentType = "") {
    return mediaCandidates.isBlockedMediaUrl(url, contentType);
  }

  function classifyVideoUrl(url, contentType = "") {
    return mediaCandidates.classifyMediaUrl(url, contentType);
  }

  function displayVideoFormat(videoOrFormat) {
    const format = lower(
      typeof videoOrFormat === "object" && videoOrFormat !== null ? videoOrFormat.format || "" : videoOrFormat,
    );
    if (format === "audio") {
      return "AUDIO";
    }
    if (format === "m3u8" || format === "mpd" || format === "ism") {
      return "MP4";
    }
    if (format === "youtube") {
      return "MP4";
    }
    if (format === "page") {
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

  function isYouTubeVideoPageUrl(url) {
    return mediaCandidates.isYouTubeVideoPageUrl(url);
  }

  function normalizeYouTubeVideoPageUrl(url) {
    return mediaCandidates.normalizeYouTubeVideoPageUrl(url);
  }

  function isDownloadableUrl(url, contentType = "") {
    return mediaCandidates.isDownloadableMediaUrl(url, contentType);
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

    if (details.source === "manual-url") {
      return true;
    }

    const youtubePage = isYouTubeVideoPageUrl(details.url || "");
    const isDomSource =
      details.source === "dom-video" ||
      details.source === "dom-source" ||
      details.source === "page-fallback" ||
      details.source === "youtube-page";

    if (!youtubePage && !isDomSource && hasShortOrIncompleteSignal(details)) {
      return false;
    }

    const duration = finiteNumber(details.duration);
    if (!youtubePage && duration > 0 && duration < MIN_FULL_LENGTH_SECONDS) {
      return false;
    }

    if (details.source === "performance" && duration === 0) {
      return false;
    }

    const directSize = numericVideoSize(details);
    if (directSize > 0 && directSize < MIN_DIRECT_MEDIA_BYTES) {
      return false;
    }

    if (details.complete === false || details.partial === true) {
      return false;
    }

    return true;
  }

  function isLikelyVideoRequest(url, resourceType = "", contentType = "") {
    return mediaCandidates.isLikelyVideoRequest(url, resourceType, contentType);
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
      const clean = String(url || "")
        .split(/[?#]/, 1)[0]
        .split(/[\\/]/)
        .pop();
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

  function isGenericTitle(value) {
    const text = String(value || "").trim();
    if (!text) {
      return true;
    }
    if (GENERIC_TITLE_RE.test(text)) {
      return true;
    }
    const normalized = normalizeIdentityText(text);
    if (!normalized || GENERIC_STEM_RE.test(normalized)) {
      return true;
    }
    // If it's just a resolution (e.g. "720p")
    if (/^\d{3,4}p$/i.test(text)) {
      return true;
    }
    return false;
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
      downloadable: video.downloadable === false ? false : isDownloadableUrl(video.url || "", video.contentType || ""),
    };
  }

  function formatPriority(format) {
    const value = String(format || "").toUpperCase();
    if (value === "YOUTUBE") {
      return 10;
    }
    if (value === "M3U8" || value === "MPD" || value === "ISM") {
      return 8;
    }
    if (value === "PAGE") {
      return 6;
    }
    if (value === "MP4" || value === "WEBM") {
      return 4;
    }
    if (value === "AUDIO") {
      return 3;
    }
    return 1;
  }

  function fullVideoPriority(video) {
    if (!video) {
      return 0;
    }
    const format = String(video.format || "").toUpperCase();
    const priority = formatPriority(format);
    if (priority >= 6) {
      return priority;
    }

    const variants = Array.isArray(video.variants) ? video.variants : [];
    let best = 0;
    for (const variant of variants) {
      best = Math.max(best, formatPriority(variant.format));
    }
    return best >= 6 ? best : 0;
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
      formatPriority(video.format),
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
    const variants = group.variants.map(enrichVideoVariant).sort(compareVariants);
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
        (variant) => normalizeComparableUrl(variant.url || "") === normalizeComparableUrl(video.url || ""),
      );
      if (existingIndex >= 0) {
        group.variants[existingIndex] = mergeVariant(group.variants[existingIndex], video);
      } else {
        group.variants.push(video);
      }
    }

    return groups.map(buildGroupedVideo).sort(compareGroupedVideos);
  }

  function sourceLabel(video) {
    if (video && video.source === "manual-url") {
      return "manual link";
    }
    if (video && video.source === "music-page") {
      return "music";
    }
    if (["M3U8", "MPD", "YOUTUBE", "PAGE"].includes(String((video && video.format) || "").toUpperCase())) {
      return "full video";
    }
    return (video && video.source) || "detected";
  }

  return {
    classifyVideoUrl,
    displayVideoFormat,
    displayVideoSize,
    groupUniqueFullVideos,
    humanSize,
    isBlockedVideoUrl,
    isDownloadableUrl,
    isGenericTitle,
    isLikelyFullLengthVideoCandidate,
    isLikelyRealVideoBox,
    isLikelyRealVideoElement,
    isLikelyVideoRequest,
    isSameFullVideo,
    isYouTubeVideoPageUrl,
    normalizeYouTubeVideoPageUrl,
    sourceLabel,
  };
});
