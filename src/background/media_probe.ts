/**
 * Ask the helper what the server actually sends — the last rung of detection.
 *
 * Every other layer decides what a URL is by looking at the string: `shared/media_rules.ts`'
 * tables, `shared/streaming_patterns.ts`'s host shapes, the block list. Anything those
 * miss is dropped without ever being checked, which is how a real stream from
 * `/opaque/a1b2c3` becomes a page the user is told they cannot download.
 *
 * This is the only layer that asks the server. It runs **after** native `formats` and the
 * detected variants have both come up empty (`format_helpers.ts`), never per scan, so its
 * two-requests-per-URL cost is paid once per failed video rather than once per page.
 *
 * The URL list is filtered here rather than in the host: `isBlockedMediaUrl` is the
 * extension's own authority on what must never be touched, and an ad or infra URL should
 * not cross the process boundary at all.
 */
import type { NativeMediaProbe, NativeRequestFn, NativeResponse, RequestHeader } from "./types.js";

/**
 * URLs per call. The host caps again (`media_probe.MAX_PROBE_URLS`); this one exists so
 * a page with hundreds of unclassified resources cannot even build the request.
 */
export const PROBE_URL_LIMIT = 12;

/**
 * The format label a probed kind means to the rest of the system, or `""` for a kind
 * that is not downloadable.
 *
 * `page` is deliberately empty: the probe confirming that a URL is an HTML page is a
 * useful answer, but it is not an answer that unlocks a download.
 */
const KIND_FORMATS: Record<string, string> = {
  hls: "M3U8",
  dash: "MPD",
  mp4: "MP4",
  webm: "WEBM",
  mkv: "MKV",
  flv: "FLV",
  ogv: "OGV",
  audio: "AUDIO",
};

/** Collaborate with the background without importing it. */
export interface MediaProbeDeps {
  nativeRequest: NativeRequestFn;
  isBlockedMediaUrl(url: string, contentType?: string): boolean;
  normalizeUrl(url: string): string;
  nativeRequestHeadersForVideo(videoUrl: string, pageUrl: string): Promise<RequestHeader[]>;
  userAgent: string;
  /** Referer for the probe, so a hotlink-protected CDN answers the same way it did for the page. */
  pageUrl: string;
  /** Milliseconds; the caller owns the timeout because it owns the user wait. */
  timeoutMs?: number;
}

/** The probed URLs worth handing to yt-dlp, best (manifest) first. */
export interface ProbedDownloadSource {
  url: string;
  format: string;
  contentType: string;
  kind: string;
}

/** Manifests before files: an m3u8 unlocks every rendition, a lone mp4 unlocks one. */
const KIND_ORDER = ["hls", "dash", "mp4", "webm", "mkv", "flv", "ogv", "audio"];

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/** The URLs to ask about: http(s), not blocked, de-duplicated, capped. */
function probeWorthAsking(urls: readonly string[], deps: MediaProbeDeps): string[] {
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const value of urls) {
    const url = deps.normalizeUrl(value || "");
    if (!url || seen.has(url) || !/^https?:/i.test(url)) {
      continue;
    }
    if (deps.isBlockedMediaUrl(url)) {
      continue;
    }
    seen.add(url);
    wanted.push(url);
    if (wanted.length >= PROBE_URL_LIMIT) {
      break;
    }
  }
  return wanted;
}

/**
 * Ask the helper what these URLs are, and return the ones that turn out to be media.
 *
 * Never throws: a failed probe is a failed *fallback*, and the caller is already
 * deciding what to tell the user about a video it could not enumerate. An empty array
 * means "still nothing", which is exactly what the caller does with a thrown error.
 */
export async function probeMediaUrls(urls: readonly string[], deps: MediaProbeDeps): Promise<ProbedDownloadSource[]> {
  const wanted = probeWorthAsking(urls, deps);
  if (!wanted.length) {
    return [];
  }

  let response: NativeResponse;
  try {
    response = await deps.nativeRequest(
      {
        type: "probeMediaUrls",
        id: `probe_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        urls: wanted,
        pageUrl: deps.pageUrl,
        userAgent: deps.userAgent,
        requestHeaders: await deps.nativeRequestHeadersForVideo(wanted[0], deps.pageUrl),
      },
      deps.timeoutMs === undefined ? 30000 : deps.timeoutMs,
    );
  } catch (_error) {
    return [];
  }

  const results: NativeMediaProbe[] = Array.isArray(response?.results) ? response.results : [];
  const sources: ProbedDownloadSource[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const url = deps.normalizeUrl(result?.url || "");
    const kind = String(result?.kind || "").toLowerCase();
    const format = KIND_FORMATS[kind] || "";
    if (!url || !format || seen.has(url)) {
      continue;
    }
    seen.add(url);
    sources.push({ url, format, contentType: String(result?.contentType || ""), kind });
  }

  // Stable within a kind: the host answers in the order it was asked, which is the
  // caller's own priority order (the video's URL, then its page, then the unknown ones).
  return sources.sort((left, right) => kindRank(left.kind) - kindRank(right.kind));
}
