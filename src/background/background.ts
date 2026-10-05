import { browserApi } from "../shared/browser_api.js";
import * as videoFilters from "../shared/video_filters.js";
import * as tabState from "./tab_state.js";
import * as nativeRequestsMod from "./native_requests.js";
import * as downloadSync from "../shared/download_sync.js";
import { create as createMessageRouter, register } from "./message_router.js";
import { create as createDownloadOrchestration } from "./download/index.js";

// ── Extracted modules ────────────────────────────────────────────────────

import * as headerUtils from "./header_utils.js";
import * as videoUtils from "./video_utils.js";
import * as filterIntegration from "./filter_integration.js";
import * as sizeProbe from "./size_probe.js";
import * as downloadHelpers from "./download_helpers.js";
import * as formatHelpers from "./format_helpers.js";
// `download_helpers.ts` used to re-export these four, so they were read off that
// namespace here. They are the *only* progress/error primitives `download_state.ts`
// and `download_fallbacks.ts` own, so they are named at their real home now — one
// module per concern, no second name for the same function.
import {
  downloadProgressMessage,
  progressDetailPatchFromMessage,
  resetDownloadProgressDetails,
} from "./download_state.js";
import {
  exhaustedSourcesError,
  fallbackVideoForDownload,
  isHardAccessError,
  isRetryableSourceError,
  pageFallbackVideoForSource,
  userFriendlyDownloadError,
} from "./download_fallbacks.js";

// ── Newly extracted modules ──────────────────────────────────────────────

import { initWebRequestHandlers } from "./background_webrequest.js";
import { registerAllHandlers } from "./message-handlers/index.js";
import { runInit } from "./background_init.js";
import { clearCaptures, rememberCaptures, withCaptures } from "./thumbnail_captures.js";
import { create as createThumbnailFrames } from "./thumbnail_frames.js";
import type {
  BackgroundContext,
  DownloadJobRecord,
  DownloadOrchestratorDeps,
  ExtensionApi,
  MessageOf,
  BackgroundMessageType,
  NativeRequestFn,
  NotifyPopup,
  TabId,
  VideoInput,
  VideoRecord,
} from "./types.js";

// ── Re-exports for message handlers ──────────────────────────────────────

const { normalizeUrl, nativeRequestHeadersForVideo } = headerUtils;

const {
  hashId,
  detectFormat,
  contentTypeFromHeaders,
  contentLengthFromHeaders,
  isDownloadableUrl,
  isLikelyVideoRequest,
  VIDEO_EXTENSION_RE,
  HLS_RE,
  CDN_HINT_RE,
} = videoUtils;

const { isBlockedUrlWithFilters } = filterIntegration;

// Same idiom as the `headerUtils` / `videoUtils` / `filterIntegration` destructures
// above, and deliberately so: `HOST_NAME`, `BLOCKING_DOWNLOAD_STATUSES` and
// `downloadPortsById` used to be re-read as `downloadHelpers.*` further down, giving
// those three two bindings for one value. The namespace itself survives only as the
// `downloadHelpers` member of `handlerContext`, which the `Pick<>` in `types.ts`
// requires whole.
const {
  BLOCKING_DOWNLOAD_STATUSES,
  HOST_NAME,
  artifactPatchFromMessage,
  buildDownloadFallbackDeps,
  cleanupDownloadArtifacts,
  cleanupPatchFromMessage,
  clearedArtifactPatch,
  downloadPortsById,
  findVariant,
  markVideoUrlUnavailable,
  normalizeDownloadProgress,
  updateDownload,
  variantsForVideo,
} = downloadHelpers;

// formatHelpers destructured directly at usage sites

// ── Raw API object for native_requests.ts ────────────────────────────────

const api = browserApi.raw;
const messageRouter = createMessageRouter();

// ── State ────────────────────────────────────────────────────────────────

const pageTitlesByTab: Record<number, string> = {};

function setPageTitle(tabId: TabId, title: string): void {
  if (title) pageTitlesByTab[tabId as number] = title;
}

headerUtils.setBlockedUrlCheck(isBlockedUrlWithFilters);

// ── Popup notification ───────────────────────────────────────────────────

function notifyPopup(message: Parameters<NotifyPopup>[0]): void {
  void Promise.resolve(browserApi.runtime.sendMessage(message)).catch(() => {});
}

// ── Visible video helpers ────────────────────────────────────────────────

function getVisibleVideosForTab(tabId: TabId): VideoRecord[] {
  // `groupUniqueFullVideos` types its input as `unknown` and hands back the shared
  // `GroupedVideo`, which widens `id` to optional and every numeric field to
  // `number | string`. Every candidate reaching this point was written by
  // `addDetectedVideo` below, which always sets `id` and always writes real numbers,
  // so the widening is an artefact of the shared grouping layer's own input type —
  // not a different runtime shape. Re-widened here so the rest of the background can
  // rely on `contracts.ts`.
  const grouped = videoFilters.groupUniqueFullVideos(tabState.getVideosForTab(tabId)) as VideoRecord[];
  // The one funnel every popup-facing video list leaves through — the
  // `videoListUpdated` notification, the `getVideos` reply and the fallback
  // search all read this, so re-attaching the memory-only frame captures here
  // (D10: they are never on the stored record) covers them all in one place.
  return withCaptures(tabId as number, grouped);
}

// ── Core video detection ─────────────────────────────────────────────────

async function addDetectedVideo(tabId: TabId, input: VideoInput, notify = true): Promise<VideoRecord | null> {
  if (!Number.isInteger(tabId) || (tabId as number) < 0 || !input || !input.url) {
    return null;
  }

  await tabState.load();

  const normalizedUrl = normalizeUrl(input.url);
  if (isBlockedUrlWithFilters(normalizedUrl, input.contentType)) {
    return null;
  }

  const format = input.format || detectFormat(normalizedUrl, input.contentType);
  const id = hashId(normalizedUrl);
  const now = Date.now();
  const existing = tabState.getVideosForTab(tabId);
  const current = existing.find((item) => item.id === id);
  const width = Number(input.width || 0);
  const height = Number(input.height || 0);
  const duration = Number(input.duration || 0);
  const bitrate = Number(input.bitrate || input.tbr || 0);
  const isPlaylist = videoUtils.isPlaylistVideo({ url: normalizedUrl, format, contentType: input.contentType || "" });
  const sizeBytes = isPlaylist ? 0 : Number(input.sizeBytes || input.filesize || 0);

  const inputTitle = input.title || "";
  const currentTitle = current?.title || "";
  const isGenericInput = videoFilters.isGenericTitle(inputTitle);
  const isGenericCurrent = videoFilters.isGenericTitle(currentTitle);

  const urlDerivedTitle = videoUtils.titleFromUrl(normalizedUrl);
  const finalTitle = (function () {
    const candidate =
      (!isGenericInput && inputTitle) || (!isGenericCurrent && currentTitle) || inputTitle || urlDerivedTitle;
    if (
      videoFilters.isGenericTitle(candidate) ||
      (candidate === urlDerivedTitle && videoUtils.looksLikeServerToken(urlDerivedTitle))
    ) {
      const pageTitle = pageTitlesByTab[tabId as number];
      if (pageTitle && !videoFilters.isGenericTitle(pageTitle)) {
        return pageTitle;
      }
    }
    return candidate;
  })();

  // The content script's ladder arrives whole (spec §3) but its `data:` frame
  // capture must not reach `storage.local` — tens of KB of base64 per video, per
  // tab, for bytes that only mean anything while the page is open (D10). Stash it
  // in service-worker memory first, then persist the `http(s):` half only.
  rememberCaptures(tabId as number, [{ id, thumbnailCandidates: input.thumbnailCandidates }]);
  const persistedCandidates = (input.thumbnailCandidates || current?.thumbnailCandidates || []).filter(
    (url) => !url.startsWith("data:"),
  );

  const nextVideo: VideoRecord = {
    id,
    url: normalizedUrl,
    format,
    source: input.source || "network",
    title: finalTitle,
    pageUrl: input.pageUrl || input.frameUrl || "",
    frameUrl: input.frameUrl || "",
    contentType: input.contentType || "",
    downloadable: current?.downloadable === false ? false : isDownloadableUrl(normalizedUrl, input.contentType),
    width: Number.isFinite(width) && width > 0 ? width : current?.width || null,
    height: Number.isFinite(height) && height > 0 ? height : current?.height || null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : current?.duration || null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : current?.bitrate || null,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : current?.sizeBytes || null,
    thumbnailUrl: input.thumbnailUrl || current?.thumbnailUrl || "",
    // `undefined` rather than `[]` when the whole ladder was captures: an empty
    // array would read as "this row has art, all of it broken" to the popup.
    thumbnailCandidates: persistedCandidates.length ? persistedCandidates : undefined,
    firstSeen: current ? current.firstSeen : now,
    lastSeen: now,
  };

  if (!videoFilters.isLikelyFullLengthVideoCandidate(nextVideo)) {
    await tabState.setVideosForTab(
      tabId,
      existing.filter((item) => item.id !== id),
    );
    if (notify) {
      notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    }
    return null;
  }

  let nextList: VideoRecord[];
  if (current) {
    nextList = existing.map((item) => (item.id === id ? { ...item, ...nextVideo } : item));
  } else {
    nextList = [nextVideo, ...existing];
  }

  await tabState.setVideosForTab(
    tabId,
    nextList
      .sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0))
      .slice(0, videoUtils.MAX_VIDEOS_PER_TAB),
  );

  if (notify) {
    notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
  }
  sizeProbe.scheduleVideoSizeProbe(tabId, nextVideo);
  return nextVideo;
}

// ── Tab management ───────────────────────────────────────────────────────

async function clearTab(tabId: TabId): Promise<void> {
  delete pageTitlesByTab[tabId as number];
  clearCaptures(tabId as number);
  thumbnailFrames.clearTab(tabId);
  await tabState.load();
  await tabState.removeTab(tabId);
  notifyPopup({ type: "videoListUpdated", tabId, videos: [] });
}

async function getTabVideos(tabId: TabId): Promise<VideoRecord[]> {
  await tabState.load();
  sizeProbe.scheduleMissingSizeProbes(tabId);
  return getVisibleVideosForTab(tabId);
}

/**
 * Every job, newest first. Global on purpose — a download belongs to the machine, not to
 * the tab that started it. `job.tabId` is provenance for the tray's site chip, not a filter.
 */
async function getAllDownloadsSorted(): Promise<DownloadJobRecord[]> {
  await tabState.load();
  return Object.values(tabState.getAllDownloads()).sort(
    (left, right) => (right.updatedAt || 0) - (left.updatedAt || 0),
  );
}

// ── Fallback deps (closure over background functions) ────────────────────

function downloadFallbackDeps(): ReturnType<typeof buildDownloadFallbackDeps> {
  return buildDownloadFallbackDeps(
    nativeRequest,
    addDetectedVideo,
    getVisibleVideosForTab,
    nativeRequestHeadersForVideo,
  );
}

// ── Sender tab ID helper ─────────────────────────────────────────────────

function senderTabId(message: MessageOf<BackgroundMessageType>, sender: chrome.runtime.MessageSender): TabId {
  // Read through a widening: three of the wire messages (`getFormatsForUrl`,
  // `saveSettings`, `proxyFetch`) carry no `tabId` at all, so the union itself has
  // no such property to read.
  const tabId = (message as { tabId?: number }).tabId;
  return tabId || (sender.tab && sender.tab.id);
}

// ── Native request wrapper ───────────────────────────────────────────────

function nativeRequest(payload: Parameters<NativeRequestFn>[0], timeoutMs?: number) {
  return nativeRequestsMod.nativeRequest(api as ExtensionApi, HOST_NAME, payload, timeoutMs);
}

// ── HLS frame grabs ──────────────────────────────────────────────────────
//
// One instance, because the H9 budget and the by-URL frame cache are the service's own
// mutable state (hls-thumbnail-spec.md §5). `clearTab` and `onTabRemoved` drop a tab's
// budget counter beside `clearCaptures`, since a tab with no videos has nothing to grab.

const thumbnailFrames = createThumbnailFrames({
  nativeRequest,
  notifyPopup,
  getVisibleVideosForTab,
  getVideosForTab: (tabId) => tabState.getVideosForTab(tabId),
  nativeRequestHeadersForVideo,
  rememberCaptures,
});

// ── Download orchestration wiring ────────────────────────────────────────

function downloadOrchestrationDeps(): DownloadOrchestratorDeps {
  return {
    api: api as ExtensionApi,
    addDetectedVideo,
    artifactPatchFromMessage,
    blockingDownloadStatuses: BLOCKING_DOWNLOAD_STATUSES,
    callTabsQuery: browserApi.tabs.query,
    cleanupDownloadArtifacts: (jobId, job) => cleanupDownloadArtifacts(jobId, job, nativeRequest),
    cleanupPatchFromMessage,
    clearedArtifactPatch,
    detectFormat,
    downloadPortsById,
    downloadProgressMessage,
    ensureStateLoaded: tabState.load,
    exhaustedSourcesError,
    fallbackVideoForDownload: (tabId, failedVideo, attemptedUrls) =>
      fallbackVideoForDownload(tabId, failedVideo, attemptedUrls, downloadFallbackDeps()),
    findVariant,
    getDownloadsById: () => tabState.getAllDownloads(),
    getSettings: () => tabState.getSettings(),
    getTabVideos,
    hashId,
    hostName: HOST_NAME,
    isHardAccessError,
    isRetryableSourceError,
    markVideoUrlUnavailable,
    nativeRequest,
    nativeRequestHeadersForVideo,
    normalizeDownloadProgress,
    normalizeUrl,
    notifyPopup,
    pageFallbackVideoForSource: (video, attemptedUrls) =>
      pageFallbackVideoForSource(video, attemptedUrls, downloadFallbackDeps()),
    persistDownloads: tabState.persistDownloads,
    persistSettings: tabState.persistSettings,
    progressDetailPatchFromMessage,
    resetDownloadProgressDetails,
    setDownloadsById(nextDownloadsById) {
      tabState.setAllDownloads(nextDownloadsById);
    },
    setSettings(nextSettings) {
      void tabState.setSettings(nextSettings);
    },
    titleFromUrl: videoUtils.titleFromUrl,
    updateDownload: (jobId, patch) => updateDownload(jobId, patch, notifyPopup),
    userAgent: () => navigator.userAgent || "",
    userFriendlyDownloadError,
    variantsForVideo,
    videoFilters,
    // Replaced by `download/index.ts` before any call can reach it.
    startNativeDownloadFromVideo: () => {
      throw new Error("background.ts: startNativeDownloadFromVideo was not wired up.");
    },
  };
}

let downloadOrchestration: ReturnType<typeof createDownloadOrchestration> | null = null;
function getDownloadOrchestration() {
  if (!downloadOrchestration) {
    downloadOrchestration = createDownloadOrchestration(downloadOrchestrationDeps());
  }
  return downloadOrchestration;
}

async function startNativeDownload(tabId: TabId, videoId: string, formatId = "best", variantId = "", backend = "auto") {
  return getDownloadOrchestration().startNativeDownload(tabId, videoId, formatId, variantId, backend);
}

async function startNativeDownloadForUrl(tabId: TabId, input: VideoInput) {
  return getDownloadOrchestration().startNativeDownloadForUrl(tabId, input);
}

async function getBestDownloadableVideo(tabId: TabId) {
  return getDownloadOrchestration().getBestDownloadableVideo(tabId);
}

async function startBestNativeDownload(tabId: TabId, formatId = "best", variantId = "") {
  return getDownloadOrchestration().startBestNativeDownload(tabId, formatId, variantId);
}

function controlActiveDownload(jobId: string, nativeType: string) {
  return getDownloadOrchestration().controlActiveDownload(jobId, nativeType);
}

async function resumeDownload(tabId: TabId, jobId: string) {
  return getDownloadOrchestration().resumeDownload(tabId, jobId);
}

async function cancelDownload(tabId: TabId, jobId: string) {
  return getDownloadOrchestration().cancelDownload(tabId, jobId);
}

async function retryDownload(tabId: TabId, jobId: string) {
  return getDownloadOrchestration().retryDownload(tabId, jobId);
}

async function openDownloadedPath(jobId: string, nativeType: "openFile" | "showFile") {
  return getDownloadOrchestration().openDownloadedPath(jobId, nativeType);
}

async function chooseDownloadFolder() {
  return getDownloadOrchestration().chooseDownloadFolder();
}

async function removeDownload(jobId: string) {
  return getDownloadOrchestration().removeDownload(jobId);
}

async function clearDownloads() {
  return getDownloadOrchestration().clearDownloads();
}

// ── Imported helper-ping module ────────────────────────────────────────

import { HELPER_PING_INTERVAL_MS, refreshCachedHelperStatus, pingNativeHost } from "./background_helper_ping.js";

// ── CORS proxy: content script fetch requests ──────────────────────────
//
// Coc Coc's approach: when content scripts encounter CORS-blocked media
// URLs, they proxy the request through the background service worker.
// The background worker has no CORs restrictions and can fetch any URL.
//
// Message format:
//   { type: "proxyFetch", url: string, method?: string, headers?: object }
// Response:
//   { ok: true, body: string, contentType: string }
//   { ok: false, error: string }
//
// Registered here rather than in `message-handlers/` because it needs no part of the
// context object — it is the one handler the entry point owns outright.

register({
  name: "proxyFetch",
  async handle(message: MessageOf<"proxyFetch">) {
    const method = message.method || "GET";
    const url = message.url;
    if (!url) {
      return { ok: false, error: "Missing URL" };
    }

    try {
      const fetchHeaders: Record<string, string> = { Accept: "*/*" };
      if (message.headers && typeof message.headers === "object") {
        Object.assign(fetchHeaders, message.headers);
      }

      const response = await fetch(url, {
        method,
        headers: fetchHeaders,
        credentials: message.includeCredentials ? "include" : "omit",
      });

      const contentType = response.headers.get("Content-Type") || "";
      const body = await response.text();

      return {
        ok: true,
        body,
        contentType,
        status: response.status,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message || String(error) };
    }
  },
});

// ── Wire webRequest handlers ─────────────────────────────────────────────

initWebRequestHandlers({
  clearTab,
  addDetectedVideo,
  detectFormat,
  isLikelyVideoRequest,
  isBlockedMediaUrl: videoFilters.isBlockedVideoUrl,
  VIDEO_EXTENSION_RE,
  HLS_RE,
  CDN_HINT_RE,
  contentTypeFromHeaders,
  contentLengthFromHeaders,
});

// ── Wire message handlers ────────────────────────────────────────────────

const handlerContext: BackgroundContext = {
  // Core helpers
  senderTabId,
  notifyPopup,
  getVisibleVideosForTab,
  addDetectedVideo,
  clearTab,
  getTabVideos,
  getAllDownloadsSorted,

  // HLS frame grabs (hls-thumbnail-spec.md §5)
  thumbnailFrames,

  // Download orchestration
  nativeRequest,
  startNativeDownload,
  startNativeDownloadForUrl,
  getBestDownloadableVideo,
  startBestNativeDownload,
  controlActiveDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  openDownloadedPath,
  chooseDownloadFolder,
  removeDownload,
  clearDownloads,

  // Imported modules
  downloadSync,
  tabState,
  browserApi,
  downloadHelpers,
  formatHelpers,

  // Page title management
  setPageTitle,

  // Background helper ping exports
  // `cachedHelperStatus` is deliberately NOT here: it is a mutable `let`, and putting
  // it in this object snapshotted it, so every handler that destructured it read the
  // value from before the first probe and never saw an update. `message-handlers/
  // settings.ts` imports the live binding directly instead.
  HELPER_PING_INTERVAL_MS,
  refreshCachedHelperStatus,
  pingNativeHost,

  // Shared constants
  HOST_NAME,
};

registerAllHandlers(handlerContext);

// ── Wire message router to runtime ───────────────────────────────────────

browserApi.onMessage((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
  return messageRouter.dispatch(message, sender, sendResponse);
});

// Tab lifecycle
browserApi.onTabRemoved((tabId: number) => {
  clearCaptures(tabId);
  thumbnailFrames.clearTab(tabId);
  void tabState.removeTab(tabId);
});

browserApi.onTabUpdated((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
  if (changeInfo.title) {
    pageTitlesByTab[tabId] = changeInfo.title;
  }
  if (changeInfo.status === "loading") {
    void clearTab(tabId);
    delete pageTitlesByTab[tabId];
  }
});

// ── Initialize background service worker ─────────────────────────────────

runInit({ notifyPopup, HOST_NAME });
