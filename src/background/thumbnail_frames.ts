/**
 * The last rung of the thumbnail ladder: one ffmpeg frame, asked of the native helper
 * (`hls-thumbnail-spec.md` §5).
 *
 * Every other rung is metadata someone published about the video — a `poster`, an
 * `og:image`, a URL derived from the site — and an HLS stream has none of them: hls.js
 * sets no poster, a bare `.m3u8` tab has no page, and yt-dlp's generic extractor returns
 * no thumbnail. So for those rows the ladder is genuinely empty and reading the stream
 * is the only source of art left. This module owns that read and the H9 budget around it.
 *
 * **The result is a capture, not a thumbnail field.** §5.2: `rememberCaptures` already
 * stashes any `data:` URL in service-worker memory, `withCaptures` already splices it back
 * at index 1 on the way out to the popup, and `background.ts` already strips `data:` entries
 * before persisting. So this file writes one capture and no new storage exists — which is
 * also why nothing here may touch `job.thumbnailUrl`: that field is copied into the synced
 * history entry and `storage.sync` has a ~100 KB total budget (spec §11).
 *
 * **Nothing here is durable** (H7). Both the per-tab capture map and the by-URL frame map
 * live in service-worker memory, so eviction loses them and the next open recomputes. The
 * budget counters ride along in the same breath, which is why eviction *re-arming* the
 * budget is correct rather than a leak: the frames the budget was spent on are gone too.
 */

import type { NativeRequestFn, NotifyPopup, RequestHeader, TabId, VideoRecord } from "./types.js";
import type * as thumbnailCaptures from "./thumbnail_captures.js";

/** H9: six grabs per tab per worker lifetime. The ceiling on one page's ffmpeg spawns. */
const MAX_GRABS_PER_TAB = 6;

/** H9: two concurrent ffmpeg processes. The third waits rather than failing. */
const MAX_CONCURRENT_GRABS = 2;

/** H9: 20s per native call. A stream that stalls past this is treated as having no frame. */
const GRAB_TIMEOUT_MS = 20000;

/** H6: `-ss 1`, an input seek. The host owns the default; sent explicitly for clarity. */
const FRAME_AT_SECONDS = 1;

/**
 * How many URLs the by-URL map holds.
 *
 * ponytail: 64 entries, ~1 MB of base64 at worst, trimmed to the most recent on insert.
 * This is a ceiling, not a design: if a session ever shows more than 64 distinct
 * thumbnail-less streams at once the oldest frame is re-grabable, which costs one ffmpeg
 * spawn and is cheaper than any eviction policy worth writing.
 */
const FRAME_CACHE_LIMIT = 64;

/** Sentinels in {@link ThumbnailFrameService}'s frame map. A third value is the frame. */
const PENDING = "pending";
const EMPTY = "empty";

/** Everything {@link create} needs. Injected so the budget can be asserted without a worker. */
export interface ThumbnailFrameDeps {
  nativeRequest: NativeRequestFn;
  notifyPopup: NotifyPopup;
  getVisibleVideosForTab(tabId: TabId): VideoRecord[];
  /** The tab's stored records — where a `videoId` is resolved to a URL and a page. */
  getVideosForTab(tabId: TabId): VideoRecord[];
  /**
   * §4.1's load-bearing field: without `Referer` / `Cookie` / `User-Agent` a large share
   * of HLS CDNs 403 the manifest and the grab always fails. Injected rather than imported
   * from `header_utils.js` so this module needs no browser API at all.
   */
  nativeRequestHeadersForVideo(videoUrl: string, pageUrl: string): Promise<RequestHeader[]>;
  rememberCaptures: typeof thumbnailCaptures.rememberCaptures;
}

export interface ThumbnailFrameService {
  /** §5.1. Resolves the frame `data:` URL, or `""` for no art, budget, or failure (H10). */
  grabFrame(tabId: TabId, videoId: string): Promise<string>;
  /** §5.3. Lookup only — misses are absent and never spawn a grab. */
  framesForUrls(urls: string[]): Record<string, string>;
  /** Drop a tab's budget counter, beside `clearCaptures` on the teardown path. */
  clearTab(tabId: TabId): void;
}

/**
 * A cache entry that is an actual frame.
 *
 * The map holds three states per URL (§5.1): `"pending"` while the grab runs, `"empty"`
 * when the URL is known to have none, and the `data:` URL itself otherwise. Only the last
 * is art, so only the last is returned.
 */
function isFrame(entry: string | undefined): entry is string {
  return typeof entry === "string" && entry !== PENDING && entry !== EMPTY;
}

/**
 * Build the service. A factory, not module state, because both the H9 budget and the
 * frame cache are mutable per-worker state and a test has to be able to assert the budget
 * without a real service worker behind it.
 */
export function create(deps: ThumbnailFrameDeps): ThumbnailFrameService {
  /** tab → grabs spent this worker lifetime. Reset by `clearTab`; re-armed by eviction. */
  const grabsByTab = new Map<number, number>();

  /** URLs with an ffmpeg process running right now, at most {@link MAX_CONCURRENT_GRABS}. */
  const inFlight = new Set<string>();

  /** Grabbers waiting for a slot. The head is promoted by `release`. */
  const waiters: { url: string; start: () => void }[] = [];

  /** url → `"pending"` | `"empty"` | `data:` URL. Insertion-ordered, so it trims LRU-ish. */
  const framesByUrl = new Map<string, string>();

  /**
   * Take one of the two H9 slots, waiting for one if both are busy. Resolves once this URL
   * is in flight. A plain waiter queue rather than a semaphore: the cap is a literal 2 and
   * the queue is a handful of closures.
   */
  function acquire(url: string): Promise<void> {
    if (inFlight.size < MAX_CONCURRENT_GRABS) {
      inFlight.add(url);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({
        url,
        start: () => {
          inFlight.add(url);
          resolve();
        },
      });
    });
  }

  /** Give the slot back and hand it to the next waiter. */
  function release(url: string): void {
    inFlight.delete(url);
    waiters.shift()?.start();
  }

  /** Write a cache state, moving the URL to the recent end and trimming to the cap. */
  function remember(url: string, entry: string): void {
    framesByUrl.delete(url);
    framesByUrl.set(url, entry);
    while (framesByUrl.size > FRAME_CACHE_LIMIT) {
      const oldest = framesByUrl.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      framesByUrl.delete(oldest);
    }
  }

  /** One host round trip. Never throws — H10 puts failure on the caller to swallow. */
  async function askHost(video: VideoRecord): Promise<string> {
    const url = video.url || "";
    const pageUrl = video.pageUrl || "";
    try {
      const response = await deps.nativeRequest(
        {
          type: "thumbnailFrame",
          // Same id shape as `format_helpers.ts`'s `formats` request.
          id: `thumbnail_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          url,
          pageUrl,
          requestHeaders: await deps.nativeRequestHeadersForVideo(url, pageUrl),
          atSeconds: FRAME_AT_SECONDS,
        },
        GRAB_TIMEOUT_MS,
      );
      return typeof response?.frameUrl === "string" ? response.frameUrl : "";
    } catch (_error) {
      // No ffmpeg, a 20s timeout, a 403. §4.3: the row's glyph was already the right
      // answer, so there is nothing to report and nothing to retry — the URL is now
      // cached as `empty` and this worker will not spend another grab on it.
      return "";
    }
  }

  /**
   * §5.2: splice the frame into the row's ladder and push the refreshed list.
   *
   * The splice, the strip-before-persist and the popup refresh are all existing
   * machinery, so this is the whole of "a frame is art" on the extension side.
   */
  function publishFrame(tabId: TabId, videoId: string, frameUrl: string): void {
    deps.rememberCaptures(tabId as number, [{ id: videoId, thumbnailCandidates: [frameUrl] }]);
    deps.notifyPopup({ type: "videoListUpdated", tabId, videos: deps.getVisibleVideosForTab(tabId) });
  }

  async function grabFrame(tabId: TabId, videoId: string): Promise<string> {
    if (!Number.isInteger(tabId) || !videoId) {
      return "";
    }
    const video = deps.getVideosForTab(tabId).find((item) => item.id === videoId);
    if (!video?.url) {
      return "";
    }
    const url = video.url;

    // Already known: a frame is free, and `empty`/`pending` cost no host call. The frame
    // is re-inserted so the LRU-ish trim below counts it as recently used.
    const cached = framesByUrl.get(url);
    if (cached !== undefined) {
      if (!isFrame(cached)) {
        return "";
      }
      framesByUrl.delete(url);
      framesByUrl.set(url, cached);
      // The frame is re-published, not just returned: the cache is keyed by URL while a
      // capture is keyed by tab + id, so the second tab to ask about the same stream gets
      // nothing back otherwise. Cheap either way — `withCaptures` reads memory and the
      // notify is the push the row was already waiting for. Also the only thing that
      // repairs a capture lost to `clearCaptures` on tab teardown, which drops the
      // per-tab map but not this one.
      publishFrame(tabId, videoId, cached);
      return cached;
    }

    const tab = tabId as number;
    const spent = grabsByTab.get(tab) || 0;
    if (spent >= MAX_GRABS_PER_TAB) {
      return "";
    }
    // Charged before the queue, not after it: a waiting grab is a committed spawn, and
    // charging on admission is what stops 30 queued rows from all passing the cap.
    grabsByTab.set(tab, spent + 1);

    await acquire(url);
    try {
      remember(url, PENDING);
      const frameUrl = await askHost(video);
      remember(url, frameUrl || EMPTY);
      if (!frameUrl) {
        return "";
      }
      publishFrame(tab, videoId, frameUrl);
      return frameUrl;
    } finally {
      release(url);
    }
  }

  function framesForUrls(urls: string[]): Record<string, string> {
    const frames: Record<string, string> = {};
    for (const url of Array.isArray(urls) ? urls : []) {
      if (typeof url !== "string" || !url) {
        continue;
      }
      const entry = framesByUrl.get(url);
      if (isFrame(entry)) {
        frames[url] = entry;
      }
    }
    return frames;
  }

  return {
    grabFrame,
    framesForUrls,
    clearTab(tabId: TabId) {
      if (Number.isInteger(tabId)) {
        grabsByTab.delete(tabId as number);
      }
    },
  };
}
