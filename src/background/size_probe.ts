import * as tabState from "./tab_state.js";
import * as videoUtils from "./video_utils.js";
import type { TabId, VideoRecord } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────

const SIZE_PROBE_TIMEOUT_MS = 8000;
const SIZE_PROBE_LIMIT_PER_GROUP = 6;

// ── State ────────────────────────────────────────────────────────────────

const sizeProbePromises: Record<string, Promise<unknown> | undefined> = {};

// ── Core probing functions ───────────────────────────────────────────────

function sizeFromFetchResponse(response: Response, ranged = false): number | null {
  if (!response || (!response.ok && response.status !== 206)) {
    return null;
  }
  const contentType = videoUtils.lower(response.headers.get("content-type"));
  if (contentType.includes("mpegurl") || contentType.includes("dash+xml") || contentType.includes("image/gif")) {
    return null;
  }

  const rangeSize = videoUtils.parseContentRangeSize(response.headers.get("content-range"));
  if (rangeSize) {
    return rangeSize;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return null;
  }
  if (ranged && response.status === 206 && contentLength <= 1) {
    return null;
  }
  return contentLength;
}

// `RequestInit` is spelled through `typeof fetch` because it is a type-only global
// that eslint's `no-undef` does not know about.
type ProbeInit = Parameters<typeof fetch>[1];

async function fetchSizeProbe(url: string, options: ProbeInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIZE_PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeVideoSize(video: VideoRecord): Promise<number | null> {
  if (!videoUtils.canProbeVideoSize(video)) {
    return null;
  }

  try {
    const headResponse = await fetchSizeProbe(video.url as string, { method: "HEAD" });
    const headSize = sizeFromFetchResponse(headResponse);
    if (headSize) {
      return headSize;
    }
  } catch (_error) {
    // Some CDNs disallow HEAD. Try a one-byte request below.
  }

  let rangeResponse: Response | null = null;
  try {
    const headers = new Headers();
    headers.set("Range", "bytes=0-0");
    rangeResponse = await fetchSizeProbe(video.url as string, { method: "GET", headers });
    return sizeFromFetchResponse(rangeResponse, true);
  } catch (_error) {
    return null;
  } finally {
    try {
      if (rangeResponse && rangeResponse.body && typeof rangeResponse.body.cancel === "function") {
        await rangeResponse.body.cancel();
      }
    } catch (_error) {}
  }
}

async function updateVideoSize(tabId: TabId, videoId: string, sizeBytes: number | null): Promise<boolean> {
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return false;
  }

  // `patchVideo` only reports `true` when it actually wrote, so a video that already
  // had a size reports `false` and every caller treats that as "nothing changed".
  return tabState.patchVideo(tabId, (item) => item.id === videoId && !item.sizeBytes, {
    sizeBytes: size,
  });
}

function scheduleVideoSizeProbe(tabId: TabId, video: VideoRecord): void {
  if (!videoUtils.canProbeVideoSize(video)) {
    return;
  }

  const key = `${tabId}:${video.id}`;
  if (sizeProbePromises[key]) {
    return;
  }

  sizeProbePromises[key] = probeVideoSize(video)
    .then((sizeBytes) => updateVideoSize(tabId, video.id as string, sizeBytes))
    .catch(() => false)
    .finally(() => {
      delete sizeProbePromises[key];
    });
}

function scheduleMissingSizeProbes(tabId: TabId): void {
  for (const video of tabState.getVideosForTab(tabId)) {
    scheduleVideoSizeProbe(tabId, video);
  }
}

export {
  SIZE_PROBE_LIMIT_PER_GROUP,
  probeVideoSize,
  scheduleVideoSizeProbe,
  scheduleMissingSizeProbes,
  updateVideoSize,
};
