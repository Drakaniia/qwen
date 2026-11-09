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
 * The row text for a native job whose helper process is gone but whose partial file is
 * not: yt-dlp keeps its `.part` files, and Resume relaunches the job with `resume: true`
 * (`download_operations.ts:resumeDownload`). Shared with the startup reconciliation in
 * `download/index.ts`, which writes it for every job a worker restart cut off.
 */
export const INTERRUPTED_MESSAGE = "Interrupted — press Resume to continue.";

/**
 * The host's answer to a pause/cancel for a task it no longer has, in the wording older
 * helpers used before they learned to reply `{type: "control", status: "gone"}`. Only
 * read while the job is `pausing`/`canceling`, so a real "404 Not Found" download
 * failure still runs the fallback chain.
 */
const GONE_TASK_ERROR_RE = /no (active )?download|unknown download|not found/i;

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

  // The download gate (`download/queue.ts`) holds a slot until its item SETTLES, and
  // this is that signal. `finished` already tracked the same edge for `onDisconnect`, so
  // it is the one flag both paths read; `onSettled` is the outward face of it, fired at
  // most once. A starter that never settles would strand the whole queue, so every exit
  // below — including the two pre-port failures — has to call it.
  let settledNotified = false;
  function settle(): void {
    if (settledNotified) {
      return;
    }
    settledNotified = true;
    try {
      options.onSettled?.();
    } catch (_error) {
      /* A gate callback must never break the port listener that reported the job. */
    }
  }

  // ── Browser backend shortcut ──────────────────────────────────────
  if (backend === "browser") {
    if (!isBrowserDownloadableFormat(video.format)) {
      deps.updateDownload(jobId, {
        status: "error",
        error:
          "Browser download does not support streaming formats (HLS, DASH, Smooth Streaming). " +
          'Select "Auto" or "yt-dlp" as the download method.',
      });
      settle();
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

    // The browser path owns no native port, but its transfer is still a download the
    // user asked for, so it holds its gate slot until `chrome.downloads` reports it
    // complete or interrupted (`download/browser.ts`'s tracker calls `settle`). It used to
    // release the instant the item was created, so a batch of direct MP4s ran unbounded.
    try {
      return await browserDownload(deps, tabId, video, formatId, {
        jobId,
        pageUrl,
        requestHeaders,
        attemptedUrls: Array.from(attemptedUrls),
        backend,
        onFinished: settle,
      });
    } catch (error) {
      deps.updateDownload(jobId, { status: "error", error: (error as Error).message || String(error) });
      settle();
      return { jobId };
    }
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
    settle();
    return { jobId };
  }
  deps.downloadPortsById[jobId] = port;

  /**
   * The helper no longer has this task — it finished, crashed, or belongs to a helper
   * process that was restarted. A pause or cancel aimed at it is therefore already
   * true, and must not be read as a download failure: that used to run the whole source
   * fallback chain on a row the user had just asked to stop. A pause becomes the
   * interrupted state, so Resume relaunches it with `resume: true` over the `.part` file.
   */
  function handleGoneTask(): void {
    finished = true;
    delete deps.downloadPortsById[jobId];
    settle();
    const status = deps.getDownloadsById()[jobId]?.status;
    if (status === "canceling" || status === "canceled") {
      deps.updateDownload(jobId, { status: "canceled", stage: "", speed: "", eta: "", message: "Download canceled." });
    } else {
      deps.updateDownload(jobId, { status: "paused", speed: "", eta: "", message: INTERRUPTED_MESSAGE });
    }
    try {
      port.disconnect();
    } catch (_error) {}
  }

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
      if (message.status === "gone") {
        handleGoneTask();
        return;
      }
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
      settle();
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
      settle();
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
      const currentStatus = deps.getDownloadsById()[jobId]?.status;
      if ((currentStatus === "pausing" || currentStatus === "canceling") && GONE_TASK_ERROR_RE.test(errorText)) {
        handleGoneTask();
        return;
      }
      finished = true;
      delete deps.downloadPortsById[jobId];
      settle();
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
            // No `onSettled` here: the gate already released this job's slot when the
            // `error` message above settled it, and the retry is the same job id — handing
            // it a second slot would let one row hold two of them.
            await startNativeDownloadFromVideo(deps, tabId, fallbackVideo, "best", {
              jobId,
              attemptedUrls: Array.from(attemptedUrls),
              backend: fallbackVideo.backend || backend,
            });
          })().catch((fallbackError: unknown) => {
            // Without this the job sat on `connecting` forever: any throw in the
            // fallback search, the browser path or the recursive start was an unhandled
            // rejection with nothing left to finish the row.
            deps.updateDownload(jobId, {
              status: "error",
              stage: "",
              error: (fallbackError as Error)?.message || String(fallbackError) || errorText,
              ...artifactPatch,
            });
          });
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
    settle();
    if (!finished) {
      const errMsg = runtimeError || "Native messaging helper disconnected";
      deps.updateDownload(jobId, {
        status: "error",
        error: errMsg + ". Run scripts/install.sh, restart the browser, and try again.",
      });
    }
  });

  const settings = deps.getSettings();
  const wantsBest = !formatId || formatId === "best";
  port.postMessage({
    type: "download",
    id: jobId,
    url: video.url,
    format: video.format || "",
    // The host names stream-backend output files from this; without it every N_m3u8DL-RE
    // / Streamlink / ffmpeg job wrote to the same default name and collided.
    title: video.title || "",
    pageUrl,
    userAgent: deps.userAgent(),
    requestHeaders,
    downloadFolder: settings.downloadFolder || "",
    formatId: formatId || "best",
    backend,
    musicMode: settings.musicMode || false,
    audioFormat: settings.audioFormat || "mp3",
    downloadSubtitles: settings.downloadSubtitles !== false,
    // `Settings.preferredMaxHeight` caps `best` only: a batch, the overlay's one-click
    // button, a retry of either. A format the user picked in the quality dialog is sent
    // with `0`, because that choice already is the cap. Audio has no height.
    maxHeight: wantsBest && !settings.musicMode ? Number(settings.preferredMaxHeight) || 0 : 0,
    // ffmpeg's `-progress` block reports `out_time_ms` but never a total, so the host cannot
    // derive a percent without one (spec §3.3). It is the only duration source it has, and
    // without it the ffmpeg path emits a byte count and no bar — which is why it is sent
    // explicitly rather than left to the host to guess.
    duration: typeof video.duration === "number" && video.duration > 0 ? video.duration : 0,
  });

  // Still `connecting`, and only if nothing has answered yet: a fast `started`/`progress`
  // reply can land before this line, and overwriting it put a running job back on a
  // stale status. `queued` is not used here — it means "waiting for a gate slot" now.
  if (deps.getDownloadsById()[jobId]?.status === "connecting") {
    deps.updateDownload(jobId, { message: "Sent to native helper." });
  }

  return { jobId };
}
