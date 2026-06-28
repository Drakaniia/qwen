"use strict";

import { formatBytes } from "./download_helpers.js";
import { createOperations } from "./download_operations.js";

function create(deps) {
  // ── Operations (download control, file ops, management) ──────────────
  // These receive startNativeDownloadFromVideo as a dep to avoid circular calls.
  const ops = createOperations({
    ...deps,
    startNativeDownloadFromVideo: null, // populated after core function definition
  });

  // ── Core download flow ───────────────────────────────────────────────

  function settings() {
    return deps.getSettings();
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

    const blockingJob = ops.findBlockingDownloadJobForVideo(video, selectedVideo);
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
    const existingJob = deps.getDownloadsById()[jobId] || {};
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

    // Determine the initial total size for the download list.
    const rawSizeBytes = video.sizeBytes || video.filesize || 0;
    const MIN_REALISTIC_BYTES = 1024 * 1024;
    let initialTotalSize = "";
    if (rawSizeBytes >= MIN_REALISTIC_BYTES) {
      initialTotalSize = formatBytes(rawSizeBytes);
    } else if (rawSizeBytes > 0) {
      const duration = video.duration || 0;
      const bitrate = video.tbr || video.bitrate || 0;
      if (duration > 0 && bitrate > 0) {
        const estimatedBytes = (duration * bitrate * 1000) / 8;
        if (estimatedBytes >= MIN_REALISTIC_BYTES) {
          initialTotalSize = `~${formatBytes(estimatedBytes)}`;
        }
      }
    }

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
      totalSize: initialTotalSize,
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
          status: message.status || deps.getDownloadsById()[jobId]?.status || "running",
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
      downloadSubtitles: settings().downloadSubtitles !== false,
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

  // Patch ops with core function reference after definition
  ops.startNativeDownloadFromVideo = startNativeDownloadFromVideo;

  return {
    ...ops,
    getBestDownloadableVideo,
    startBestNativeDownload,
    startNativeDownload,
    startNativeDownloadForUrl,
    startNativeDownloadFromVideo,
  };
}

export { create };
