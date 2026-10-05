import { filenameFromVideo } from "../browser_download.js";
import type {
  BrowserDownloadOptions,
  DownloadOrchestratorDeps,
  DownloadStartResult,
  JobPatch,
  TabId,
  VideoRecord,
} from "../types.js";

/**
 * Start a download directly via the browser's chrome.downloads API.
 * Tracks progress and completion via chrome.downloads.onChanged.
 *
 * `deps` is the orchestration bag; only `api`, `updateDownload`, `getDownloadsById`,
 * `normalizeDownloadProgress` and `downloadProgressMessage` are touched here.
 */
/**
 * The saved file's absolute path, or `""` if the item cannot be read back.
 *
 * `chrome.downloads` resolves `filename` for us once the item exists, and nothing
 * else on this backend does. Without it the job keeps an empty `filepath`, which is
 * what hides the popup's Open / Folder buttons — `downloadActions` gates both on it.
 * A failure here is not the download's failure: the bytes are already on disk, so the
 * path is simply unknown and the buttons stay hidden.
 */
async function savedPath(deps: DownloadOrchestratorDeps, id: number | null): Promise<string> {
  if (id === null) {
    return "";
  }
  try {
    const items = await deps.api.downloads.search({ id });
    return String(items?.[0]?.filename || "");
  } catch (_error) {
    return "";
  }
}

export function browserDownload(
  deps: DownloadOrchestratorDeps,
  tabId: TabId,
  video: VideoRecord,
  formatId: string,
  options: BrowserDownloadOptions,
): Promise<DownloadStartResult> {
  const { jobId } = options;
  const filename = filenameFromVideo(video);

  deps.updateDownload(jobId, {
    status: "running",
    message: "Starting browser download...",
    stage: "downloading",
    speed: "",
    eta: "",
  });

  let onChangedHandler: ((delta: chrome.downloads.DownloadDelta) => void) | null = null;
  let downloadId: number | null = null;

  function cleanup(): void {
    if (onChangedHandler) {
      try {
        deps.api.downloads.onChanged.removeListener(onChangedHandler);
      } catch (_e) {
        // ignore
      }
      onChangedHandler = null;
    }
  }

  return new Promise((resolve) => {
    // ── Progress listener ──────────────────────────────────────────
    onChangedHandler = async function (delta) {
      if (delta.id !== downloadId) return;

      if (delta.state && delta.state.current === "complete") {
        cleanup();
        deps.updateDownload(jobId, {
          status: "done",
          percent: 100,
          rawPercent: 100,
          speed: "",
          eta: "",
          stage: "done",
          filepath: await savedPath(deps, downloadId),
          message: "Download complete.",
        });
        resolve({ jobId });
        return;
      }

      if (delta.state && delta.state.current === "interrupted") {
        cleanup();
        const errMsg = delta.error ? delta.error.current || "Unknown error" : "Download interrupted";
        deps.updateDownload(jobId, {
          status: "error",
          error: `Browser download interrupted: ${errMsg}`,
          stage: "",
        });
        resolve({ jobId });
        return;
      }

      // Progress
      const current = deps.getDownloadsById()[jobId] || {};
      // `downloads.onChanged` has reported `bytesReceived` since Chrome 4, but
      // `@types/chrome` omits it from `DownloadDelta`, so it is read off a widened
      // view of the delta. Only the browser-download backend uses it.
      const bytesDelta = (delta as { bytesReceived?: chrome.downloads.DoubleDelta }).bytesReceived;
      const bytesReceived = bytesDelta ? bytesDelta.current : current.rawDownloadedBytes;
      const totalBytes = delta.totalBytes ? delta.totalBytes.current : current.rawTotalBytes;
      if (typeof bytesReceived === "number" || typeof totalBytes === "number") {
        const patch: JobPatch = {};
        if (typeof bytesReceived === "number") patch.rawDownloadedBytes = bytesReceived;
        if (typeof totalBytes === "number") patch.rawTotalBytes = totalBytes;
        if (typeof totalBytes === "number" && totalBytes > 0) {
          const pct = Math.min(100, Math.round(((bytesReceived || 0) / totalBytes) * 100));
          patch.percent = deps.normalizeDownloadProgress(jobId, pct);
          patch.message = deps.downloadProgressMessage(pct);
        }
        deps.updateDownload(jobId, patch);
      }
    };

    // ── Initiate download ──────────────────────────────────────────
    try {
      const api = deps.api;

      function onDownloadStarted(id: number): void {
        downloadId = id;
        try {
          if (onChangedHandler) {
            api.downloads.onChanged.addListener(onChangedHandler);
          }
        } catch (_e) {
          // Downloads.onChanged not supported; no progress tracking
        }
        deps.updateDownload(jobId, {
          status: "running",
          message: "Downloading via browser...",
        });
        resolve({ jobId });
      }

      // The callback overload is the one the manifest's Chromium floor guarantees.
      api.downloads.download({ url: video.url as string, filename, conflictAction: "uniquify" }, function (id) {
        if (api.runtime.lastError) {
          deps.updateDownload(jobId, {
            status: "error",
            error: `Browser download failed: ${api.runtime.lastError.message}`,
          });
          resolve({ jobId });
          return;
        }
        onDownloadStarted(id);
      });
    } catch (error) {
      deps.updateDownload(jobId, {
        status: "error",
        error: `Browser download error: ${(error as Error).message || error}`,
      });
      resolve({ jobId });
    }
  });
}
