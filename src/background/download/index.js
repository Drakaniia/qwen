"use strict";

import { createOperations } from "../download_operations.js";
import { startNativeDownloadFromVideo } from "./native.js";

/**
 * Create a download orchestrator with all download-related functions.
 *
 * @param {Object} deps - Dependency object injected by the caller (background.js).
 * @returns {Object} Public API with download control methods.
 */
function create(deps) {
  // ── Operations (download control, file ops, management) ──────────────
  // These receive startNativeDownloadFromVideo as a dep to avoid circular calls.
  const opsDeps = {
    ...deps,
    startNativeDownloadFromVideo: null, // populated after core function definition
  };
  const ops = createOperations(opsDeps);

  // ── Core download flow ───────────────────────────────────────────────

  async function startNativeDownload(tabId, videoId, formatId = "best", variantId = "", backend = "auto") {
    await deps.ensureStateLoaded();
    const videos = await deps.getTabVideos(tabId);
    const video = videos.find(
      (item) => item.id === videoId || deps.variantsForVideo(item).some((variant) => variant.id === videoId),
    );

    if (!video) {
      throw new Error("That video URL is no longer in the detected list.");
    }
    const selectedVideo = deps.findVariant(video, variantId || (video.id === videoId ? "" : videoId));
    if (!selectedVideo) {
      throw new Error("That video version is no longer in the detected list.");
    }
    if (!selectedVideo.downloadable) {
      throw new Error(
        "This is a browser-only blob/data URL. Wait for a supported video page, MP4, WebM, M3U8, or MPD URL to appear.",
      );
    }

    const blockingJob = ops.findBlockingDownloadJobForVideo(video, selectedVideo);
    if (blockingJob) {
      return { jobId: blockingJob.id, existing: true };
    }

    return startNativeDownloadFromVideo(
      deps,
      tabId,
      {
        ...selectedVideo,
        groupId: video.id,
        groupVariants: deps.variantsForVideo(video),
        backend: backend || "auto",
      },
      formatId,
      { backend: backend || "auto" },
    );
  }

  async function startNativeDownloadForUrl(tabId, input) {
    const video = await deps.addDetectedVideo(tabId, {
      ...input,
      source: input.source || "overlay",
    });

    if (!video) {
      throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
    }

    return startNativeDownload(
      tabId,
      video.id,
      input.formatId || "best",
      input.variantId || "",
      input.backend || "auto",
    );
  }

  async function getBestDownloadableVideo(tabId) {
    const videos = await deps.getTabVideos(tabId);
    const video = videos.find((item) => item.downloadable);
    if (!video) {
      throw new Error("No downloadable video page, MP4, WebM, M3U8, or MPD URL has been detected for this player yet.");
    }
    return video;
  }

  async function startBestNativeDownload(tabId, formatId = "best", variantId = "") {
    const video = await getBestDownloadableVideo(tabId);
    return startNativeDownload(tabId, video.id, formatId, variantId);
  }

  // Patch opsDeps (internal closures in createOperations) so that
  // resumeDownload/retryDownload see the real function.
  const wrappedStartNativeDownloadFromVideo = (tabId, video, formatId, options) =>
    startNativeDownloadFromVideo(deps, tabId, video, formatId, options);

  opsDeps.startNativeDownloadFromVideo = wrappedStartNativeDownloadFromVideo;

  return {
    ...ops,
    getBestDownloadableVideo,
    startBestNativeDownload,
    startNativeDownload,
    startNativeDownloadForUrl,
    startNativeDownloadFromVideo: wrappedStartNativeDownloadFromVideo,
  };
}

export { create };
