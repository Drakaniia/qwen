import { createOperations } from "../download_operations.js";
import { INTERRUPTED_MESSAGE, startNativeDownloadFromVideo } from "./native.js";
import { createDownloadQueue, type QueueSlot, type QueueTicket } from "./queue.js";
import { handleBrowserDownloadChange, patchForBrowserItem, trackBrowserDownload } from "./browser.js";
import { browserApi } from "../../shared/browser_api.js";
import { clampConcurrency } from "../../shared/contracts.js";
import { ACTIVE_DOWNLOAD_STATUSES } from "../../shared/download_statuses.js";
import type {
  DownloadJobRecord,
  DownloadOrchestratorDeps,
  DownloadStartResult,
  JobPatch,
  NativeDownloadOptions,
  TabId,
  VideoRecord,
} from "../types.js";

/**
 * Past this many items ahead the row stops counting. Every release renumbers the line,
 * and a 100-item playlist would otherwise broadcast ~100 `downloadUpdated`s per settled
 * job just to move each number down by one; capped, a release rewrites at most this many.
 */
const WAITING_COUNT_CAP = 20;

/** The `queued` row's message. The position rides on `message`; `DownloadJob` gains no field for it. */
function waitingMessage(ahead: number): string {
  if (ahead <= 0) {
    return "Waiting for a free slot.";
  }
  if (ahead >= WAITING_COUNT_CAP) {
    return `Waiting for a free slot (${WAITING_COUNT_CAP}+ ahead).`;
  }
  return `Waiting for a free slot (${ahead} ahead).`;
}

function mintJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Create a download orchestrator with all download-related functions.
 *
 * @param deps - Dependency object injected by the caller (background.ts).
 * @returns Public API with download control methods.
 */
function create(deps: DownloadOrchestratorDeps) {
  // Anything stored with an older `updatedAt` than this was written by a previous
  // service-worker lifetime — the only jobs the startup reconciliation may touch.
  const workerStartedAt = Date.now();

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

  // ── The gate ─────────────────────────────────────────────────────────
  //
  // One queue for every path that starts a transfer. It used to gate `downloadMany`
  // only, at a hardcoded 3, so a click, a pasted URL, a retry or a resume all ran past
  // it. The limit is read live from `Settings.maxConcurrentDownloads` on each admission.

  const queue = createDownloadQueue(
    () => clampConcurrency(deps.getSettings().maxConcurrentDownloads),
    (waitingJobIds) => {
      const jobs = deps.getDownloadsById();
      waitingJobIds.forEach((jobId, ahead) => {
        const job = jobs[jobId];
        const message = waitingMessage(ahead);
        if (job && job.status === "queued" && job.message !== message) {
          deps.updateDownload(jobId, { message });
        }
      });
    },
  );
  opsDeps.withdrawQueuedDownload = (jobId) => queue.withdraw(jobId);

  /**
   * `startNativeDownloadFromVideo`, plus the settle promise the gate holds its slot on.
   * Resolved by `onSettled`, never rejected — a settled-then-failed download is a
   * finished download as far as the gate is concerned.
   */
  async function startWithSlot(
    tabId: TabId,
    video: VideoRecord,
    formatId: string,
    options: NativeDownloadOptions,
  ): Promise<QueueSlot> {
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const result = await startNativeDownloadFromVideo(deps, tabId, video, formatId, {
      ...options,
      onSettled: markSettled,
    });
    return { jobId: result.jobId, settled };
  }

  /**
   * Hand one job to the gate. When every slot is taken it gets its `queued` row right
   * now (the same treatment `downloadMany`'s placeholders get, spec §4) — a waiting job
   * with no record would look like a click that did nothing.
   *
   * A job that waited is re-checked when its slot opens: if anything moved it off
   * `queued` in the meantime (removed, or a cancel that raced the withdraw), it is
   * skipped rather than started over the top of that decision.
   */
  function admit(jobId: string, start: () => Promise<QueueSlot>, placeholder: () => JobPatch): QueueTicket {
    const ticket = queue.add(jobId, (waited) => {
      if (waited && deps.getDownloadsById()[jobId]?.status !== "queued") {
        return Promise.resolve({ jobId, settled: Promise.resolve() });
      }
      return start();
    });
    if (ticket.queued) {
      deps.updateDownload(jobId, { ...placeholder(), status: "queued", message: waitingMessage(ticket.ahead) });
    }
    return ticket;
  }

  /** The `queued` row for a job that has no record yet; an existing record only loses its old error. */
  function placeholderFor(tabId: TabId, jobId: string, video: VideoRecord, formatId: string): JobPatch {
    if (deps.getDownloadsById()[jobId]) {
      return { error: "" };
    }
    return {
      id: jobId,
      tabId,
      videoId: video.groupId || video.id,
      variantId: video.groupId ? video.id : "",
      url: video.url,
      format: video.format || deps.detectFormat(video.url || ""),
      title: video.title || deps.titleFromUrl(video.url || ""),
      pageUrl: video.pageUrl || "",
      formatId: formatId || "best",
      backend: video.backend || "auto",
      ...deps.resetDownloadProgressDetails(),
      percent: null,
      totalSize: "",
      createdAt: Date.now(),
    };
  }

  /**
   * The gated form of `startNativeDownloadFromVideo` — what retry, resume and the startup
   * re-admission call. Answers as soon as the job is either started or queued: a popup
   * awaiting a busy gate would otherwise hang until some other download finished.
   */
  async function startGated(
    tabId: TabId,
    video: VideoRecord,
    formatId: string,
    options: NativeDownloadOptions,
  ): Promise<DownloadStartResult> {
    const jobId = options.jobId || mintJobId();
    const ticket = admit(
      jobId,
      () => startWithSlot(tabId, video, formatId, { ...options, jobId }),
      () => placeholderFor(tabId, jobId, video, formatId),
    );
    if (ticket.queued) {
      return { jobId };
    }
    const slot = await ticket.slot;
    return { jobId: slot?.jobId || jobId };
  }

  // ── Core download flow ───────────────────────────────────────────────

  /**
   * The tab row a download id names: either the row itself or one of its variants.
   *
   * Split out because `downloadMany` needs the same answer to label the placeholder row
   * it writes for every item (spec §4) — a second copy of this lookup would drift the
   * moment variant handling changed.
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

  /** A resolved row, admitted to the gate — or the in-flight job it duplicates. */
  interface Admission {
    jobId: string;
    existing?: boolean;
    queued: boolean;
    slot: Promise<QueueSlot | null>;
  }

  /**
   * Synchronous on purpose: `downloadMany` admits its whole selection in one turn, so the
   * line keeps selection order instead of the order a dozen awaits happened to resolve in.
   * `jobId` is the id a caller already wrote a placeholder under (`downloadMany`), so the
   * row is overwritten in place instead of leaving an orphan record behind.
   */
  function admitResolved(
    tabId: TabId,
    found: { video: VideoRecord; selected: VideoRecord },
    formatId: string,
    backend: string,
    jobId = "",
  ): Admission {
    const { video, selected } = found;
    // The jobId is passed so `downloadMany`'s own `queued` placeholder cannot be mistaken
    // for a duplicate of itself — it is already in the map by the time we get here.
    const blockingJob = ops.findBlockingDownloadJobForVideo(video, selected, jobId);
    if (blockingJob) {
      // Nothing was opened, so nothing is in flight on this row's behalf.
      const reused = { jobId: blockingJob.id, existing: true, settled: Promise.resolve() };
      return { jobId: blockingJob.id, existing: true, queued: false, slot: Promise.resolve(reused) };
    }

    const id = jobId || mintJobId();
    const target: VideoRecord = {
      ...selected,
      groupId: video.id,
      groupVariants: deps.variantsForVideo(video),
      backend: backend || "auto",
    };
    const ticket = admit(
      id,
      () => startWithSlot(tabId, target, formatId, { backend: backend || "auto", jobId: id }),
      () => placeholderFor(tabId, id, target, formatId),
    );
    return { jobId: id, queued: ticket.queued, slot: ticket.slot };
  }

  async function startNativeDownload(
    tabId: TabId,
    videoId: string,
    formatId = "best",
    variantId = "",
    backend = "auto",
  ): Promise<DownloadStartResult> {
    await deps.ensureStateLoaded();
    const found = await resolveTabVideo(tabId, videoId, variantId);
    const admission = admitResolved(tabId, found, formatId, backend);
    if (admission.existing) {
      return { jobId: admission.jobId, existing: true };
    }
    if (!admission.queued) {
      await admission.slot;
    }
    return { jobId: admission.jobId };
  }

  async function startNativeDownloadForUrl(
    tabId: TabId,
    input: Parameters<DownloadOrchestratorDeps["addDetectedVideo"]>[1],
  ): Promise<DownloadStartResult> {
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

  async function downloadMany(tabId: TabId, videoIds: string[], formatId = "best"): Promise<{ jobIds: string[] }> {
    await deps.ensureStateLoaded();
    const ids = [...new Set(videoIds)].slice(0, 100);
    if (!ids.length) {
      throw new Error("Select at least one video first.");
    }

    // Every id gets a record before any port opens, so the tray reads "Queued" instead of
    // appearing stalled. The starter is handed the same id and overwrites the placeholder
    // as it starts, so a promoted item never leaves an orphan behind.
    const jobIds = ids.map(() => mintJobId());
    const named: Array<{ video: VideoRecord; selected: VideoRecord } | null> = [];
    for (const [index, id] of ids.entries()) {
      let found: { video: VideoRecord; selected: VideoRecord } | null = null;
      try {
        found = await resolveTabVideo(tabId, id, "");
        const target = { ...found.selected, groupId: found.video.id };
        deps.updateDownload(jobIds[index], {
          ...placeholderFor(tabId, jobIds[index], target, formatId),
          status: "queued",
          message: waitingMessage(index),
        });
      } catch (_error) {
        // Left with no record at all: the row cannot be named any more, and a terminal
        // record here would sync an empty job into history (`updateDownload` syncs every
        // final status).
        found = null;
      }
      named.push(found);
    }

    // One admission per named id, in selection order, each settled-caught: a row that
    // cannot start is its own failure, and an unhandled rejection here would kill the
    // service worker's queue rather than one item.
    const admissions = named.map((found, index) =>
      found ? admitResolved(tabId, found, formatId, "auto", jobIds[index]) : null,
    );
    const outcomes = admissions.map((admission, index) =>
      admission
        ? admission.slot.catch((error: unknown) => {
            deps.updateDownload(jobIds[index], {
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
        : Promise.resolve(null),
    );

    // Resolve on the FIRST WAVE — the items that got a free slot right now — not on the
    // batch. `batchDownloadSelection` awaits this message before it clears the selection
    // and switches views, so awaiting all 100 would hold the popup pending for the length
    // of the entire playlist. The gate is self-driving from here.
    const firstWave = admissions.flatMap((admission, index) => (admission && !admission.queued ? [index] : []));
    const waitingIndexes = admissions.flatMap((admission, index) => (admission && admission.queued ? [index] : []));
    const startedSlots = await Promise.all(firstWave.map((index) => outcomes[index]));
    const startedJobIds = startedSlots.filter((slot): slot is QueueSlot => Boolean(slot)).map((slot) => slot.jobId);

    if (!startedJobIds.length && (firstWave.length || !waitingIndexes.length)) {
      // Everything that got a slot failed (or nothing could even be named). The rows
      // still waiting would only fail the same way later, so they are taken out of the
      // line and told now; rows the per-item catch already failed keep their own reason.
      const reason = "None of those downloads could start.";
      named.forEach((found, index) => {
        if (!found) {
          return;
        }
        queue.withdraw(jobIds[index]);
        if (deps.getDownloadsById()[jobIds[index]]?.status === "queued") {
          deps.updateDownload(jobIds[index], { status: "error", error: reason });
        }
      });
      throw new Error(reason);
    }
    void Promise.all(outcomes);
    // Every slot was busy with other downloads: the whole batch is waiting, and its ids
    // are the honest answer — the rows exist and say so.
    return { jobIds: startedJobIds.length ? startedJobIds : waitingIndexes.map((index) => jobIds[index]) };
  }

  // ── Browser-path transfers ───────────────────────────────────────────

  /** The one `downloads.onChanged` entry point; `background.ts` registers it at top level. */
  function onBrowserDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
    return handleBrowserDownloadChange(deps, delta).catch((error: unknown) => {
      console.warn("[qwin] downloads.onChanged handling failed:", error);
    });
  }

  // ── Startup reconciliation ───────────────────────────────────────────

  async function reconcileBrowserJob(job: DownloadJobRecord, downloadId: number): Promise<void> {
    const [item] = await browserApi.downloads.search({ id: downloadId });
    if (job.status === "canceling" && item && item.state === "in_progress") {
      await browserApi.downloads.cancel(downloadId);
      deps.updateDownload(job.id, { status: "canceled", stage: "", message: "Download canceled." });
      return;
    }
    const patch = patchForBrowserItem(job, item);
    if (patch) {
      deps.updateDownload(job.id, patch);
      return;
    }
    // Still transferring. The global `downloads.onChanged` listener already reaches it
    // through `browserDownloadId`; re-tracking it here is what makes it count against the
    // gate again, so a restart cannot let the next item in on top of it.
    trackBrowserDownload(downloadId, job.id, queue.occupy());
    if (job.status !== "running") {
      deps.updateDownload(job.id, { status: "running", message: "Downloading via browser..." });
    }
  }

  let reconciliation: Promise<void> | null = null;

  /**
   * Settle every job a previous service-worker lifetime left "active".
   *
   * A worker restart or a browser crash drops every native port and the in-memory gate,
   * so stored `running` rows used to stay active forever: Pause threw "not active
   * anymore" and Retry refused an "active" job. The mapping:
   *
   * - native `running` / `connecting` / `pausing` → `paused`, {@link INTERRUPTED_MESSAGE}.
   *   yt-dlp keeps its `.part` files and Resume relaunches with `resume: true`.
   * - `canceling` → `canceled` (a browser transfer still running is canceled first).
   * - `queued` → re-admitted to the gate in `createdAt` order. It never started, so there
   *   is nothing to resume and nothing to lose.
   * - browser path (`browserDownloadId`) → whatever `chrome.downloads` says now:
   *   complete → done, interrupted → error (or canceled), paused → paused, still in
   *   progress → kept running and re-tracked.
   *
   * Runs once per worker lifetime; repeat calls share the first run.
   */
  function reconcileInterruptedJobs(): Promise<void> {
    if (!reconciliation) {
      reconciliation = (async () => {
        await deps.ensureStateLoaded();
        const stale = Object.values(deps.getDownloadsById()).filter(
          (job) =>
            job &&
            job.id &&
            ACTIVE_DOWNLOAD_STATUSES.has(String(job.status)) &&
            Number(job.updatedAt || 0) < workerStartedAt &&
            !deps.downloadPortsById[job.id],
        );
        const requeue: DownloadJobRecord[] = [];
        for (const job of stale) {
          if (job.status === "queued") {
            requeue.push(job);
          } else if (typeof job.browserDownloadId === "number") {
            await reconcileBrowserJob(job, job.browserDownloadId);
          } else if (job.status === "canceling") {
            deps.updateDownload(job.id, { status: "canceled", stage: "", message: "Download canceled." });
          } else if (job.status !== "paused") {
            deps.updateDownload(job.id, { status: "paused", speed: "", eta: "", message: INTERRUPTED_MESSAGE });
          }
        }
        requeue.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
        for (const job of requeue) {
          if (!job.url) {
            deps.updateDownload(job.id, { status: "error", error: "That download does not have a URL to start." });
            continue;
          }
          void startGated(job.tabId, ops.videoFromDownloadJob(job), job.formatId || "best", {
            jobId: job.id,
            backend: job.backend || "auto",
          }).catch((error: unknown) => {
            deps.updateDownload(job.id, { status: "error", error: (error as Error)?.message || String(error) });
          });
        }
      })();
    }
    return reconciliation;
  }

  // Patch opsDeps (internal closures in createOperations) so that resume/retry go
  // through the same gate as every other start.
  opsDeps.startNativeDownloadFromVideo = startGated;

  return {
    ...ops,
    getBestDownloadableVideo,
    startBestNativeDownload,
    startNativeDownload,
    startNativeDownloadForUrl,
    downloadMany,
    onBrowserDownloadChanged,
    reconcileInterruptedJobs,
  };
}

export { create };
