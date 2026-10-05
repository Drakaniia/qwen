/**
 * Video identity: when two detections are the same video.
 *
 * The content script sees the same stream three ways (a `<video>` element, a network
 * capture, an SSR config blob) and `video_sorting` needs to collapse them. That means
 * normalizing URLs, titles and file stems into comparable keys, and deciding when
 * "same page + compatible title" is enough to call two candidates one video.
 */

import type { MediaCandidateLike } from "./media_rules.js";
import { classifyVideoUrl, finiteNumber, isDownloadableUrl, lower, textForVideoSignals } from "./video_filters.js";

// ── Regex constants (shared with video_filters.js) ─────────────────────

/** `1080p`, `4k`, `fhd`… — stripped from titles so `movie 1080p` and `movie` match. */
const QUALITY_WORD_RE =
  /\b(?:144|240|360|480|540|576|720|900|1080|1440|2160|4320)p\b|\b(?:8k|4k|uhd|qhd|fhd|hd|sd|low|medium|high|best|source|copy)\b/gi;

/** `mp4`, `hls`, `dash`… — same reason as {@link QUALITY_WORD_RE}. */
const FORMAT_WORD_RE = /\b(?:mp4|m4v|webm|m3u8|mpd|hls|dash)\b/gi;

const RESOLUTION_RE = /(?:^|[^\d])([1-9]\d{2,3})p(?:[^\d]|$)/i;

const DIMENSION_RE = /(?:^|[^\d])([1-9]\d{2,4})x([1-9]\d{2,4})(?:[^\d]|$)/i;

const MBPS_RE = /(?:^|[^\d])(\d+(?:\.\d+)?)\s?mbps(?:[^\d]|$)/i;

const KBPS_RE = /(?:^|[^\d])(\d{3,6})\s?kbps?(?:[^\d]|$)/i;

// ── Generic title detection ──────────────────────────────────────────

/** Words a page uses to name "the thing that is playing" rather than the video itself. */
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

/** The URL without its fragment — two candidates differing only by `#t=30` are one video. */
function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return String(url || "").split("#", 1)[0];
  }
}

/** Lowercase, minus the extension, dimensions, quality words and format words. */
function normalizeIdentityText(value: unknown): string {
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

/** {@link normalizeIdentityText} minus the page-chrome words (`watch`, `online`, `video`). */
function normalizeTitleKey(value: unknown): string {
  return normalizeIdentityText(value)
    .replace(/\b(?:watch|online|video)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalized file name of a URL — the strongest cheap identity signal. */
function normalizeVideoStem(url: string): string {
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

/** The URL without fragment *or* query — "which page is this on". */
function normalizePageKey(url: string): string {
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

function isGenericStem(stem: string): boolean {
  return GENERIC_STEM_RE.test(stem || "");
}

/** Whether a title says nothing about which video this is. */
function isGenericTitle(value: unknown): boolean {
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

interface VideoIdentityParts {
  urlKey: string;
  pageKey: string;
  titleKey: string;
  stemKey: string;
  genericStem: boolean;
}

function videoIdentityParts(video: MediaCandidateLike): VideoIdentityParts {
  const stemKey = normalizeVideoStem(video.url || "");
  return {
    urlKey: normalizeComparableUrl(video.url || ""),
    pageKey: normalizePageKey(video.pageUrl || video.frameUrl || ""),
    titleKey: normalizeTitleKey(video.title || ""),
    stemKey,
    genericStem: isGenericStem(stemKey),
  };
}

/**
 * Whether two candidates are the same video.
 *
 * Same URL wins outright. Otherwise they must share a page, and then either the
 * same file stem, or a same title — the last case only when one side's stem is
 * generic ("video.mp4"), because a generic stem carries no information and two
 * different videos on one page would otherwise collapse into one row.
 */
function isSameFullVideo(left: MediaCandidateLike, right: MediaCandidateLike): boolean {
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

/** `1920x1080` or `1080p` in any signal text, as `{width, height}`. */
function inferResolutionFromText(value: unknown): { width: number; height: number } {
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

/** `5 mbps` / `2500 kbps` in any signal text, as kbps. */
function inferBitrateFromText(value: unknown): number {
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

/** A variant with its dimensions, bitrate, format and downloadability filled in from its own signals. */
export type EnrichedVideoVariant<T extends MediaCandidateLike> = T & {
  format: string;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  tbr: number | null;
  downloadable: boolean;
};

/**
 * Fill in what the detection missed by reading it back out of its own text.
 *
 * A URL called `movie_1080p_5mbps.mp4` on a page titled `movie 720p` carries both a
 * resolution and a bitrate; the metadata block may have neither. Inference is
 * last-resort — a reported value always wins.
 */
function enrichVideoVariant<T extends MediaCandidateLike>(video: T): EnrichedVideoVariant<T> {
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
