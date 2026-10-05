/**
 * Canonical display formatters (spec §5 Phase 5, §11.1).
 *
 * Every function here had two or more copies producing *different* output. The
 * winning behaviour for each was chosen from evidence, not taste — see the
 * divergence assertions in `tests/js/ui/format.test.ts` for the pins:
 *
 *   - `shortenUrl`   popup's copy wins over `video_picker.js`'s (it is the one the
 *                    user sees today, and it keeps the file extension and the
 *                    query-presence marker that the picker's 28-char cut destroys).
 *   - `videoTitle`   popup's copy wins (it falls back to "Music" for audio jobs;
 *                    the picker's literal "Video" is a defect, not a style).
 *   - `displayFormat`/`sourceLabel`/`videoSizeLabel` are NOT reimplemented. They
 *                    collapse a three-module indirection
 *                    (`popup_ui.js` → `video_picker.js` → `video_filters.js`, plus a
 *                    third re-export at `popup_helpers.js:161-167`) straight onto
 *                    `video_filters.js`, the only layer that holds the real logic.
 *
 * `videoThumbnailUrl` and `normalizeManualUrl` are single copies today, but they
 * live in `popup_ui.js`, which this consolidation empties. They moved here rather
 * than being left for the popup agent to re-home.
 */
import { displayVideoFormat, displayVideoSize, sourceLabel as filteredSourceLabel } from "../shared/video_filters.js";
import { clampDownloadPercent } from "../shared/download_statuses.js";
import { THUMBNAIL_CANDIDATE_LIMIT, dedupeThumbnailUrls, deriveSiteThumbnail } from "./thumbnail_sources.js";

/** The subset of a video candidate / download job these formatters read. */
export interface VideoLike {
  title?: string;
  url?: string;
  format?: string;
  source?: string;
  size?: string;
  sizeBytes?: number;
  thumbnailUrl?: string;
  poster?: string;
  image?: string;
  /** The page the video was found on — the input to site-derived art. */
  pageUrl?: string;
  /**
   * The content script's own ordered ladder, when it built one. Present on
   * candidates that came from a `<video>` element; absent on network-detected ones,
   * which is exactly why {@link videoThumbnailCandidates} can build one here.
   */
  thumbnailCandidates?: string[];
}

/** Above this many characters a URL is cut from the middle, keeping both ends. */
const URL_CUT_AT = 74;
const URL_HEAD = 34;
const URL_TAIL = 30;
const URL_FALLBACK_AT = 95;

/**
 * Shorten a URL for display: `hostname/path`, cut from the middle when long, with
 * a `?...` marker when query parameters were present.
 *
 * Canonical over `video_picker.js`'s copy, which cut the path at 28 characters and
 * dropped the query entirely — that loses the file extension (`.mp4`) and the
 * stream/signed-URL distinction, both of which the user needs to pick a download.
 */
export function shortenUrl(url: unknown): string {
  try {
    const parsed = new URL(String(url || ""));
    const path = `${parsed.hostname}${parsed.pathname}`;
    const suffix = parsed.search ? "?..." : "";
    return path.length > URL_CUT_AT
      ? `${path.slice(0, URL_HEAD)}...${path.slice(-URL_TAIL)}${suffix}`
      : `${path}${suffix}`;
  } catch (_error) {
    return String(url || "").slice(0, URL_FALLBACK_AT);
  }
}

/**
 * Display title for a video candidate, falling back to the shortened URL and then
 * to "Music" or "Video" based on the format.
 */
export function videoTitle(video: VideoLike | null | undefined): string {
  if (video && video.title) {
    return video.title;
  }
  const isAudio = String((video && video.format) || "").toUpperCase() === "AUDIO";
  return shortenUrl(video && video.url) || (isAudio ? "Music" : "Video");
}

/** Format badge, e.g. `m3u8` → `MP4`. */
export function displayFormat(video: VideoLike | null | undefined): string {
  return displayVideoFormat(video);
}

/** Human-readable source, e.g. `manual-url` → `manual link`. */
export function sourceLabel(video: VideoLike | null | undefined): string {
  return filteredSourceLabel(video);
}

/** Human-readable size, e.g. 2048 bytes → `2.0 KB`. Empty when unknown. */
export function videoSizeLabel(video: VideoLike | null | undefined): string {
  return displayVideoSize(video);
}

/** `42%` from any raw progress value. */
export function formatDownloadPercent(percent: unknown): string {
  return `${Math.round(clampDownloadPercent(percent))}%`;
}

/**
 * The site a download came from, for a job row's chip: `pageUrl`'s host, else the media
 * URL's.
 *
 * `pageUrl` first because the media URL is usually a CDN — `googlevideo.com`, a different
 * host per video, recognisable to nobody — while `pageUrl` is the site the user was
 * actually on. `download/native.ts` defaults it to the active tab's URL, so a pasted URL
 * still gets a real host.
 *
 * `""` when neither parses: the caller renders no chip rather than an empty pill. Same
 * precedence as `filter.ts`'s `sourceHostOf` (which adds a stored `sourceHost` for synced
 * entries that have no `pageUrl`), so the tray's chip and `downloads.html`'s Source facet
 * agree.
 *
 * Structural input, not `DownloadJob` — `ui/` must not depend on a popup type.
 */
export function jobHostOf(job: { pageUrl?: string; url?: string } | null | undefined): string {
  for (const url of [job?.pageUrl, job?.url]) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname;
      if (host) return host;
    } catch (_error) {
      // Not a URL — try the next field.
    }
  }
  return "";
}

/**
 * Schemes an `<img>` can actually load in an extension page.
 *
 * `blob:` was here until 2026-10-04 and is deliberately gone (spec §1.3): a blob URL
 * is scoped to the origin that created it, so a `poster="blob:…"` captured from a web
 * page resolves to nothing in `chrome-extension://` and fires `onError` every time.
 * Keeping it in the allowlist made an unwinnable case look like a broken CDN.
 */
const RENDERABLE_SCHEMES = ["http:", "https:", "data:"];

/** Keep only URLs an `<img>` in an extension page can render. */
function renderableThumbnailUrl(value: unknown): string {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    return RENDERABLE_SCHEMES.includes(parsed.protocol) ? parsed.href : "";
  } catch (_error) {
    return "";
  }
}

/**
 * First usable thumbnail on a video candidate, restricted to schemes that cannot
 * execute. Returns "" when there is none.
 */
export function videoThumbnailUrl(video: VideoLike | null | undefined): string {
  return videoThumbnailCandidates(video)[0] || "";
}

/**
 * The row's ordered thumbnail ladder: what to render, and what to advance to when it
 * 403s or comes back too small to recognise (spec §3, §6).
 *
 * Order is **video-specific art first, page-level art last** — the inverse of what
 * the content script used to do implicitly. `og:image` was the only thing a
 * network-detected candidate ever received, so on a page with one hero video and a
 * dozen preview streams every row showed the same hero image; demoting it to last
 * resort is what makes the other rows show *their own* video.
 *
 * A ladder supplied by the content script wins outright: it saw the element, so its
 * order already accounts for the frame capture. Otherwise one is derived here from
 * whatever the record carries, which is all a network candidate has.
 */
export function videoThumbnailCandidates(video: VideoLike | null | undefined): string[] {
  if (!video) {
    return [];
  }

  const supplied = Array.isArray(video.thumbnailCandidates) ? video.thumbnailCandidates : [];
  if (supplied.length) {
    return dedupeThumbnailUrls(supplied.map(renderableThumbnailUrl))
      .filter(Boolean)
      .slice(0, THUMBNAIL_CANDIDATE_LIMIT);
  }

  // The page URL first: a `youtube.com/watch?v=…` page beats a bare `.mp4` served
  // from a YouTube CDN host, which is the reverse of the argument in the other order.
  const derived = deriveSiteThumbnail(video.pageUrl) || deriveSiteThumbnail(video.url);

  return dedupeThumbnailUrls([video.thumbnailUrl || video.poster || video.image, derived].map(renderableThumbnailUrl))
    .filter(Boolean)
    .slice(0, THUMBNAIL_CANDIDATE_LIMIT);
}

// ── Units ────────────────────────────────────────────────────────────────────
//
// The byte/size/speed/ETA trio below is not a new vocabulary: `DownloadJob` carries
// `speed`, `eta`, `downloadedSize` and `totalSize` as *strings the native host already
// formatted* (`native_host/download/progress_parser.py` → `compact_progress_value`,
// so `"12.34MiB"`, `"4.1MiB/s"`, `"00:18"`), while `DetectedVideo.sizeBytes` crosses
// the wire as a raw number. One formatter that accepts either shape is the whole
// point — two formatters would disagree about `MiB` vs `MB` on the same row.
//
// 1024-based, deliberately: `shared/video_filters.ts`'s `humanSize` already divides
// by 1024 and shows `MiB` values as `MB`, so one ladder across the app beats
// pedantry about which "MB" the host meant.

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

/** Raw byte count from a number or a host-formatted size/speed token. `null` if neither. */
function bytesFrom(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const match = String(value ?? "")
    .trim()
    .replace(/^[~≈]\s*/, "")
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)(?:\/s)?$/i);
  if (!match) {
    return null;
  }
  const unit = BYTE_UNITS[match[2].toLowerCase().replace("i", "")];
  return unit ? Number(match[1]) * unit : null;
}

/**
 * Byte count as `2.0 KB` / `128.4 MB` / `1.3 GB` — one decimal above KB, integer bytes.
 * Accepts a raw count or the host's own `"128MiB"`. Empty when unknown, matching
 * `videoSizeLabel`: a size the code does not know is omitted, never shown as `0 B`.
 */
export function formatSize(value: unknown): string {
  const bytes = bytesFrom(value);
  if (bytes === null || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** Transfer rate as `4.1 MB/s`. Accepts bytes/second or the host's `"4.1MiB/s"`. */
export function formatSpeed(value: unknown): string {
  const size = formatSize(value);
  return size ? `${size}/s` : "";
}

/** `596` → `9:56`, `3723` → `1:02:03`. Empty when unknown; the hours field only appears when there is one. */
export function formatDuration(value: unknown): string {
  const total = Math.floor(Number(value));
  if (!Number.isFinite(total) || total <= 0) {
    return "";
  }
  const seconds = String(total % 60).padStart(2, "0");
  if (total < 3600) {
    return `${Math.floor(total / 60)}:${seconds}`;
  }
  return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${seconds}`;
}

/** Countdown form for a row, where `0:18` reads as noise next to a bar: `18s`, `1m 35s`, `1h 5m`. */
function countdown(total: number): string {
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  }
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

/**
 * Remaining time as `~18s left`. yt-dlp and aria2 both report ETA as a clock
 * (`00:18`, `1:02:03`), not a duration, and both spell "unknown" differently
 * (`NA`, `?`) — all of which mean "no honest countdown", so all of them are empty.
 */
export function formatEta(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || !/^\d/.test(text)) {
    return "";
  }
  const clock = text.match(/^(?:(\d+):)?(\d+):(\d+)$/);
  const seconds = clock ? Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  return `~${countdown(Math.round(seconds))} left`;
}

/**
 * Resolution ladder label from `DetectedVideo.height` (spec §6.6): `1080p`.
 * Audio-only candidates say so, and an unknown height is an em dash rather than
 * a fabricated `0p` — the row's other fields are still readable without it.
 */
export function resolutionLabel(height: number | null | undefined, isAudio = false): string {
  if (isAudio) {
    return "audio";
  }
  const pixels = Number(height);
  return Number.isFinite(pixels) && pixels > 0 ? `${Math.round(pixels)}p` : "—";
}

/**
 * Normalize a manually entered URL to a canonical http(s) href, or "" if it is
 * not one. This is a trust boundary — a rejected scheme must never reach the
 * background as a download target.
 */
export function normalizeManualUrl(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}
