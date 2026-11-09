import { filenameFromVideo } from "../browser_download.js";
import { browserApi } from "../../shared/browser_api.js";
import type {
  BrowserDownloadOptions,
  DownloadJobRecord,
  DownloadOrchestratorDeps,
  DownloadStartResult,
  JobPatch,
  TabId,
  VideoRecord,
} from "../types.js";

/** The slice of the orchestration bag the `downloads.onChanged` path reads. */
export type BrowserChangeDeps = Pick<
  DownloadOrchestratorDeps,
  "ensureStateLoaded" | "getDownloadsById" | "updateDownload" | "normalizeDownloadProgress" | "downloadProgressMessage"
>;

/**
 * `chrome.downloads` id → the job it belongs to, plus that job's gate release.
 *
 * Memory only, and deliberately not the source of truth: `job.browserDownloadId` is
 * stored on the record, so after the service worker sleeps (no native port keeps it
 * awake during a browser transfer) {@link handleBrowserDownloadChange} still finds the job
 * by scanning for it. What is lost on a restart is only the release callback, and the
 * startup reconciliation re-occupies a slot for a transfer it finds still running.
 */
const trackedDownloads = new Map<number, { jobId: string; onFinished?: () => void }>();

/** Remember which job a `chrome.downloads` id belongs to, and what to call when it ends. */
export function trackBrowserDownload(downloadId: number, jobId: string, onFinished?: () => void): void {
  trackedDownloads.set(downloadId, { jobId, onFinished });
}

/** Forget a transfer and give its gate slot back. Idempotent. */
export function releaseBrowserDownload(downloadId: number): void {
  const tracked = trackedDownloads.get(downloadId);
  trackedDownloads.delete(downloadId);
  try {
    tracked?.onFinished?.();
  } catch (_error) {
    /* A gate callback must never break the listener that reported the transfer. */
  }
}

/**
 * The saved file's absolute path, or `""` if the item cannot be read back.
 *
 * `chrome.downloads` resolves `filename` for us once the item exists, and nothing
 * else on this backend does. Without it the job keeps an empty `filepath`, which is
 * what hides the popup's Open / Folder buttons — `downloadActions` gates both on it.
 * A failure here is not the download's failure: the bytes are already on disk, so the
 * path is simply unknown and the buttons stay hidden.
 */
async function savedPath(id: number): Promise<string> {
  const items = await browserApi.downloads.search({ id });
  return String(items?.[0]?.filename || "");
}

/** A canceled row stays canceled: a late `complete` must not resurrect it as `done`. */
function isCanceling(job: DownloadJobRecord | undefined): boolean {
  return job?.status === "canceled" || job?.status === "canceling";
}

/**
 * Apply one `downloads.onChanged` delta to the job that owns it.
 *
 * Registered ONCE, synchronously, at service-worker startup (`background.ts`) — MV3
 * drops a listener added inside a later callback when the worker sleeps, which is how a
 * browser transfer used to finish with its row stuck on `running`. Unknown ids are not
 * ours (the user's own downloads fire this event too) and are ignored.
 */
export async function handleBrowserDownloadChange(
  deps: BrowserChangeDeps,
  delta: chrome.downloads.DownloadDelta,
): Promise<void> {
  await deps.ensureStateLoaded();
  const jobs = deps.getDownloadsById();
  const jobId =
    trackedDownloads.get(delta.id)?.jobId ||
    Object.values(jobs).find((job) => job && job.browserDownloadId === delta.id)?.id;
  if (!jobId) {
    return;
  }
  const job = jobs[jobId];
  const state = delta.state?.current;

  if (state === "complete") {
    releaseBrowserDownload(delta.id);
    if (isCanceling(job)) {
      deps.updateDownload(jobId, { status: "canceled", message: "Download canceled." });
      return;
    }
    deps.updateDownload(jobId, {
      status: "done",
      percent: 100,
      rawPercent: 100,
      speed: "",
      eta: "",
      stage: "done",
      filepath: delta.filename?.current || (await savedPath(delta.id)) || job?.filepath || "",
      message: "Download complete.",
    });
    return;
  }

  if (state === "interrupted") {
    releaseBrowserDownload(delta.id);
    const reason = delta.error?.current || "";
    if (isCanceling(job) || reason === "USER_CANCELED") {
      deps.updateDownload(jobId, { status: "canceled", stage: "", message: "Download canceled." });
      return;
    }
    deps.updateDownload(jobId, {
      status: "error",
      stage: "",
      error: `Browser download interrupted: ${reason || "Unknown error"}`,
    });
    return;
  }

  if (!job || ["done", "error", "canceled"].includes(String(job.status))) {
    return;
  }

  const patch: JobPatch = {};
  if (delta.filename?.current) {
    patch.filepath = delta.filename.current;
  }
  if (delta.paused && !isCanceling(job)) {
    patch.status = delta.paused.current ? "paused" : "running";
    patch.message = delta.paused.current ? "Download paused." : "Downloading via browser...";
  }

  // `downloads.onChanged` has reported `bytesReceived` since Chrome 4, but
  // `@types/chrome` omits it from `DownloadDelta`, so it is read off a widened view of
  // the delta. Only the browser-download backend uses it.
  const bytesDelta = (delta as { bytesReceived?: chrome.downloads.DoubleDelta }).bytesReceived;
  const bytesReceived = bytesDelta ? bytesDelta.current : job.rawDownloadedBytes;
  const totalBytes = delta.totalBytes ? delta.totalBytes.current : job.rawTotalBytes;
  if (bytesDelta || delta.totalBytes) {
    if (typeof bytesReceived === "number") patch.rawDownloadedBytes = bytesReceived;
    if (typeof totalBytes === "number") patch.rawTotalBytes = totalBytes;
    if (typeof totalBytes === "number" && totalBytes > 0) {
      const pct = Math.min(100, Math.round(((bytesReceived || 0) / totalBytes) * 100));
      patch.percent = deps.normalizeDownloadProgress(jobId, pct);
      if (!patch.message) {
        patch.message = deps.downloadProgressMessage(pct);
      }
    }
  }
  if (Object.keys(patch).length) {
    deps.updateDownload(jobId, patch);
  }
}

/**
 * The job patch for a transfer the browser already finished, paused or lost while the
 * service worker was not listening — the startup reconciliation's half of
 * {@link handleBrowserDownloadChange}. `null` means "still running": the caller keeps
 * the row active and re-tracks it.
 */
export function patchForBrowserItem(
  job: DownloadJobRecord,
  item: chrome.downloads.DownloadItem | undefined,
): JobPatch | null {
  if (!item) {
    return isCanceling(job)
      ? { status: "canceled", message: "Download canceled." }
      : { status: "error", stage: "", error: "The browser no longer has this download." };
  }
  if (item.state === "complete") {
    return isCanceling(job)
      ? { status: "canceled", message: "Download canceled." }
      : {
          status: "done",
          percent: 100,
          rawPercent: 100,
          speed: "",
          eta: "",
          stage: "done",
          filepath: item.filename || job.filepath || "",
          message: "Download complete.",
        };
  }
  if (item.state === "interrupted") {
    return isCanceling(job) || item.error === "USER_CANCELED"
      ? { status: "canceled", stage: "", message: "Download canceled." }
      : { status: "error", stage: "", error: `Browser download interrupted: ${item.error || "Unknown error"}` };
  }
  if (item.paused) {
    return { status: "paused", message: "Download paused." };
  }
  return null;
}

/**
 * Start a download directly via the browser's chrome.downloads API.
 *
 * Progress and the end of the transfer arrive through {@link handleBrowserDownloadChange};
 * this only starts it, stamps `browserDownloadId` on the job (which is what lets Pause /
 * Resume / Cancel reach it — `download_operations.ts`), and hands the gate's release to
 * the tracker so the slot is held until the transfer ends, not until it starts.
 */
export function browserDownload(
  deps: DownloadOrchestratorDeps,
  _tabId: TabId,
  video: VideoRecord,
  _formatId: string,
  options: BrowserDownloadOptions,
): Promise<DownloadStartResult> {
  const { jobId } = options;
  const filename = filenameFromVideo(video);
  const finish = (): void => {
    try {
      options.onFinished?.();
    } catch (_error) {
      /* see releaseBrowserDownload */
    }
  };

  deps.updateDownload(jobId, {
    status: "running",
    message: "Starting browser download...",
    stage: "downloading",
    speed: "",
    eta: "",
  });

  return new Promise((resolve) => {
    try {
      const api = deps.api;
      // The callback overload is the one the manifest's Chromium floor guarantees.
      api.downloads.download({ url: video.url as string, filename, conflictAction: "uniquify" }, function (id) {
        if (api.runtime.lastError || typeof id !== "number") {
          deps.updateDownload(jobId, {
            status: "error",
            error: `Browser download failed: ${api.runtime.lastError?.message || "no download was created"}`,
          });
          finish();
          resolve({ jobId });
          return;
        }
        trackBrowserDownload(id, jobId, options.onFinished);
        // Cancelled while the browser was still creating the item: there was no id to
        // cancel then, so cancel it now rather than let it run behind a canceled row.
        if (isCanceling(deps.getDownloadsById()[jobId])) {
          deps.updateDownload(jobId, { browserDownloadId: id, status: "canceled", message: "Download canceled." });
          releaseBrowserDownload(id);
          void browserApi.downloads.cancel(id);
          resolve({ jobId });
          return;
        }
        deps.updateDownload(jobId, {
          browserDownloadId: id,
          status: "running",
          message: "Downloading via browser...",
        });
        resolve({ jobId });
      });
    } catch (error) {
      deps.updateDownload(jobId, {
        status: "error",
        error: `Browser download error: ${(error as Error).message || error}`,
      });
      finish();
      resolve({ jobId });
    }
  });
}
