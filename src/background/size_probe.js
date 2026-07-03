"use strict";

import * as tabState from "./tab_state.js";
import * as videoUtils from "./video_utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const SIZE_PROBE_TIMEOUT_MS = 8000;
const SIZE_PROBE_LIMIT_PER_GROUP = 6;

// ── State ────────────────────────────────────────────────────────────────

const sizeProbePromises = {};

// ── Core probing functions ───────────────────────────────────────────────

function sizeFromFetchResponse(response, ranged = false) {
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

async function fetchSizeProbe(url, options) {
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

async function probeVideoSize(video) {
  if (!videoUtils.canProbeVideoSize(video)) {
    return null;
  }

  try {
    const headResponse = await fetchSizeProbe(video.url, { method: "HEAD" });
    const headSize = sizeFromFetchResponse(headResponse);
    if (headSize) {
      return headSize;
    }
  } catch (_error) {
    // Some CDNs disallow HEAD. Try a one-byte request below.
  }

  let rangeResponse = null;
  try {
    const headers = new Headers();
    headers.set("Range", "bytes=0-0");
    rangeResponse = await fetchSizeProbe(video.url, { method: "GET", headers });
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

async function updateVideoSize(tabId, videoId, sizeBytes, _notify = false) {
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return false;
  }

  const changed = await tabState.patchVideo(tabId, (item) => item.id === videoId && !item.sizeBytes, {
    sizeBytes: size,
  });

  if (!changed) {
    return false;
  }

  return true;
}

function scheduleVideoSizeProbe(tabId, video) {
  if (!videoUtils.canProbeVideoSize(video)) {
    return;
  }

  const key = `${tabId}:${video.id}`;
  if (sizeProbePromises[key]) {
    return;
  }

  sizeProbePromises[key] = probeVideoSize(video)
    .then((sizeBytes) => updateVideoSize(tabId, video.id, sizeBytes))
    .catch(() => false)
    .finally(() => {
      delete sizeProbePromises[key];
    });
}

function scheduleMissingSizeProbes(tabId) {
  for (const video of tabState.getVideosForTab(tabId)) {
    scheduleVideoSizeProbe(tabId, video);
  }
}

export {
  SIZE_PROBE_TIMEOUT_MS,
  SIZE_PROBE_LIMIT_PER_GROUP,
  sizeFromFetchResponse,
  probeVideoSize,
  scheduleVideoSizeProbe,
  scheduleMissingSizeProbes,
  updateVideoSize,
};
