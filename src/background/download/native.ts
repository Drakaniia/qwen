import { browserDownload } from "./browser.js";
import { isBrowserDownloadableFormat } from "../browser_download.js";
// The byte ladder lives in one place, `ui/format.ts`'s `formatSize`. `download_helpers.ts`
// carried a third copy that stopped at GB and rendered bytes as `"500.0 B"`; importing the
// canonical one is safe here because it reaches only `shared/video_filters.js` and
// `shared/download_statuses.js` — no Preact, no DOM, so it costs the service worker nothing.
import { formatSize } from "../../ui/format.js";
import type {
  DownloadOrchestratorDeps,
  DownloadStartResult,
  JobPatch,
  NativeDownloadOptions,
  TabId,
  VideoRecord,
} from "../types.js";

/**
 * Core native download flow: connects to native messaging host,
 * sends download request, handles all message types, fallbacks, and errors.
 */
export async function startNativeDownloadFromVideo(
  deps: DownloadOrchestratorDeps,
  tabId: TabId,
  video: VideoRecord,
  formatId = "best",
  options: NativeDownloadOptions = {},
): Promise<DownloadStartResult> {
  const tabs = await deps.callTabsQuery({ active: true, currentWindow: true });
  const activeTab: Partial<chrome.tabs.Tab> = (tabs && tabs[0]) || {};
  const jobId = options.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const existingJob = deps.getDownloadsById()[jobId] || {};
  const pageUrl = video.pageUrl || activeTab.url || "";

  const requestHeaders =
    (Array.isArray(video.requestHeaders) && video.requestHeaders.length ? video.requestHeaders : null) ||
    (Array.isArray(existingJob.requestHeaders) && existingJob.requestHeaders.length
      ? existingJob.requestHeaders
      : null) ||
    (await deps.nativeRequestHeadersForVideo(video.url as string, pageUrl));
  const attemptedUrls = new Set((options.attemptedUrls || []).map((url) => deps.normalizeUrl(url)));
  attemptedUrls.add(deps.normalizeUrl(video.url || ""));
  const backend = options.backend || video.backend || "auto";
  let port: chrome.runtime.Port;
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
      // The downloads page renders history art from the job (thumbnail-spec.md §7.1),
      // and the job is the only record that outlives the tab. The ladder's head is the
      // same URL the row was already showing; `download_operations.ts` re-derives it
      // on resume/retry, where a `VideoRecord` is no longer in scope.
      //
      // Never a `data:` URL here (hls-thumbnail-spec.md §5.2/§11). An ffmpeg frame grab
      // arrives as `data:image/jpeg;base64,…` and this field is copied into the synced
      // history entry, whose whole budget is ~100 KB — a base64 JPEG per row destroys it
      // in a dozen. Frame art is a service-worker capture instead
      // (`thumbnail_captures.ts`), or a `thumbnailFrames` lookup for a synced row.
      thumbnailUrl: video.thumbnailUrl || (video.thumbnailCandidates || [])[0] || "",
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
    initialTotalSize = formatSize(rawSizeBytes);
  } else if (rawSizeBytes > 0) {
    const duration = video.duration || 0;
    const bitrate = video.tbr || video.bitrate || 0;
    if (duration > 0 && bitrate > 0) {
      const estimatedBytes = (duration * bitrate * 1000) / 8;
      if (estimatedBytes >= MIN_REALISTIC_BYTES) {
        initialTotalSize = `~${formatSize(estimatedBytes)}`;
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
    port = deps.api.runtime.connectNative(deps.hostName);
  } catch (error) {
    const errMsg = `Native messaging is not connected: ${(error as Error).message || error}`;
    deps.updateDownload(jobId, {
      status: "error",
      error: errMsg,
    });
    return { jobId };
  }
  deps.downloadPortsById[jobId] = port;

  port.onMessage.addListener((raw) => {
    const message = raw as Record<string, any>;
    if (!message || message.id !== jobId) {
      return;
    }

    if (message.type === "started") {
      // Spec D14 / §4.4. The host names the attempt it is about to make, and a
      // download can fall through six or more of them before one sticks — without
      // this, a stall during backend selection is indistinguishable from a hang.
      // It rides on `message` (spec §4.4: `DownloadJob` gains no field for it), and
      // `downloadMessageText` is what lets a "Trying …" line past the blanket
      // suppression it applies to every other message on an active job.
      // No label ⇒ today's behaviour exactly, blank message and all.
      const label = String(message.label || "").trim();
      deps.updateDownload(jobId, { status: "running", message: label ? `Trying ${label}…` : "" });
      return;
    }

    if (message.type === "progress") {
      const patch: JobPatch = {
        status: "running",
        ...deps.artifactPatchFromMessage(message),
        ...deps.progressDetailPatchFromMessage(message),
      };
      // `log` is the parser's catch-all for a line it did not classify
      // (`progress_parser.py`'s final `return {"stage": "log"}`), not a phase —
      // `ProgressBar.tsx`'s `STAGES` docstring says so. Writing it over a real phase
      // would blank the row's stage timeline, and it would also reset D7's per-stage
      // baseline on the *next* frame, which is how a monotone bar would start
      // walking backwards. So a bare `log` leaves the job's stage alone; only a
      // recognised phase advances it.
      const stage = String(message.stage || "");
      const nextStage = stage === "log" ? "" : stage;
      if (nextStage) {
        patch.stage = nextStage;
      }
      if (typeof message.percent === "number") {
        patch.percent = deps.normalizeDownloadProgress(jobId, message.percent, nextStage);
        patch.message = deps.downloadProgressMessage(patch.percent as number);
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
      const errorText: string = message.error || "yt-dlp failed.";
      finished = true;
      delete deps.downloadPortsById[jobId];
      const artifactPatch = deps.artifactPatchFromMessage(message);
      try {
        port.disconnect();
      } catch (_error) {}

      function handleErrorWithFallbacks(): void {
        if (deps.isRetryableSourceError(errorText)) {
          void (async () => {
            if (deps.isHardAccessError(errorText)) {
              await deps.markVideoUrlUnavailable(tabId, video.url as string, errorText);
            }
            const fallbackVideo = await deps.fallbackVideoForDownload(tabId, video, attemptedUrls);
            if (!fallbackVideo) {
              if (isBrowserDownloadableFormat(video.format)) {
                deps.updateDownload(jobId, {
                  status: "connecting",
                  error: "",
                  message: "Trying browser download...",
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
            await startNativeDownloadFromVideo(deps, tabId, fallbackVideo, "best", {
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
      handleErrorWithFallbacks();
    }
  });

  port.onDisconnect.addListener(() => {
    const runtimeError = deps.api.runtime.lastError ? deps.api.runtime.lastError.message : "";
    delete deps.downloadPortsById[jobId];
    if (!finished) {
      const errMsg = runtimeError || "Native messaging helper disconnected";
      deps.updateDownload(jobId, {
        status: "error",
        error: errMsg + ". Run scripts/install.sh, restart the browser, and try again.",
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
    downloadFolder: deps.getSettings().downloadFolder || "",
    formatId: formatId || "best",
    backend,
    musicMode: deps.getSettings().musicMode || false,
    audioFormat: deps.getSettings().audioFormat || "mp3",
    downloadSubtitles: deps.getSettings().downloadSubtitles !== false,
    // ffmpeg's `-progress` block reports `out_time_ms` but never a total, so the host cannot
    // derive a percent without one (spec §3.3). It is the only duration source it has, and
    // without it the ffmpeg path emits a byte count and no bar — which is why it is sent
    // explicitly rather than left to the host to guess.
    duration: typeof video.duration === "number" && video.duration > 0 ? video.duration : 0,
  });

  deps.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper.",
  });

  return { jobId };
}
