import * as videoFilters from "../shared/video_filters.js";
import * as mediaCandidates from "../shared/media_candidates.js";
import { lower } from "../shared/media_patterns.js";
import type { VideoRecord } from "./types.js";

// Re-export canonical regex patterns from media_candidates.ts
const VIDEO_EXTENSION_RE = mediaCandidates.VIDEO_EXTENSION_RE;
const HLS_RE = mediaCandidates.HLS_RE;
const DASH_RE = mediaCandidates.DASH_RE;
const DIRECT_VIDEO_EXTENSION_RE = mediaCandidates.DIRECT_VIDEO_EXTENSION_RE;
const CDN_HINT_RE = mediaCandidates.CDN_HINT_RE;

const MAX_VIDEOS_PER_TAB = 100;

// ── Hashing ──────────────────────────────────────────────────────────────

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v_${(hash >>> 0).toString(36)}`;
}

// ── Content type / size helpers ──────────────────────────────────────────

function contentTypeFromHeaders(headers?: chrome.webRequest.HttpHeader[]): string {
  const header = (headers || []).find((item) => item.name && item.name.toLowerCase() === "content-type");
  return header ? String(header.value || "").toLowerCase() : "";
}

function contentLengthFromHeaders(headers?: chrome.webRequest.HttpHeader[]): number | null {
  const header = (headers || []).find((item) => item.name && item.name.toLowerCase() === "content-length");
  const size = header ? Number(header.value) : 0;
  return Number.isFinite(size) && size > 0 ? size : null;
}

function parseContentRangeSize(value: unknown): number | null {
  const match = String(value || "").match(/\/(\d+)\s*$/);
  const size = match ? Number(match[1]) : 0;
  return Number.isFinite(size) && size > 0 ? size : null;
}

// ── Format detection ─────────────────────────────────────────────────────

function detectFormat(url: string, contentType = ""): string {
  return videoFilters.classifyVideoUrl(url, contentType);
}

function isPlaylistVideo(video: Pick<VideoRecord, "url" | "format" | "contentType">): boolean {
  const format = String(video.format || detectFormat(video.url || "", video.contentType || "")).toUpperCase();
  const contentType = lower(video.contentType);
  return (
    format === "M3U8" ||
    format === "MPD" ||
    HLS_RE.test(video.url || "") ||
    DASH_RE.test(video.url || "") ||
    contentType.includes("mpegurl") ||
    contentType.includes("dash+xml")
  );
}

function canProbeVideoSize(video: Pick<VideoRecord, "url" | "sizeBytes" | "contentType" | "format">): boolean {
  if (!video || video.sizeBytes || !isDownloadableUrl(video.url || "", video.contentType || "")) {
    return false;
  }
  if (isPlaylistVideo(video)) {
    return false;
  }
  const contentType = lower(video.contentType);
  return DIRECT_VIDEO_EXTENSION_RE.test(video.url || "") || contentType.startsWith("video/");
}

// ── URL classification ───────────────────────────────────────────────────

function isDownloadableUrl(url: string, contentType = ""): boolean {
  return videoFilters.isDownloadableUrl(url, contentType);
}

function isLikelyVideoRequest(url: string, resourceType: string, contentType = ""): boolean {
  return videoFilters.isLikelyVideoRequest(url, resourceType, contentType);
}

// ── Title helpers ────────────────────────────────────────────────────────

function looksLikeServerToken(text: string): boolean {
  if (!text || text.length <= 30 || /\s/.test(text)) {
    return false;
  }
  const alphaNum = text.replace(/[^a-zA-Z0-9]/g, "").length;
  return alphaNum / text.length > 0.8;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
    return (
      file
        .replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "")
        .replace(/[_-]+/g, " ")
        .trim() || "Video"
    );
  } catch (_error) {
    return "Video";
  }
}

export {
  VIDEO_EXTENSION_RE,
  HLS_RE,
  DASH_RE,
  DIRECT_VIDEO_EXTENSION_RE,
  CDN_HINT_RE,
  MAX_VIDEOS_PER_TAB,

  // Hashing
  hashId,

  // Content type / size
  contentTypeFromHeaders,
  contentLengthFromHeaders,
  parseContentRangeSize,
  lower,

  // Format detection
  detectFormat,
  isPlaylistVideo,
  canProbeVideoSize,

  // URL classification
  isDownloadableUrl,
  isLikelyVideoRequest,

  // Title helpers
  looksLikeServerToken,
  titleFromUrl,
};
