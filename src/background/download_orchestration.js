"use strict";

import { formatBytes } from "./download_helpers.js";
import { createOperations } from "./download_operations.js";
import { isBrowserDownloadableFormat, filenameFromVideo } from "./browser_download.js";

function create(deps) {
  // ── Operations (download control, file ops, management) ──────────────
  // These receive startNativeDownloadFromVideo as a dep to avoid circular calls.
  // We keep a reference to the deps object so we can mutate it after the core
  // function is defined — otherwise resumeDownload/retryDownload closures
  // inside createOperations would still see `null`.
  const opsDeps = {
    ...deps,
    startNativeDownloadFromVideo: null, // populated after core function definition
  };
  const ops = createOperations(opsDeps);

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

  // ── Browser download (chrome.downloads API) ──────────────────────────

  /**
   * Start a download directly via the browser's chrome.downloads API.
   * Tracks progress and completion via chrome.downloads.onChanged.
   */
  async function browserDownload(tabId, video, formatId, options) {
    const { jobId } = options;
    const filename = filenameFromVideo(video);

    deps.updateDownload(jobId, {
      status: "running",
      message: "Starting browser download...",
      stage: "downloading",
      speed: "",
      eta: "",
    });

    let onChangedHandler = null;
    let downloadId = null;

    function cleanup() {
      if (onChangedHandler) {
        try {
          deps.api.downloads.onChanged.removeListener(onChangedHandler);
        } catch (_e) { /* ignore */ }
        onChangedHandler = null;
      }
    }

    return new Promise((resolve) => {
      // ── Progress listener ──────────────────────────────────────────
      onChangedHandler = function (delta) {
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
        const bytesReceived = delta.bytesReceived ? delta.bytesReceived.current : current.rawDownloadedBytes;
        const totalBytes = delta.totalBytes ? delta.totalBytes.current : current.rawTotalBytes;
        if (typeof bytesReceived === "number" || typeof totalBytes === "number") {
          const patch = {};
          if (typeof bytesReceived === "number") patch.rawDownloadedBytes = bytesReceived;
          if (typeof totalBytes === "number") patch.rawTotalBytes = totalBytes;
          if (typeof totalBytes === "number" && totalBytes > 0) {
            const pct = Math.min(100, Math.round((bytesReceived || 0) / totalBytes * 100));
            patch.percent = deps.normalizeDownloadProgress(jobId, pct);
            patch.message = deps.downloadProgressMessage(pct);
          }
          deps.updateDownload(jobId, patch);
        }
      };

      // ── Initiate download ──────────────────────────────────────────
      try {
        const api = deps.api;

        function onDownloadStarted(id) {
          downloadId = id;
          try {
            api.downloads.onChanged.addListener(onChangedHandler);
          } catch (_e) {
            // Downloads.onChanged not supported; no progress tracking
          }
          deps.updateDownload(jobId, {
            status: "running",
            message: "Downloading via browser...",
          });
          resolve({ jobId });
        }

        if (typeof browser !== "undefined" && typeof api.downloads.download.then === "function") {
          // Firefox promise-based
          api.downloads.download({ url: video.url, filename, conflictAction: "uniquify" })
            .then(onDownloadStarted)
            .catch(function (err) {
              deps.updateDownload(jobId, {
                status: "error",
                error: `Browser download failed: ${err.message || err}`,
              });
              resolve({ jobId });
            });
        } else {
          // Chrome callback-based
          api.downloads.download(
            { url: video.url, filename, conflictAction: "uniquify" },
            function (id) {
              if (api.runtime.lastError) {
                deps.updateDownload(jobId, {
                  status: "error",
                  error: `Browser download failed: ${api.runtime.lastError.message}`,
                });
                resolve({ jobId });
                return;
              }
              onDownloadStarted(id);
            },
          );
        }
      } catch (error) {
        deps.updateDownload(jobId, {
          status: "error",
          error: `Browser download error: ${error.message || error}`,
        });
        resolve({ jobId });
      }
    });
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

    // ── Browser backend shortcut ──────────────────────────────────────
    if (backend === "browser") {
      if (!isBrowserDownloadableFormat(video.format)) {
        deps.updateDownload(jobId, {
          status: "error",
          error:
            "Browser download does not support streaming formats (HLS, DASH, Smooth Streaming). " +
            'Select "Auto" or "yt-dlp" as the download method.',
        });
        return { jobId };
      }

      // Create minimal job entry
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
        message: "Starting browser download...",
        ...deps.resetDownloadProgressDetails(),
        totalSize: "",
        percent: options.resume && typeof existingJob.percent === "number" ? existingJob.percent : null,
        createdAt: existingJob.createdAt || Date.now(),
      });

      return browserDownload(tabId, video, formatId, {
        jobId,
        pageUrl,
        requestHeaders,
        attemptedUrls: Array.from(attemptedUrls),
        backend,
      });
    }

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
              // All native-host sources exhausted; try browser download as last resort
              if (isBrowserDownloadableFormat(video.format)) {
                deps.updateDownload(jobId, {
                  status: "connecting",
                  error: "",
                  message: "All native sources failed; trying browser download...",
                  ...artifactPatch,
                });
                await browserDownload(tabId, video, "best", {
                  jobId,
                  pageUrl,
                  requestHeaders,
                  attemptedUrls: Array.from(attemptedUrls),
                  backend: "browser",
                });
                return;
              }
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
            "Native messaging helper disconnected. Run scripts/install.sh, restart the browser, and try again.",
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

  // Patch both ops (public API) and opsDeps (internal closures in createOperations)
  // so that resumeDownload/retryDownload see the real function.
  opsDeps.startNativeDownloadFromVideo = startNativeDownloadFromVideo;
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
