import { createOperations } from "../download_operations.js";
import { startNativeDownloadFromVideo } from "./native.js";
import { createBoundedQueue } from "./queue.js";
import type {
  DownloadOrchestratorDeps,
  DownloadStartResult,
  NativeDownloadOptions,
  TabId,
  VideoInput,
  VideoRecord,
} from "../types.js";

/**
 * Create a download orchestrator with all download-related functions.
 *
 * @param deps - Dependency object injected by the caller (background.ts).
 * @returns Public API with download control methods.
 */
function create(deps: DownloadOrchestratorDeps) {
  // ── Operations (download control, file ops, management) ──────────────
  // These receive startNativeDownloadFromVideo as a dep to avoid circular calls.
  const opsDeps: DownloadOrchestratorDeps = {
    ...deps,
    // Replaced below with the real function once it is in scope. `createOperations`
    // only reads it lazily — inside resume/retry, which cannot run before
    // background.ts finishes wiring this module — so the placeholder never fires.
    startNativeDownloadFromVideo: () => {
      throw new Error("download/index.ts: startNativeDownloadFromVideo was not wired up.");
    },
  };
  const ops = createOperations(opsDeps);

  // ── Core download flow ───────────────────────────────────────────────

  async function startNativeDownload(
    tabId: TabId,
    videoId: string,
    formatId = "best",
    variantId = "",
    backend = "auto",
  ): Promise<DownloadStartResult> {
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

  async function startNativeDownloadForUrl(tabId: TabId, input: VideoInput): Promise<DownloadStartResult> {
    const video = await deps.addDetectedVideo(tabId, {
      ...input,
      source: input.source || "overlay",
    });

    if (!video) {
      throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
    }

    return startNativeDownload(
      tabId,
      video.id as string,
      input.formatId || "best",
      input.variantId || "",
      input.backend || "auto",
    );
  }

  async function getBestDownloadableVideo(tabId: TabId): Promise<VideoRecord> {
    const videos = await deps.getTabVideos(tabId);
    const video = videos.find((item) => item.downloadable);
    if (!video) {
      throw new Error("No downloadable video page, MP4, WebM, M3U8, or MPD URL has been detected for this player yet.");
    }
    return video;
  }

  async function startBestNativeDownload(
    tabId: TabId,
    formatId = "best",
    variantId = "",
  ): Promise<DownloadStartResult> {
    const video = await getBestDownloadableVideo(tabId);
    return startNativeDownload(tabId, video.id as string, formatId, variantId);
  }

  const MAX_CONCURRENT_DOWNLOADS = 3;
  const batchQueue = createBoundedQueue(MAX_CONCURRENT_DOWNLOADS, (queueTabId, queueVideoId, queueFormatId) =>
    startNativeDownload(queueTabId, queueVideoId, queueFormatId),
  );

  async function downloadMany(tabId: TabId, videoIds: string[], formatId = "best"): Promise<{ jobIds: string[] }> {
    await deps.ensureStateLoaded();
    const ids = [...new Set(videoIds)].slice(0, 100);
    if (!ids.length) {
      throw new Error("Select at least one video first.");
    }
    const started = await Promise.allSettled(ids.map((id) => batchQueue.add(tabId, id, formatId)));
    const jobIds: string[] = [];
    for (const result of started) {
      if (result.status === "fulfilled") {
        jobIds.push(result.value.jobId);
      }
    }
    if (!jobIds.length) {
      throw new Error("None of those downloads could start.");
    }
    return { jobIds };
  }

  // Patch opsDeps (internal closures in createOperations) so that
  // resumeDownload/retryDownload see the real function.
  const wrappedStartNativeDownloadFromVideo = (
    tabId: TabId,
    video: VideoRecord,
    formatId: string,
    options: NativeDownloadOptions,
  ) => startNativeDownloadFromVideo(deps, tabId, video, formatId, options);

  opsDeps.startNativeDownloadFromVideo = wrappedStartNativeDownloadFromVideo;

  return {
    ...ops,
    getBestDownloadableVideo,
    startBestNativeDownload,
    startNativeDownload,
    startNativeDownloadForUrl,
    downloadMany,
    startNativeDownloadFromVideo: wrappedStartNativeDownloadFromVideo,
  };
}

export { create };
