"use strict";

function create(deps) {
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

    const blockingJob = findBlockingDownloadJobForVideo(video, selectedVideo);
    if (blockingJob) {
      return { jobId: blockingJob.id, existing: true };
    }

    return startNativeDownloadFromVideo(
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

  async function startNativeDownloadFromVideo(tabId, video, formatId = "best", options = {}) {
    const tabs = await deps.callTabsQuery({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0] ? tabs[0] : {};
    const jobId = options.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const existingJob = downloadsById()[jobId] || {};
    const pageUrl = video.pageUrl || activeTab.url || "";
    const requestHeaders =
      (Array.isArray(video.requestHeaders) && video.requestHeaders.length ? video.requestHeaders : null) ||
      (Array.isArray(existingJob.requestHeaders) && existingJob.requestHeaders.length
        ? existingJob.requestHeaders
        : null) ||
      (await deps.nativeRequestHeadersForVideo(video.url, pageUrl));
    const attemptedUrls = new Set((options.attemptedUrls || []).map((url) => deps.normalizeUrl(url)));
    attemptedUrls.add(deps.normalizeUrl(video.url || ""));
    const backend = options.backend || video.backend || "auto";
    let port;
    let finished = false;

    deps.updateDownload(jobId, {
      id: jobId,
      tabId,
      videoId: video.groupId || video.id,
      variantId: video.groupId ? video.id : "",
      url: video.url,
      format: video.format,
      title: video.title || "Video",
      formatId: formatId || "best",
      downloadFolder: settings().downloadFolder || "",
      requestHeaders: requestHeaders,
      pageUrl,
      backend,
      filepath: existingJob.filepath || "",
      artifactRoot: existingJob.artifactRoot || "",
      status: "connecting",
      message: options.resume ? "Reconnecting to native helper..." : "Connecting to native helper...",
      ...deps.resetDownloadProgressDetails(),
      percent: options.resume && typeof existingJob.percent === "number" ? existingJob.percent : null,
      createdAt: existingJob.createdAt || Date.now(),
    });

    try {
      port = deps.api.runtime.connectNative(deps.hostName);
    } catch (error) {
      deps.updateDownload(jobId, {
        status: "error",
        error: `Native messaging is not connected: ${error.message || error}`,
      });
      return { jobId };
    }
    deps.downloadPortsById[jobId] = port;

    port.onMessage.addListener((message) => {
      if (!message || message.id !== jobId) {
        return;
      }

      if (message.type === "started") {
        deps.updateDownload(jobId, { status: "running", message: "" });
        return;
      }

      if (message.type === "progress") {
        const patch = {
          status: "running",
          stage: message.stage,
          ...deps.artifactPatchFromMessage(message),
          ...deps.progressDetailPatchFromMessage(message),
        };
        if (typeof message.percent === "number") {
          patch.percent = deps.normalizeDownloadProgress(jobId, message.percent);
          patch.message = deps.downloadProgressMessage(patch.percent);
        }
        deps.updateDownload(jobId, patch);
        return;
      }

      if (message.type === "control") {
        deps.updateDownload(jobId, {
          status: message.status || downloadsById()[jobId]?.status || "running",
          message: message.message || "Download control command sent.",
        });
        return;
      }

      if (message.type === "paused") {
        deps.updateDownload(jobId, {
          status: "paused",
          message: message.message || "Download paused.",
          ...deps.artifactPatchFromMessage(message),
        });
        return;
      }

      if (message.type === "resumed") {
        deps.updateDownload(jobId, {
          status: "running",
          message: message.message || "Resuming download...",
        });
        return;
      }

      if (message.type === "canceled") {
        finished = true;
        delete deps.downloadPortsById[jobId];
        const cleanupPatch = deps.cleanupPatchFromMessage(message);
        deps.updateDownload(jobId, {
          status: "canceled",
          message: message.message || "Download canceled.",
          ...deps.artifactPatchFromMessage(message),
          ...cleanupPatch,
          ...deps.clearedArtifactPatch(cleanupPatch),
        });
        try {
          port.disconnect();
        } catch (_error) {}
        return;
      }

      if (message.type === "done") {
        finished = true;
        delete deps.downloadPortsById[jobId];
        deps.updateDownload(jobId, {
          status: "done",
          percent: 100,
          rawPercent: 100,
          speed: "",
          eta: "",
          stage: "done",
          filepath: message.filepath || "",
          artifactRoot: message.artifactRoot || "",
          message: message.message || "Download complete.",
        });
        try {
          port.disconnect();
        } catch (_error) {}
        return;
      }

      if (message.type === "error") {
        const errorText = message.error || "yt-dlp failed.";
        finished = true;
        delete deps.downloadPortsById[jobId];
        const artifactPatch = deps.artifactPatchFromMessage(message);
        try {
          port.disconnect();
        } catch (_error) {}
        if (deps.isRetryableSourceError(errorText)) {
          void (async () => {
            if (deps.isHardAccessError(errorText)) {
              await deps.markVideoUrlUnavailable(tabId, video.url, errorText);
            }
            const fallbackVideo = await deps.fallbackVideoForDownload(tabId, video, attemptedUrls);
            if (!fallbackVideo) {
              deps.updateDownload(jobId, {
                status: "error",
                error: deps.exhaustedSourcesError(errorText, attemptedUrls),
                ...artifactPatch,
              });
              return;
            }

            deps.updateDownload(jobId, {
              status: "connecting",
              error: "",
              message: "Source expired; trying another detected source...",
              ...artifactPatch,
            });
            await startNativeDownloadFromVideo(tabId, fallbackVideo, "best", {
              jobId,
              attemptedUrls: Array.from(attemptedUrls),
              backend: fallbackVideo.backend || backend,
            });
          })();
          return;
        }

        // Use a user-friendly message when possible, but keep technical details in rawProgressLine
        const friendlyError = deps.userFriendlyDownloadError(errorText);
        deps.updateDownload(jobId, {
          status: "error",
          stage: "",
          error: friendlyError || errorText,
          rawProgressLine: friendlyError ? errorText : "",
          ...artifactPatch,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const runtimeError = deps.api.runtime.lastError ? deps.api.runtime.lastError.message : "";
      delete deps.downloadPortsById[jobId];
      if (!finished) {
        deps.updateDownload(jobId, {
          status: "error",
          error:
            runtimeError ||
            "Native messaging helper disconnected. Run scripts\\install.bat, restart the browser, and try again.",
        });
      }
    });

    port.postMessage({
      type: "download",
      id: jobId,
      url: video.url,
      format: video.format || "",
      pageUrl,
      userAgent: deps.userAgent(),
      requestHeaders,
      downloadFolder: settings().downloadFolder || "",
      formatId: formatId || "best",
      backend,
      musicMode: settings().musicMode || false,
      audioFormat: settings().audioFormat || "mp3",
    });

    deps.updateDownload(jobId, {
      status: "queued",
      message: "Sent to native helper.",
    });

    return { jobId };
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

    return startNativeDownloadFromVideo(job.tabId || tabId, videoFromDownloadJob(job), job.formatId || "best", {
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

    return startNativeDownloadFromVideo(job.tabId || tabId, videoFromDownloadJob(job), job.formatId || "best");
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
    getBestDownloadableVideo,
    getDownloadJob,
    isBlockingDownloadStatus,
    openDownloadedPath,
    removeDownload,
    resumeDownload,
    retryDownload,
    startBestNativeDownload,
    startNativeDownload,
    startNativeDownloadForUrl,
    startNativeDownloadFromVideo,
    videoFromDownloadJob,
  };
}

export { create };
