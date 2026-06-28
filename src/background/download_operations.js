"use strict";

/**
 * Download Control & File Operations
 *
 * Download management, control commands (pause/resume/cancel/retry),
 * file operations (open/choose folder), and download list management.
 *
 * Extracted from download_orchestration.js for modularity.
 * Receives core download functions via `deps` to avoid circular imports.
 */

export function createOperations(deps) {
  function settings() {
    return deps.getSettings();
  }

  function downloadsById() {
    return deps.getDownloadsById();
  }

  function isBlockingDownloadStatus(status) {
    return deps.blockingDownloadStatuses.has(status || "queued");
  }

  function findBlockingDownloadJobForVideo(video, selectedVideo) {
    const ids = new Set();
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
      if ((job.videoId && ids.has(job.videoId)) || (job.variantId && ids.has(job.variantId))) {
        return true;
      }
      return selectedUrl && deps.normalizeUrl(job.url || "") === selectedUrl;
    });
  }

  function getDownloadJob(jobId) {
    const job = downloadsById()[jobId];
    if (!job) {
      throw new Error("That download is no longer in the history.");
    }
    return job;
  }

  function videoFromDownloadJob(job) {
    const video = {
      id: job.videoId || deps.hashId(job.url),
      url: job.url,
      format: job.format || deps.detectFormat(job.url),
      title: job.title || deps.titleFromUrl(job.url),
      pageUrl: job.pageUrl || "",
      requestHeaders: job.requestHeaders || [],
      downloadable: true,
    };
    if (deps.videoFilters.isBlockedVideoUrl(video.url, job.contentType || "")) {
      return deps.pageFallbackVideoForSource(video, new Set([deps.normalizeUrl(video.url || "")])) || video;
    }
    return video;
  }

  function controlActiveDownload(jobId, nativeType) {
    const port = deps.downloadPortsById[jobId];
    if (!port) {
      throw new Error("That download is not active anymore. Use Retry to start it again.");
    }

    const nextStatus = {
      pause: "pausing",
      resume: "running",
      cancel: "canceling",
    }[nativeType];
    const nextMessage = {
      pause: "Pausing download...",
      resume: "Resuming download...",
      cancel: "Canceling download...",
    }[nativeType];

    deps.updateDownload(jobId, {
      status: nextStatus || downloadsById()[jobId]?.status || "running",
      message: nextMessage || "Sending download command...",
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

  async function resumeDownload(tabId, jobId) {
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
    });
  }

  async function cancelDownload(_tabId, jobId) {
    await deps.ensureStateLoaded();
    if (deps.downloadPortsById[jobId]) {
      return controlActiveDownload(jobId, "cancel");
    }

    const job = getDownloadJob(jobId);
    if (["done", "error", "canceled"].includes(job.status)) {
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

  async function retryDownload(tabId, jobId) {
    await deps.ensureStateLoaded();
    const job = getDownloadJob(jobId);
    if (["queued", "connecting", "running", "paused", "pausing", "canceling"].includes(job.status)) {
      throw new Error("That download is still active. Cancel it or wait before retrying.");
    }
    if (!job.url) {
      throw new Error("That download does not have a URL to retry.");
    }

    return deps.startNativeDownloadFromVideo(job.tabId || tabId, videoFromDownloadJob(job), job.formatId || "best");
  }

  async function openDownloadedPath(jobId, nativeType) {
    await deps.ensureStateLoaded();
    const job = getDownloadJob(jobId);
    if (!job.filepath) {
      throw new Error("That download has no saved file path yet.");
    }

    const requestId = `open_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload =
      nativeType === "openFile"
        ? { type: "openFile", id: requestId, path: job.filepath }
        : { type: "showFile", id: requestId, path: job.filepath };

    await deps.nativeRequest(payload, 10000);
    return { jobId };
  }

  async function chooseDownloadFolder() {
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

  async function removeDownload(jobId) {
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

  async function clearDownloads() {
    await deps.ensureStateLoaded();
    const removedJobIds = [];
    const activeDownloads = {};

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
