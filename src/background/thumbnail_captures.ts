/**
 * Service-worker memory for canvas frame captures (thumbnail-spec.md §5, D10).
 *
 * A `data:` URL is base64 — one 160px JPEG is tens of KB — and `tab_state.ts`
 * persists every video record per tab, so a capture on the record would be
 * `storage.local` quota spent on bytes that are only meaningful while the page
 * that produced them is still open. So the captures live here instead, and the
 * stored record carries only the `http(s):` half of the ladder.
 *
 * **This map is deliberately not durable.** An MV3 service worker is evicted
 * between events, so every capture is lost on eviction and the affected rows fall
 * back to site/page art on the next popup open. That is the accepted cost of D10
 * ("memory only, never `storage.local`"); making it survive would mean a new
 * persistence path, which is the thing D10 declined.
 */

import type { VideoRecord } from "./types.js";

/** `data:` is the only scheme a frame capture ever uses. */
function isCapture(url: unknown): boolean {
  return typeof url === "string" && url.startsWith("data:");
}

/**
 * tab → (video id → its captures, in the order the content script ranked them).
 *
 * ponytail: unbounded per tab until the tab is cleared. `MAX_VIDEOS_PER_TAB`
 * eviction drops a *record* but not its capture, so the worst case is a few dozen
 * tens-of-KB strings for one tab. Cap it here if a page ever proves to hold
 * hundreds of thumbnail-less candidates; the fix is a size limit on the inner
 * map, not a second store.
 */
const capturesByTab = new Map<number, Map<string, string[]>>();

/**
 * Stash the `data:` entries of each candidate's ladder, keyed by tab and video id.
 *
 * Called with the **un-stripped** ladder — the caller strips before persisting —
 * so this is the only place that ever sees a capture.
 */
export function rememberCaptures(tabId: number, videos: { id?: string; thumbnailCandidates?: string[] }[]): void {
  if (!Number.isInteger(tabId)) {
    return;
  }
  for (const video of Array.isArray(videos) ? videos : []) {
    const id = video?.id;
    if (!id) {
      continue;
    }
    const captures = (Array.isArray(video.thumbnailCandidates) ? video.thumbnailCandidates : []).filter(isCapture);
    if (!captures.length) {
      continue;
    }
    let byId = capturesByTab.get(tabId);
    if (!byId) {
      byId = new Map<string, string[]>();
      capturesByTab.set(tabId, byId);
    }
    byId.set(id, captures);
  }
}

/** The stashed captures for one video, or `[]` for an unknown tab or id. */
export function capturesFor(tabId: number, videoId: string): string[] {
  return capturesByTab.get(tabId)?.get(videoId) || [];
}

/**
 * Copies of `videos` with their captures spliced back onto the ladder, for the
 * popup only — nothing here is persisted.
 *
 * Spliced in at **index 1**, right behind the poster, which is the tier
 * `thumbnail-spec.md` §3/D12a gives them: the frame is more specific than anything
 * derived from a URL and it is already in memory, so it costs no request. Appending
 * at the end instead would demote it past `ui/format.ts`'s `THUMBNAIL_CANDIDATE_LIMIT`
 * and drop it entirely whenever the stored ladder already holds three `http(s)`
 * entries. Never mutates the inputs.
 */
export function withCaptures(tabId: number, videos: VideoRecord[]): VideoRecord[] {
  const byId = capturesByTab.get(tabId);
  if (!byId || !byId.size) {
    return videos;
  }
  return videos.map((video) => {
    const captures = byId.get(video.id);
    if (!captures || !captures.length) {
      return video;
    }
    const ladder = Array.isArray(video.thumbnailCandidates) ? [...video.thumbnailCandidates] : [];
    const alreadyPresent = new Set(ladder);
    ladder.splice(1, 0, ...captures.filter((capture) => !alreadyPresent.has(capture)));
    return { ...video, thumbnailCandidates: ladder };
  });
}

/** Drop a tab's captures. Wired to the same teardown that drops its video records. */
export function clearCaptures(tabId: number): void {
  capturesByTab.delete(tabId);
}
