"use strict";

import { filenameFromVideo } from "../browser_download.js";

/**
 * Start a download directly via the browser's chrome.downloads API.
 * Tracks progress and completion via chrome.downloads.onChanged.
 *
 * @param {Object} deps - Dependency object with api, updateDownload, getDownloadsById, normalizeDownloadProgress, downloadProgressMessage
 * @param {number} tabId
 * @param {Object} video
 * @param {string} formatId
 * @param {Object} options - { jobId, pageUrl, requestHeaders, attemptedUrls, backend }
 * @returns {Promise<{jobId: string}>}
 */
export async function browserDownload(deps, tabId, video, formatId, options) {
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
      } catch (_e) {
        // ignore
      }
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
        api.downloads
          .download({ url: video.url, filename, conflictAction: "uniquify" })
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
