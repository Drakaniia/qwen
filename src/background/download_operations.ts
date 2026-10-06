/**
 * Download Control & File Operations
 *
 * Download management, control commands (pause/resume/cancel/retry),
 * file operations (open/choose folder), and download list management.
 *
 * Extracted from download_orchestration.ts for modularity.
 * Receives core download functions via `deps` to avoid circular imports.
 */

import { ACTIVE_DOWNLOAD_STATUSES } from "../shared/download_statuses.js";
import type {
  BackgroundSettings,
  DownloadJobRecord,
  DownloadOrchestratorDeps,
  DownloadStartResult,
  FolderChoiceResult,
  NativeFileCommand,
  TabId,
  VideoInput,
  VideoRecord,
} from "./types.js";

export function createOperations(deps: DownloadOrchestratorDeps) {
  function settings(): BackgroundSettings {
    return deps.getSettings();
  }

  function downloadsById(): Record<string, DownloadJobRecord> {
    return deps.getDownloadsById();
  }

  function isBlockingDownloadStatus(status?: string): boolean {
    return deps.blockingDownloadStatuses.has(status || "queued");
  }

  /**
   * The in-flight job already downloading this video, if any.
   *
   * `ignoreJobId` is the id the caller has ALREADY written a record under. `downloadMany`
   * writes every item's placeholder as `status: "queued"` before the gate admits it
   * (spec §4), and "queued" is a blocking status — so without this the row matched itself,
   * came back `existing: true`, opened no native port, and reported success for a playlist
   * where nothing ran. Excluded by id rather than by status, so a genuinely different job
   * on the same video still blocks. Empty (the single-video flow) changes nothing.
   */
  function findBlockingDownloadJobForVideo(
    video: VideoRecord,
    selectedVideo: VideoRecord,
    ignoreJobId = "",
  ): DownloadJobRecord | undefined {
    const ids = new Set<string>();
    for (const value of [video?.id, video?.groupId, selectedVideo?.id, selectedVideo?.groupId]) {
      if (value) {
        ids.add(value);
      }
    }
    const selectedUrl = deps.normalizeUrl(selectedVideo?.url || "");

    return Object.values(downloadsById()).find((job) => {
      if (!job || !isBlockingDownloadStatus(job.status)) {
        return false;
      }
      if (ignoreJobId && job.id === ignoreJobId) {
        return false;
      }
      if ((job.videoId && ids.has(job.videoId)) || (job.variantId && ids.has(job.variantId))) {
        return true;
      }
      return Boolean(selectedUrl) && deps.normalizeUrl(job.url || "") === selectedUrl;
    });
  }

  function getDownloadJob(jobId: string): DownloadJobRecord {
    const job = downloadsById()[jobId];
    if (!job) {
      throw new Error("That download is no longer in the history.");
    }
    return job;
  }

  function videoFromDownloadJob(job: DownloadJobRecord): VideoRecord {
    const video: VideoInput = {
      id: job.videoId || deps.hashId(job.url as string),
      url: job.url,
      format: job.format || deps.detectFormat(job.url as string),
      title: job.title || deps.titleFromUrl(job.url as string),
      pageUrl: job.pageUrl || "",
      // Rebuilding the video from the job is the only art a resume/retry has: the
      // tab's record is gone by then, and the memory-only captures (D10) went with
      // the service worker. `download/native.ts` stamps this back onto the job.
      thumbnailUrl: job.thumbnailUrl || "",
      requestHeaders: job.requestHeaders || [],
      downloadable: true,
    };
    if (deps.videoFilters.isBlockedVideoUrl(video.url as string, job.contentType || "")) {
      return (
        deps.pageFallbackVideoForSource(video as VideoRecord, new Set([deps.normalizeUrl(video.url || "")])) ||
        (video as VideoRecord)
      );
    }
    return video as VideoRecord;
  }

  function controlActiveDownload(jobId: string, nativeType: string): { jobId: string } {
    const port = deps.downloadPortsById[jobId];
    if (!port) {
      throw new Error("That download is not active anymore. Use Retry to start it again.");
    }

    const nextStatus: Record<string, string> = {
      pause: "pausing",
      resume: "running",
      cancel: "canceling",
    };
    const nextMessage: Record<string, string> = {
      pause: "Pausing download...",
      resume: "Resuming download...",
      cancel: "Canceling download...",
    };

    deps.updateDownload(jobId, {
      status: nextStatus[nativeType] || downloadsById()[jobId]?.status || "running",
      message: nextMessage[nativeType] || "Sending download command...",
    });
    if (nativeType === "pause") {
      port.postMessage({ type: "pause", id: jobId });
    } else if (nativeType === "resume") {
      port.postMessage({ type: "resume", id: jobId });
    } else if (nativeType === "cancel") {
      port.postMessage({ type: "cancel", id: jobId });
    }
    return { jobId };
  }

  async function resumeDownload(tabId: TabId, jobId: string): Promise<DownloadStartResult> {
    await deps.ensureStateLoaded();
    if (deps.downloadPortsById[jobId]) {
      return controlActiveDownload(jobId, "resume");
    }

    const job = getDownloadJob(jobId);
    if (job.status !== "paused") {
      throw new Error("That download is not paused.");
    }
    if (!job.url) {
      throw new Error("That download does not have a URL to resume.");
    }

    return deps.startNativeDownloadFromVideo(job.tabId || tabId, videoFromDownloadJob(job), job.formatId || "best", {
      jobId,
      resume: true,
      backend: job.backend || "auto",
    }) as Promise<DownloadStartResult>;
  }

  async function cancelDownload(_tabId: TabId, jobId: string): Promise<{ jobId: string }> {
    await deps.ensureStateLoaded();
    if (deps.downloadPortsById[jobId]) {
      return controlActiveDownload(jobId, "cancel");
    }

    const job = getDownloadJob(jobId);
    if (["done", "error", "canceled"].includes(job.status as string)) {
      throw new Error("This download is no longer active.");
    }

    const cleanupPatch = await deps.cleanupDownloadArtifacts(jobId, job);
    deps.updateDownload(jobId, {
      status: "canceled",
      message: cleanupPatch.artifactCleanupError
        ? `Download canceled. Could not clean leftover files: ${cleanupPatch.artifactCleanupError}`
        : "Download canceled. No active helper connection remained.",
      ...cleanupPatch,
      ...deps.clearedArtifactPatch(cleanupPatch),
    });
    return { jobId };
  }

  async function retryDownload(tabId: TabId, jobId: string): Promise<DownloadStartResult> {
    await deps.ensureStateLoaded();
    const job = getDownloadJob(jobId);
    if (ACTIVE_DOWNLOAD_STATUSES.has(job.status as string)) {
      throw new Error("That download is still active. Cancel it or wait before retrying.");
    }
    if (!job.url) {
      throw new Error("That download does not have a URL to retry.");
    }

    return deps.startNativeDownloadFromVideo(job.tabId || tabId, videoFromDownloadJob(job), job.formatId || "best", {
      backend: job.backend || "auto",
    }) as Promise<DownloadStartResult>;
  }

  async function openDownloadedPath(jobId: string, nativeType: NativeFileCommand): Promise<{ jobId: string }> {
    await deps.ensureStateLoaded();
    const job = getDownloadJob(jobId);
    // The job's own path when it has one, else the folder it was downloading into.
    // The native side opens a directory as a folder, so this is what backs the tray's
    // `open-folder` fallback — a finished row whose path was never stamped (every job
    // predating that, plus the browser-download backend) still leads somewhere useful
    // instead of to an error toast.
    const path = job.filepath || job.downloadFolder || settings().downloadFolder;
    if (!path) {
      throw new Error("That download has no saved file path yet.");
    }

    const requestId = `open_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload =
      nativeType === "openFile" ? { type: "openFile", id: requestId, path } : { type: "showFile", id: requestId, path };

    await deps.nativeRequest(payload, 10000);
    return { jobId };
  }

  async function chooseDownloadFolder(): Promise<FolderChoiceResult> {
    await deps.ensureStateLoaded();
    const requestId = `folder_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const response = await deps.nativeRequest(
      {
        type: "chooseFolder",
        id: requestId,
        initialFolder: settings().downloadFolder || "",
      },
      600000,
    );

    const selectedPath = String(response.path || "").trim();
    if (response.canceled || !selectedPath) {
      return { canceled: true, settings: settings() };
    }

    deps.setSettings({ ...settings(), downloadFolder: selectedPath });
    await deps.persistSettings();
    return { path: selectedPath, settings: settings() };
  }

  async function removeDownload(jobId: string): Promise<{ jobId: string }> {
    await deps.ensureStateLoaded();
    const job = getDownloadJob(jobId);
    if (deps.downloadPortsById[jobId]) {
      throw new Error("Cancel the active download before removing it.");
    }
    if (job.filepath || job.artifactRoot || (Array.isArray(job.artifactPaths) && job.artifactPaths.length)) {
      const requestId = `delete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await deps.nativeRequest(
        {
          type: "deleteArtifacts",
          id: requestId,
          path: job.filepath || "",
          artifactRoot: job.artifactRoot || "",
          artifactPaths: job.artifactPaths || [],
          downloadFolder: job.downloadFolder || settings().downloadFolder || "",
        },
        30000,
      );
    }
    delete downloadsById()[jobId];
    await deps.persistDownloads();
    deps.notifyPopup({ type: "downloadRemoved", jobId });
    return { jobId };
  }

  async function clearDownloads(): Promise<{ jobIds: string[]; downloads: DownloadJobRecord[] }> {
    await deps.ensureStateLoaded();
    const removedJobIds: string[] = [];
    const activeDownloads: Record<string, DownloadJobRecord> = {};

    for (const [jobId, job] of Object.entries(downloadsById())) {
      if (deps.downloadPortsById[jobId] || deps.blockingDownloadStatuses.has(job?.status || "queued")) {
        activeDownloads[jobId] = job;
      } else {
        removedJobIds.push(jobId);
      }
    }

    deps.setDownloadsById(activeDownloads);
    await deps.persistDownloads();
    deps.notifyPopup({ type: "downloadsCleared", jobIds: removedJobIds, downloads: Object.values(downloadsById()) });
    return { jobIds: removedJobIds, downloads: Object.values(downloadsById()) };
  }

  return {
    cancelDownload,
    chooseDownloadFolder,
    clearDownloads,
    controlActiveDownload,
    findBlockingDownloadJobForVideo,
    getDownloadJob,
    isBlockingDownloadStatus,
    openDownloadedPath,
    removeDownload,
    resumeDownload,
    retryDownload,
    videoFromDownloadJob,
  };
}
