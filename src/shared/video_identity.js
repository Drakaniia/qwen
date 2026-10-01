"use strict";

import { classifyVideoUrl, isDownloadableUrl, lower, finiteNumber, textForVideoSignals } from "./video_filters.js";

// ── Regex constants (shared with video_filters.js) ─────────────────────

const QUALITY_WORD_RE =
  /\b(?:144|240|360|480|540|576|720|900|1080|1440|2160|4320)p\b|\b(?:8k|4k|uhd|qhd|fhd|hd|sd|low|medium|high|best|source|copy)\b/gi;

const FORMAT_WORD_RE = /\b(?:mp4|m4v|webm|m3u8|mpd|hls|dash)\b/gi;

const RESOLUTION_RE = /(?:^|[^\d])([1-9]\d{2,3})p(?:[^\d]|$)/i;

const DIMENSION_RE = /(?:^|[^\d])([1-9]\d{2,4})x([1-9]\d{2,4})(?:[^\d]|$)/i;

const MBPS_RE = /(?:^|[^\d])(\d+(?:\.\d+)?)\s?mbps(?:[^\d]|$)/i;

const KBPS_RE = /(?:^|[^\d])(\d{3,6})\s?kbps?(?:[^\d]|$)/i;

// ── Generic title detection ──────────────────────────────────────────

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

// ── URL normalization ──────────────────────────────────────────────────

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

// ── Generic title / stem detection ─────────────────────────────────────

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
  if (/^\d{3,4}p$/i.test(text)) {
    return true;
  }
  return false;
}

// ── Video identity ────────────────────────────────────────────────────

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

// ── Resolution / bitrate inference ─────────────────────────────────────

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

// ── Variant enrichment ─────────────────────────────────────────────────

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

export {
  // URL normalization (consumed by video_sorting.js)
  normalizeComparableUrl,

  // Generic title detection (consumed via video_filters.js re-export)
  isGenericTitle,

  // Video identity (consumed by video_sorting.js)
  isSameFullVideo,
  enrichVideoVariant,
};
