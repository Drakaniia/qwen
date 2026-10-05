import * as tabState from "./tab_state.js";
import { cleanProgressText, normalizeDownloadProgress as normalizePercent } from "./download_state.js";
import * as videoUtils from "./video_utils.js";
import * as headerUtils from "./header_utils.js";
// R11: the service worker used to import this from `popup/popup_state.ts`, which only
// resolved because esbuild bundles the two into one IIFE. The definition moved to
// shared/ so neither layer has to know about the other.
import { ACTIVE_DOWNLOAD_STATUSES as BLOCKING_DOWNLOAD_STATUSES } from "../shared/download_statuses.js";
import type {
  DownloadFallbackDeps,
  DownloadJobRecord,
  JobPatch,
  NativeRequestFn,
  NativeResponse,
  NotifyPopup,
  TabId,
  VideoPatch,
  VideoRecord,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────

const HOST_NAME = "com.qwin.video_downloader";

// ── Download ports (shared mutable state) ────────────────────────────────

const downloadPortsById: Record<string, chrome.runtime.Port> = {};

// ── Download update helper ───────────────────────────────────────────────

function updateDownload(jobId: string, patch: JobPatch, notifyPopupFn?: NotifyPopup): void {
  void tabState.updateDownload(jobId, patch);
  // The write above is synchronous despite the promise `tabState.updateDownload`
  // returns, so the job is always readable here — the guard only satisfies
  // `DownloadUpdatedEvent`'s non-nullable `job`.
  const job = tabState.getDownload(jobId);
  if (notifyPopupFn && job) {
    notifyPopupFn({ type: "downloadUpdated", job });
  }
}

// ── Download progress helpers ────────────────────────────────────────────

/**
 * The job-specific rule on top of `download_state.ts`'s parsing: supply the stage
 * context D7 needs, which only the stored job has.
 *
 * What this *used* to be is worth recording, because the old comment here was a lie
 * after D7 and the lie was load-bearing. It read "a segmented job reports tool
 * progress directly, while a plain file job gets the monotonic clamp", which is the
 * `useToolPercent` bypass: segmented jobs (`M3U8`/`MPD`/`HLS_RE`/`DASH_RE`, via
 * `isSegmentedDownloadJob`) skipped the clamp entirely and showed the tool's percent
 * raw — so a segmented bar walked backwards while a plain file bar did not. D7
 * replaces the special case with one rule for every job (spec §4.2): a percent never
 * decreases within a stage, and a new stage resets the baseline. That retired
 * `visibleDownloadProgressPercent` and left `isSegmentedDownloadJob` with no caller,
 * so it was deleted rather than left exported (AGENTS.md: "Do not add dead exports").
 *
 * `nextStage` is optional and omitted by the browser-download path
 * (`download/browser.ts`), which never changes `stage` mid-transfer — an empty value
 * therefore means "no stage information", not "stage became empty", and never resets.
 */
function normalizeDownloadProgress(jobId: string, percent: unknown, nextStage?: unknown): number | null {
  const job = tabState.getDownload(jobId);
  const currentStage = String(job?.stage || "").trim();
  const incomingStage = String(nextStage || "").trim();
  const stageChanged = incomingStage !== "" && incomingStage !== currentStage;
  return normalizePercent(job?.percent, percent, stageChanged);
}

// ── Artifact helpers ─────────────────────────────────────────────────────

function artifactPatchFromMessage(message: NativeResponse): JobPatch {
  const patch = {
    filepath: message.filepath,
    artifactRoot: message.artifactRoot,
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value));
}

function cleanupPatchFromMessage(message: NativeResponse): JobPatch {
  const patch = {
    artifactCleanupDeleted: Array.isArray(message.artifactCleanupDeleted) ? message.artifactCleanupDeleted : undefined,
    artifactCleanupMissing: Array.isArray(message.artifactCleanupMissing) ? message.artifactCleanupMissing : undefined,
    artifactCleanupError: cleanProgressText(message.artifactCleanupError),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== ""));
}

function clearedArtifactPatch(cleanupPatch: JobPatch): JobPatch {
  const deleted = cleanupPatch.artifactCleanupDeleted;
  return Array.isArray(deleted) && deleted.length ? { filepath: "", artifactRoot: "", artifactPaths: [] } : {};
}

function hasDownloadArtifacts(job: DownloadJobRecord): boolean {
  return Boolean(job?.filepath || job?.artifactRoot || (Array.isArray(job?.artifactPaths) && job.artifactPaths.length));
}

async function cleanupDownloadArtifacts(
  jobId: string,
  job: DownloadJobRecord,
  nativeRequestFn: NativeRequestFn,
): Promise<JobPatch> {
  if (!hasDownloadArtifacts(job)) {
    return {};
  }

  const requestId = `delete_${jobId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const response = await nativeRequestFn(
      {
        type: "deleteArtifacts",
        id: requestId,
        path: job.filepath || "",
        artifactRoot: job.artifactRoot || "",
        artifactPaths: job.artifactPaths || [],
        downloadFolder: job.downloadFolder || tabState.getSettings().downloadFolder || "",
      },
      30000,
    );
    return {
      artifactCleanupDeleted: response.deleted || [],
      artifactCleanupMissing: response.missing || [],
    };
  } catch (error) {
    return {
      artifactCleanupError: cleanProgressText((error as Error)?.message || String(error)),
    };
  }
}

// ── Fallback helpers ─────────────────────────────────────────────────────
//
// The error mappers and the fallback *search* live in `download_fallbacks.ts` and are
// imported from there directly. They used to be re-exported here one-for-one, which
// gave every caller two names for one function and neither name was load-bearing.

// ── Fallback wrappers (accept deps to avoid closure coupling) ────────────

/**
 * Mark a video URL as unavailable. Accepts optional getVisibleVideosFn and
 * notifyPopupFn for notifying the popup of the change.
 */
async function markVideoUrlUnavailable(
  tabId: TabId,
  url: string,
  error: unknown,
  getVisibleVideosFn?: (tabId: TabId) => VideoRecord[],
  notifyPopupFn?: NotifyPopup,
): Promise<boolean> {
  const targetUrl = headerUtils.normalizeUrl(url);
  const patch: VideoPatch = {
    downloadable: false,
    blockedReason: String(error || "The server refused this source.").slice(0, 500),
    lastSeen: Date.now(),
  };
  const changed = await tabState.patchVideo(
    tabId,
    (item) => headerUtils.normalizeUrl(item.url || "") === targetUrl && item.downloadable !== false,
    patch,
  );
  if (changed && notifyPopupFn) {
    notifyPopupFn({ type: "videoListUpdated", tabId, videos: getVisibleVideosFn ? getVisibleVideosFn(tabId) : [] });
  }
  return changed;
}

// ── Variant helpers ──────────────────────────────────────────────────────

function variantsForVideo(video: VideoRecord): VideoRecord[] {
  return Array.isArray(video.variants) && video.variants.length ? video.variants : [video];
}

function preferredNativeVideo(video: VideoRecord): VideoRecord {
  const variants = variantsForVideo(video);
  return (
    variants.find((variant) => ["M3U8", "MPD"].includes(String(variant.format || "").toUpperCase())) ||
    variants[0] ||
    video
  );
}

function findGroupedVideoForAnyVariant(
  tabId: TabId,
  video: VideoRecord,
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
): VideoRecord | undefined {
  const ids = new Set<string>();
  if (video && video.id) {
    ids.add(video.id);
  }
  if (video && video.groupId) {
    ids.add(video.groupId);
  }
  for (const variant of variantsForVideo(video)) {
    if (variant && variant.id) {
      ids.add(variant.id);
    }
  }

  return getVisibleVideosFn(tabId).find((item) => {
    if (ids.has(item.id)) {
      return true;
    }
    return variantsForVideo(item).some((variant) => ids.has(variant.id));
  });
}

function findGroupedVideoForVariant(
  tabId: TabId,
  variant: VideoRecord,
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
): VideoRecord | undefined {
  return getVisibleVideosFn(tabId).find((video) => variantsForVideo(video).some((item) => item.id === variant.id));
}

function findVariant(video: VideoRecord, variantId: string): VideoRecord | null {
  if (!variantId) {
    return preferredNativeVideo(video);
  }
  return variantsForVideo(video).find((variant) => variant.id === variantId) || null;
}

// ── Fallback deps building ──────────────────────────────────────────────

function buildDownloadFallbackDeps(
  nativeRequestFn: NativeRequestFn,
  addDetectedVideoFn: DownloadFallbackDeps["addDetectedVideo"],
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
  headersFn?: DownloadFallbackDeps["nativeRequestHeadersForVideo"],
): DownloadFallbackDeps {
  return {
    addDetectedVideo: addDetectedVideoFn,
    detectFormat: videoUtils.detectFormat,
    findGroupedVideoForAnyVariant: (tabId, video) => findGroupedVideoForAnyVariant(tabId, video, getVisibleVideosFn),
    getVisibleVideosForTab: getVisibleVideosFn,
    hashId: videoUtils.hashId,
    isDownloadableUrl: videoUtils.isDownloadableUrl,
    nativeRequest: nativeRequestFn,
    nativeRequestHeadersForVideo: headersFn || headerUtils.nativeRequestHeadersForVideo,
    normalizeUrl: headerUtils.normalizeUrl,
    titleFromUrl: videoUtils.titleFromUrl,
    userAgent: navigator.userAgent || "",
    variantsForVideo,
  };
}

export {
  BLOCKING_DOWNLOAD_STATUSES,
  HOST_NAME,
  downloadPortsById,
  updateDownload,
  normalizeDownloadProgress,
  artifactPatchFromMessage,
  cleanupPatchFromMessage,
  clearedArtifactPatch,
  cleanupDownloadArtifacts,
  markVideoUrlUnavailable,
  variantsForVideo,
  preferredNativeVideo,
  findGroupedVideoForAnyVariant,
  findGroupedVideoForVariant,
  findVariant,
  buildDownloadFallbackDeps,
};
