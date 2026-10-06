import { createOperations } from "../download_operations.js";
import { startNativeDownloadFromVideo } from "./native.js";
import { createBoundedQueue, type QueueSlot } from "./queue.js";
import type {
  DownloadOrchestratorDeps,
  DownloadStartResult,
  JobPatch,
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

  /**
   * The tab row a download id names: either the row itself or one of its variants.
   *
   * Split out of {@link startDownloadSlot} because `downloadMany` needs the same
   * answer to label the placeholder row it writes for a queued item (spec §4) — a second
   * copy of this lookup would drift the moment variant handling changed.
   */
  async function resolveTabVideo(
    tabId: TabId,
    videoId: string,
    variantId: string,
  ): Promise<{ video: VideoRecord; selected: VideoRecord }> {
    const videos = await deps.getTabVideos(tabId);
    const video = videos.find(
      (item) => item.id === videoId || deps.variantsForVideo(item).some((variant) => variant.id === videoId),
    );

    if (!video) {
      throw new Error("That video URL is no longer in the detected list.");
    }
    const selected = deps.findVariant(video, variantId || (video.id === videoId ? "" : videoId));
    if (!selected) {
      throw new Error("That video version is no longer in the detected list.");
    }
    if (!selected.downloadable) {
      throw new Error(
        "This is a browser-only blob/data URL. Wait for a supported video page, MP4, WebM, M3U8, or MPD URL to appear.",
      );
    }
    return { video, selected };
  }

  /**
   * `startNativeDownload` plus the gate's settle promise and the id the caller already
   * owns. `downloadMany` passes a pre-minted `jobId` so its queued placeholder row is
   * overwritten in place instead of leaving an orphan record behind.
   */
  async function startDownloadSlot(
    tabId: TabId,
    videoId: string,
    formatId = "best",
    variantId = "",
    backend = "auto",
    jobId = "",
  ): Promise<QueueSlot> {
    await deps.ensureStateLoaded();
    const { video, selected } = await resolveTabVideo(tabId, videoId, variantId);

    // The jobId is passed so `downloadMany`'s own `queued` placeholder cannot be mistaken
    // for a duplicate of itself — it is already in the map by the time we get here.
    const blockingJob = ops.findBlockingDownloadJobForVideo(video, selected, jobId);
    if (blockingJob) {
      // Nothing was opened, so nothing is in flight on this row's behalf: the slot is
      // free the moment this returns rather than when the pre-existing job settles.
      return { jobId: blockingJob.id, existing: true, settled: Promise.resolve() };
    }

    // Resolved by `onSettled`, never rejected — a settled-then-failed download is a
    // finished download as far as the gate is concerned.
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });

    const result = await startNativeDownloadFromVideo(
      deps,
      tabId,
      {
        ...selected,
        groupId: video.id,
        groupVariants: deps.variantsForVideo(video),
        backend: backend || "auto",
      },
      formatId,
      { backend: backend || "auto", ...(jobId ? { jobId } : {}), onSettled: markSettled },
    );
    return { jobId: result.jobId, settled };
  }

  async function startNativeDownload(
    tabId: TabId,
    videoId: string,
    formatId = "best",
    variantId = "",
    backend = "auto",
  ): Promise<DownloadStartResult> {
    const slot = await startDownloadSlot(tabId, videoId, formatId, variantId, backend);
    return slot.existing ? { jobId: slot.jobId, existing: true } : { jobId: slot.jobId };
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
  const batchQueue = createBoundedQueue(
    MAX_CONCURRENT_DOWNLOADS,
    (queueTabId, queueVideoId, queueFormatId, queueJobId) =>
      startDownloadSlot(queueTabId, queueVideoId, queueFormatId, "", "auto", queueJobId),
  );

  /**
   * The tray row for an item the gate is still holding (spec §4).
   *
   * Written up front for every item, because a queued download has no record at all
   * until its slot opens — 97 of a 100-item playlist would simply not exist, and the tray
   * would look stalled rather than busy. `DownloadJob` gains no field for this: the
   * status is what `JobRow` renders (`"queued"` → "Queued") and the position rides on
   * the existing `message`.
   */
  function queuedJobPatch(
    tabId: TabId,
    jobId: string,
    found: { video: VideoRecord; selected: VideoRecord },
    position: number,
    total: number,
  ): JobPatch {
    return {
      id: jobId,
      tabId,
      videoId: found.video.id,
      url: found.selected.url,
      format: found.selected.format || deps.detectFormat(found.selected.url || ""),
      title: found.selected.title || deps.titleFromUrl(found.selected.url || ""),
      pageUrl: found.selected.pageUrl || "",
      formatId: "best",
      status: "queued",
      message: `Queued #${position} of ${total}.`,
      ...deps.resetDownloadProgressDetails(),
      percent: null,
      totalSize: "",
      createdAt: Date.now(),
    };
  }

  async function downloadMany(tabId: TabId, videoIds: string[], formatId = "best"): Promise<{ jobIds: string[] }> {
    await deps.ensureStateLoaded();
    const ids = [...new Set(videoIds)].slice(0, 100);
    if (!ids.length) {
      throw new Error("Select at least one video first.");
    }

    // Every id gets a record before any port opens, so the tray reads "Queued" instead of
    // appearing stalled. `startDownloadSlot` is handed the same id and overwrites the
    // placeholder as it starts, so a promoted item never leaves an orphan behind.
    const jobIds = ids.map(() => `job_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const named: Array<{ video: VideoRecord; selected: VideoRecord } | null> = [];
    for (const [index, id] of ids.entries()) {
      let found: { video: VideoRecord; selected: VideoRecord } | null = null;
      try {
        found = await resolveTabVideo(tabId, id, "");
        deps.updateDownload(jobIds[index], queuedJobPatch(tabId, jobIds[index], found, index + 1, ids.length));
      } catch (_error) {
        // Left with no record at all: the row cannot be named any more, and a terminal
        // record here would sync an empty job into history (`updateDownload` syncs every
        // final status). `batchQueue.add` below fails the same way and reports it.
        found = null;
      }
      named.push(found);
    }

    // One entry per id, in selection order, and each is settled-caught: a row that cannot
    // start is its own failure, and an unhandled rejection here would kill the service
    // worker's queue rather than one item.
    const admitted = ids.map((id, index) =>
      batchQueue.add(tabId, id, formatId, jobIds[index]).catch((error: unknown) => {
        // Only a row that already got a placeholder needs the error written; see above.
        if (named[index]) {
          deps.updateDownload(jobIds[index], {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }),
    );

    // Resolve on the FIRST WAVE, not on the batch. `batchDownloadSelection` awaits this
    // message before it clears the selection and switches views, so awaiting all 100
    // would hold the popup pending for the length of the entire playlist. The queue is
    // self-driving from here: each settlement admits the next row.
    const firstWave = await Promise.all(admitted.slice(0, MAX_CONCURRENT_DOWNLOADS));
    const startedJobIds = firstWave.filter((slot): slot is QueueSlot => Boolean(slot)).map((slot) => slot.jobId);
    if (!startedJobIds.length) {
      // Backstop for the invariant the two writes above cannot guarantee between them: a
      // placeholder is only ever promoted by `startNativeDownloadFromVideo`, so any still
      // `queued` record here has no download behind it and would sit in the tray forever.
      // Rows the per-item catch already failed keep their own reason — that is better text
      // than the batch verdict.
      const reason = "None of those downloads could start.";
      named.forEach((found, index) => {
        if (found && deps.getDownloadsById()[jobIds[index]]?.status === "queued") {
          deps.updateDownload(jobIds[index], { status: "error", error: reason });
        }
      });
      throw new Error(reason);
    }
    void Promise.all(admitted);
    return { jobIds: startedJobIds };
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
