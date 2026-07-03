"use strict";

import { isCloudflareBlockError, dlDebug } from "./helpers.js";
import { browserDownload } from "./browser.js";
import { isBrowserDownloadableFormat } from "../browser_download.js";
import { extractCookies, cookiesToCookieString } from "../cookie_extraction.js";
import { detectAndSolveCloudflare } from "../cloudflare_solver.js";
import { formatBytes } from "../download_helpers.js";

/**
 * Try to download the video through the CDP browser tunnel.
 * This is a last-resort fallback when all native host sources fail,
 * attempted before the browser download fallback.
 */
export async function tryCdpTunnelFallback(deps, tabId, url, format, requestHeaders, jobId) {
  deps.updateDownload(jobId, {
    status: "connecting",
    message: "Trying browser tunnel as last resort...",
  });

  try {
    const { tryCdpTunnelDownload } = await import("../cdp_tunnel_integration.js");
    const result = await tryCdpTunnelDownload(tabId, url, {
      requestHeaders,
      timeout: 120000,
      format: format || "",
    });

    if (!result.ok) {
      return { ok: false, error: result.error || "CDP tunnel download failed" };
    }

    // For segment data, send to native host to write to disk
    // For manifest data, return it for further processing
    return {
      ok: true,
      data: result.data,
      byteLength: result.byteLength,
      contentType: result.contentType,
      method: result.method,
    };
  } catch (err) {
    return { ok: false, error: `CDP tunnel fallback error: ${err.message || err}` };
  }
}

/**
 * Core native download flow: connects to native messaging host,
 * sends download request, handles all message types, fallbacks, and errors.
 */
export async function startNativeDownloadFromVideo(deps, tabId, video, formatId = "best", options = {}) {
  const tabs = await deps.callTabsQuery({ active: true, currentWindow: true });
  const activeTab = tabs && tabs[0] ? tabs[0] : {};
  const jobId = options.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const existingJob = deps.getDownloadsById()[jobId] || {};
  const pageUrl = video.pageUrl || activeTab.url || "";

  dlDebug(deps, "info", `Initiating download for: ${(video.title || video.url || "").substring(0, 100)}`);
  dlDebug(deps, "info", `Video URL: ${(video.url || "").substring(0, 150)}`);
  dlDebug(deps, "info", `Backend: ${options.backend || video.backend || "auto"}, Format: ${formatId || "best"}`);
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
      downloadFolder: deps.getSettings().downloadFolder || "",
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

    return browserDownload(deps, tabId, video, formatId, {
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
    downloadFolder: deps.getSettings().downloadFolder || "",
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
    dlDebug(deps, "info", "Connecting to native messaging helper...");
    port = deps.api.runtime.connectNative(deps.hostName);
    dlDebug(deps, "info", "Native messaging helper connected");
  } catch (error) {
    const errMsg = `Native messaging is not connected: ${error.message || error}`;
    dlDebug(deps, "error", "Failed to connect to native helper", errMsg);
    deps.updateDownload(jobId, {
      status: "error",
      error: errMsg,
    });
    return { jobId };
  }
  deps.downloadPortsById[jobId] = port;

  port.onMessage.addListener((message) => {
    if (!message || message.id !== jobId) {
      return;
    }

    if (message.type === "started") {
      dlDebug(deps, "info", "Native helper started processing the download");
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
      dlDebug(deps, "info", "Download completed successfully", message.filepath || "");
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
      dlDebug(deps, "error", "Native host reported error", errorText.substring(0, 500));
      finished = true;
      delete deps.downloadPortsById[jobId];
      const artifactPatch = deps.artifactPatchFromMessage(message);
      try {
        port.disconnect();
      } catch (_error) {}

      // ── Cloudflare detection: try to solve challenge and retry ────
      if (isCloudflareBlockError(errorText)) {
        dlDebug(deps, "warn", "Cloudflare block detected, attempting to solve challenge...");
        void (async () => {
          deps.updateDownload(jobId, {
            status: "connecting",
            error: "",
            message: "Download blocked by Cloudflare. Navigating to solve challenge...",
            ...artifactPatch,
          });

          const solverResult = await detectAndSolveCloudflare(tabId, pageUrl || video.url, { timeout: 120000 });

          if (solverResult.solved) {
            dlDebug(deps, "info", "Cloudflare challenge solved, retrying download");
            deps.updateDownload(jobId, {
              status: "connecting",
              message: "Challenge solved! Retrying download with Cloudflare clearance...",
            });
            // Retry the download — cf_clearance cookie is now in the tab's cookies
            await startNativeDownloadFromVideo(deps, tabId, video, formatId, {
              jobId,
              attemptedUrls: Array.from(attemptedUrls),
              backend,
            });
            return;
          }

          // Could not solve the challenge; fall through to normal retryable error handling
          deps.updateDownload(jobId, {
            status: "connecting",
            message: "Cloudflare challenge not solved. Trying other sources...",
            ...artifactPatch,
          });
        })()
          .then(() => {
            handleErrorWithFallbacks();
          })
          .catch(() => {
            handleErrorWithFallbacks();
          });
        return;
      }

      function handleErrorWithFallbacks() {
        if (deps.isRetryableSourceError(errorText)) {
          dlDebug(deps, "warn", "Error is retryable, looking for fallback sources...");
          void (async () => {
            if (deps.isHardAccessError(errorText)) {
              dlDebug(deps, "warn", "Hard access error, marking URL as unavailable", errorText.substring(0, 300));
              await deps.markVideoUrlUnavailable(tabId, video.url, errorText);
            }
            const fallbackVideo = await deps.fallbackVideoForDownload(tabId, video, attemptedUrls);
            if (!fallbackVideo) {
              // All native-host sources exhausted; try CDP browser tunnel
              dlDebug(deps, "warn", "No fallback video found, trying CDP browser tunnel...");
              const tunnelResult = await tryCdpTunnelFallback(
                deps,
                tabId,
                video.url,
                video.format,
                requestHeaders,
                jobId,
              );
              if (tunnelResult.ok && tunnelResult.method !== "manifest") {
                dlDebug(deps, "info", "CDP tunnel download succeeded");
                deps.updateDownload(jobId, {
                  status: "done",
                  percent: 100,
                  rawPercent: 100,
                  speed: "",
                  eta: "",
                  stage: "done",
                  message: "Download complete (CDP tunnel).",
                });
                return;
              }

              if (isBrowserDownloadableFormat(video.format)) {
                dlDebug(deps, "warn", "CDP tunnel failed, trying browser download fallback...");
                deps.updateDownload(jobId, {
                  status: "connecting",
                  error: "",
                  message: "Tunnel failed; trying browser download...",
                  ...artifactPatch,
                });
                await browserDownload(deps, tabId, video, "best", {
                  jobId,
                  pageUrl,
                  requestHeaders,
                  attemptedUrls: Array.from(attemptedUrls),
                  backend: "browser",
                });
                return;
              }
              dlDebug(deps, "error", "All download methods exhausted", deps.exhaustedSourcesError(errorText, attemptedUrls));
              deps.updateDownload(jobId, {
                status: "error",
                error: deps.exhaustedSourcesError(errorText, attemptedUrls),
                ...artifactPatch,
              });
              return;
            }

            dlDebug(deps, "info", `Retrying with fallback source: ${(fallbackVideo.url || "").substring(0, 120)}`);
            deps.updateDownload(jobId, {
              status: "connecting",
              error: "",
              message: "Source expired; trying another detected source...",
              ...artifactPatch,
            });
            await startNativeDownloadFromVideo(deps, tabId, fallbackVideo, "best", {
              jobId,
              attemptedUrls: Array.from(attemptedUrls),
              backend: fallbackVideo.backend || backend,
            });
          })();
          return;
        }

        const friendlyError = deps.userFriendlyDownloadError(errorText);
        dlDebug(deps, "error", "Download failed (non-retryable)", (friendlyError || errorText).substring(0, 500));
        deps.updateDownload(jobId, {
          status: "error",
          stage: "",
          error: friendlyError || errorText,
          rawProgressLine: friendlyError ? errorText : "",
          ...artifactPatch,
        });
      }
      // Call handleErrorWithFallbacks for non-Cloudflare errors
      handleErrorWithFallbacks();
    }
  });

  port.onDisconnect.addListener(() => {
    const runtimeError = deps.api.runtime.lastError ? deps.api.runtime.lastError.message : "";
    delete deps.downloadPortsById[jobId];
    if (!finished) {
      const errMsg = runtimeError || "Native messaging helper disconnected";
      dlDebug(deps, "error", "Native helper disconnected unexpectedly", errMsg);
      deps.updateDownload(jobId, {
        status: "error",
        error: errMsg + ". Run scripts/install.sh, restart the browser, and try again.",
      });
    }
  });

  // Extract cookies from browser session for authenticated downloads
  let cookieHeader = "";
  if (tabId) {
    try {
      const cookies = await extractCookies(tabId);
      cookieHeader = cookiesToCookieString(cookies);
    } catch (_e) {
      // Cookie extraction is best-effort
    }
  }

  port.postMessage({
    type: "download",
    id: jobId,
    url: video.url,
    format: video.format || "",
    pageUrl,
    userAgent: deps.userAgent(),
    requestHeaders,
    cookieHeader,
    downloadFolder: deps.getSettings().downloadFolder || "",
    formatId: formatId || "best",
    backend,
    musicMode: deps.getSettings().musicMode || false,
    audioFormat: deps.getSettings().audioFormat || "mp3",
    downloadSubtitles: deps.getSettings().downloadSubtitles !== false,
  });

  dlDebug(deps, "info", `Download request sent to native helper (backend: ${backend})`);
  if (video.url) {
    dlDebug(deps, "debug", "Download URL", video.url.substring(0, 200));
  }

  deps.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper.",
  });

  return { jobId };
}
