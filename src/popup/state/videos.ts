/**
 * Detected-video state (spec §5.1, §3.1, §6.7).
 *
 * `currentVideos` is `null` before the first scan completes, which is the same
 * three-state distinction the old store carried: "not scanned yet", "scanned, found
 * nothing" and "scanned, found something" produce three different screens. §6.10 turns
 * those into designed empty states, so the distinction is now load-bearing rather than
 * incidental.
 */
import { computed, signal } from "@preact/signals";

import type { StatusDotState } from "../../ui/Icon.js";
import { DEFAULT_FILTER, facetValues, filterAndSort, sourceHostOf, type FilterState } from "../../ui/filter.js";

export const AUDIO_FORMAT = "AUDIO";

/**
 * The subset of a detected candidate the popup renders.
 *
 * `width`/`height`/`duration`/`bitrate`/`tbr` were missing here and that is what
 * acceptance #4 was about (spec §3.1): `shared/contracts.ts`'s `DetectedVideo` carries
 * all five, the background sends them, and the render type refused them, so the
 * resolution ladder and the duration were unavailable *after* they had already crossed
 * the wire. `null` rather than `number` because the background's own record is
 * `number | null` and narrowing it here would put the cast back at every read.
 */
export interface VideoCandidate {
  id: string;
  url?: string;
  title?: string;
  format?: string;
  source?: string;
  size?: string;
  sizeBytes?: number;
  width?: number | null;
  height?: number | null;
  /** Seconds. Copied to `durationSeconds` by {@link displayedVideos} for `ui/filter.ts`. */
  duration?: number | null;
  bitrate?: number | null;
  tbr?: number | null;
  thumbnailUrl?: string;
  poster?: string;
  image?: string;
  /** The page the video was found on — input to site-derived art. */
  pageUrl?: string;
  /**
   * The content script's ordered ladder. See `ui/format.ts:videoThumbnailCandidates`,
   * which builds one from `thumbnailUrl` + `pageUrl` when this is absent.
   */
  thumbnailCandidates?: string[];
  downloadable?: boolean;
  variantCount?: number;
  hasSubtitles?: boolean;
  subtitleLanguages?: number;
  /** Set by `shared/video_sorting.js` `buildGroupedVideo`; the popup's recency key. */
  lastSeen?: number;
  /** Stamped from `lastSeen` by {@link displayedVideos} — see `ui/filter.ts` `recencyOf`. */
  updatedAt?: number;
}

/**
 * What the scan is doing. `pending` is "no scan has resolved yet", which is the state
 * the old `"Scanning for videos..."` string was standing in for (spec §6.10: "No state
 * ships as a bare centered sentence").
 */
export type ScanStatus = "pending" | "scanning" | "ready" | "failed";

export const scanStatus = signal<ScanStatus>("pending");

/** The failure text for `scanStatus === "failed"`, for the scan-failed empty state. */
export const scanError = signal("");

export const currentVideos = signal<VideoCandidate[] | null>(null);

/** Mark a scan in flight. Used by `rescanActiveTab` and by the first `refresh`. */
export function setScanStatus(status: ScanStatus, error = ""): void {
  scanStatus.value = status;
  scanError.value = error;
}

export function isAudio(video: VideoCandidate): boolean {
  return String(video.format || "").toUpperCase() === AUDIO_FORMAT;
}

/**
 * §6.2's status dot, derived rather than stored: `success` when the tab has
 * downloadable media, `critical` when it has none, `caution` while scanning.
 *
 * This replaces `setDownloadIndicator` and its 300ms debounce. The debounce existed
 * because the imperative setter wrote `dataset.status` on a live element and two
 * overlapping scans flickered the dot; a computed cannot flicker, because it only
 * changes when one of its three inputs does.
 */
export const mediaStatus = computed<StatusDotState>(() => {
  if (scanStatus.value === "pending" || scanStatus.value === "scanning") {
    return "caution";
  }
  // A failed scan is `critical`, not whatever the *previous* scan left behind. Reading
  // the candidate list first would colour the dot `success` off a list the popup no
  // longer trusts, while `mediaStatusLabel` below says "Couldn't read this page" — a dot
  // and a sentence disagreeing is worse than either alone.
  if (scanStatus.value === "failed") {
    return "critical";
  }
  const videos = currentVideos.value;
  if (videos === null) {
    return "caution";
  }
  return videos.some((video) => Boolean(video.downloadable)) ? "success" : "critical";
});

/** The same three cases as text, so the dot is never the only signal (spec §6.2). */
export const mediaStatusLabel = computed<string>(() => {
  const scanning = scanStatus.value === "pending" || scanStatus.value === "scanning";
  if (scanning) {
    return "Scanning this page for video";
  }
  if (scanStatus.value === "failed") {
    return "Could not read this page";
  }
  return mediaStatus.value === "success" ? "Downloadable video available" : "No downloadable video detected";
});

/**
 * Every candidate, unfiltered.
 *
 * D7 deleted the Music *view*, so this is no longer a partition — it is the plain list
 * the Media view renders, audio candidates included (they carry a purple badge instead
 * of living behind a third tab).
 */
export const visibleVideos = computed<VideoCandidate[]>(() => currentVideos.value || []);

/**
 * Search / facet / sort state for the video list, same contract as the downloads
 * page's (`downloads/state.ts`).
 */
export const videoFilter = signal<FilterState>({ ...DEFAULT_FILTER });

/** Whether the user has narrowed the list at all. Drives the "nothing matches" state. */
function isFiltered(state: FilterState): boolean {
  return Boolean(state.query.trim() || state.status || state.format || state.source);
}

/**
 * The min-size threshold from `ui/components/Meter.tsx` (spec §6.7, D8).
 *
 * `null` is `Any`, which is not the same as `0`: a candidate whose `sizeBytes` never
 * crossed the wire must pass it, and clamping to zero would filter on information the
 * data does not have.
 */
export const sizeThreshold = signal<number | null>(null);

/** What survives the threshold, before the text/facet/sort controls run. */
export const sizedVideos = computed<VideoCandidate[]>(() => {
  const videos = visibleVideos.value;
  const floor = sizeThreshold.value;
  if (floor === null) {
    return videos;
  }
  return videos.filter((video) => Number(video.sizeBytes || 0) >= floor);
});

/**
 * How many candidates the threshold is hiding (spec §6.7's live consequence line:
 * "12 detected · 4 hidden below 1 MB").
 *
 * Only ever meaningful while a threshold is set, hence the early return: with `Any`
 * active the honest count is "0 hidden", not "12 hidden below Any".
 */
export const hiddenBySize = computed<number>(() =>
  sizeThreshold.value === null ? 0 : visibleVideos.value.length - sizedVideos.value.length,
);

/** The threshold as the line reads it: `1 MB`, `50 MB`. Empty while `Any`. */
export const sizeThresholdLabel = computed<string>(() => {
  const floor = sizeThreshold.value;
  return floor === null ? "" : `${Math.round(floor / (1024 * 1024))} MB`;
});

/**
 * The list the popup renders, in the order the controls apply:
 *
 *   1. **the size threshold** ({@link sizedVideos}) — the coarsest cut, so a candidate
 *      the user has excluded by size cannot reappear in a facet dropdown's options.
 *   2. **the filter** — free text and facets, narrowing the pool to what survives.
 *   3. **sort** — order within what survived.
 *
 * `lastSeen` is copied to `updatedAt` because that is the field `ui/filter.ts` reads
 * for recency; without the copy the default "Newest first" sort would be a silent
 * no-op that fell through to the background's quality ordering. `duration` is copied
 * to `durationSeconds` for the same reason: `ui/filter.ts`'s `FilterableItem` names it
 * that, and acceptance #4 needs the value on the row anyway.
 */
export const displayedVideos = computed<VideoCandidate[]>(() =>
  filterAndSort(
    sizedVideos.value.map((video) => ({
      ...video,
      updatedAt: video.lastSeen,
      durationSeconds: Number(video.duration || 0),
    })),
    videoFilter.value,
  ),
);

/**
 * Facet options, computed from the *unfiltered* pool rather than the rendered list, for
 * the reason `ui/filter.ts` documents: offering only the values that survive the
 * current filter means picking one value empties the dropdown it came from.
 */
export const videoFormatFacet = computed<string[]>(() =>
  facetValues(visibleVideos.value, (video) => String(video.format || "")),
);

export const videoSourceFacet = computed<string[]>(() => facetValues(visibleVideos.value, sourceHostOf));

/**
 * The live consequence line under the filter bar (spec §6.7): what the controls did to
 * the list, not what the list is.
 *
 * §6.7, verbatim: "telling the user what the filter did is the difference between a
 * filter and a mystery." `null` before the first scan, because there is nothing to have
 * done anything to yet.
 */
export const filterSummary = computed<string | null>(() => {
  if (currentVideos.value === null) {
    return null;
  }

  const detected = visibleVideos.value.length;
  const hidden = hiddenBySize.value;
  const shown = displayedVideos.value.length;

  // Nothing was filtered: the detection summary is the more useful thing to say.
  if (!hidden && !(sizeThreshold.value !== null || isFiltered(videoFilter.value))) {
    const audio = visibleVideos.value.filter(isAudio).length;
    const parts: string[] = [];
    if (detected - audio > 0) {
      parts.push(`${detected - audio} video${detected - audio === 1 ? "" : "s"}`);
    }
    if (audio > 0) {
      parts.push(`${audio} audio track${audio === 1 ? "" : "s"}`);
    }
    return parts.length ? `${parts.join(" and ")} detected.` : "Nothing detected.";
  }

  // Everything was filtered away, so "N of M" would be a claim about an empty list.
  if (!shown) {
    const because = sizeThreshold.value !== null ? `below ${sizeThresholdLabel.value}` : "matching the filter";
    return `Nothing ${because}.`;
  }

  const pieces = [`${shown} of ${detected} detected`];
  if (hidden) {
    pieces.push(`${hidden} hidden below ${sizeThresholdLabel.value}`);
  }
  return `${pieces.join(" · ")}.`;
});

/** Whether the filter bar, the meter and the consequence line are worth showing at all. */
export const hasCandidates = computed<boolean>(() => visibleVideos.value.length > 0);
