/**
 * The popup's message contract.
 *
 * Promise/callback plumbing lives in the browser-namespace shim; these two names are
 * the message contract the popup and the downloads page depend on.
 *
 * Every function here is `runtimeMessage` with a fixed `type`, and every return is
 * {@link MessageResult}: the payloads are typed where they are *read*
 * (`popup/downloads/state.ts`, `popup/options/state.ts` narrow through `asRecord`)
 * because `contracts.ts` deliberately does not enumerate response envelopes — the
 * background normalizes every handler result to `{ ok: true }` / `{ ok: false, error }`.
 */
import { browserApi, queryActiveTabs, sendMessage as sendRuntimeMessage, type MessageResult } from "./browser_api.js";
import type { Settings } from "./contracts.js";

/**
 * Send a runtime message to the background script.
 */
function runtimeMessage(message: unknown): Promise<MessageResult> {
  return sendRuntimeMessage(message);
}

/**
 * Query active tabs in the current window.
 */
function tabsQuery(): Promise<chrome.tabs.Tab[]> {
  return queryActiveTabs();
}

// ─── Video queries ────────────────────────────────────────────────────────

/** @param tabId */
function getVideos(tabId: number): Promise<MessageResult> {
  return runtimeMessage({ type: "getVideos", tabId });
}

/** @param tabId @param videoId */
function getVideoFormats(tabId: number, videoId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "getVideoFormats", tabId, videoId });
}

/**
 * @param tabId @param video — forwarded verbatim; the background validates it against
 *   `contracts.ts`'s `GetFormatsForUrlMessage`, so this layer stays `unknown`.
 */
function getFormatsForUrl(tabId: number, video?: unknown): Promise<MessageResult> {
  return runtimeMessage({ type: "getFormatsForUrl", tabId, video });
}

// ─── Stream frame grabs (hls-thumbnail-spec.md §6.1, §5.3) ──────────────────

/**
 * Ask the helper for one frame of a video whose thumbnail ladder is out (H3, lazy).
 *
 * Fire-and-forget at every call site: the row already shows the correct glyph while
 * the grab runs, and the frame arrives as a `videoListUpdated` broadcast (H8).
 *
 * @param tabId @param videoId
 */
function grabThumbnailFrame(tabId: number, videoId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "grabThumbnailFrame", tabId, videoId });
}

/**
 * Cached frames for a whole list of URLs — one message, not one per row (§5.3).
 *
 * Misses are absent from `frames`; the caller's row keeps its glyph. Lookups only:
 * this never spawns a grab, so it is safe to call with every visible URL.
 *
 * @param urls
 */
function thumbnailFrames(urls: string[]): Promise<MessageResult> {
  return runtimeMessage({ type: "thumbnailFrames", urls });
}

/**
 * Ask the content script to re-attempt in-page canvas captures (§3.2, H11 part 2).
 *
 * Not a background message — it goes straight into the tab, because the work is
 * entirely in the page. Never await it: the popup must not block first paint on a
 * scan, and the updated candidates arrive as the normal detection broadcast.
 *
 * @param tabId
 */
function rescanForFrames(tabId: number): Promise<MessageResult | null> {
  return browserApi.tabs.sendMessage(tabId, { type: "rescanForFrames" });
}

// ─── Tab scanning ─────────────────────────────────────────────────────────

/** @param tabId */
function rescanTab(tabId: number): Promise<MessageResult> {
  return runtimeMessage({ type: "rescanTab", tabId });
}

/** @param tabId */
function clearVideos(tabId: number): Promise<MessageResult> {
  return runtimeMessage({ type: "clearVideos", tabId });
}

/** @param tabId */
function clearDownloads(tabId: number): Promise<MessageResult> {
  return runtimeMessage({ type: "clearDownloads", tabId });
}

// ─── Download actions ─────────────────────────────────────────────────────

/**
 * Start a download for one format of one video.
 *
 * @param tabId @param videoId @param formatId @param variantId @param backend
 */
function downloadVideo(
  tabId: number,
  videoId: string,
  formatId?: string,
  variantId?: string,
  backend?: string,
): Promise<MessageResult> {
  return runtimeMessage({
    type: "downloadVideo",
    tabId,
    videoId,
    formatId,
    variantId: variantId || "",
    backend: backend || "auto",
  });
}

/** @param tabId @param jobId */
function pauseDownload(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "pauseDownload", tabId, jobId });
}

/** @param tabId @param jobId */
function resumeDownload(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "resumeDownload", tabId, jobId });
}

/** @param tabId @param jobId */
function cancelDownload(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "cancelDownload", tabId, jobId });
}

/** @param tabId @param jobId */
function retryDownload(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "retryDownload", tabId, jobId });
}

/** @param tabId @param jobId */
function openDownloadedFile(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "openDownloadedFile", tabId, jobId });
}

/** @param tabId @param jobId */
function showDownloadedFile(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "showDownloadedFile", tabId, jobId });
}

/** @param tabId @param jobId */
function removeDownload(tabId: number, jobId: string): Promise<MessageResult> {
  return runtimeMessage({ type: "removeDownload", tabId, jobId });
}

// ─── Settings / misc ──────────────────────────────────────────────────────

/**
 * Merge a settings patch. The background merges rather than replaces, so one field
 * is a safe write.
 *
 * @param settings
 */
function saveSettings(settings: Partial<Settings>): Promise<MessageResult> {
  return runtimeMessage({ type: "saveSettings", settings });
}

function chooseDownloadFolder(): Promise<MessageResult> {
  return runtimeMessage({ type: "chooseDownloadFolder" });
}

function pingNativeHost(): Promise<MessageResult> {
  return runtimeMessage({ type: "pingNativeHost" });
}

/**
 * Get the cached native helper status from the background.
 * Returns { connected, version, dependencies, lastChecked }.
 */
function getHelperStatus(): Promise<MessageResult> {
  return runtimeMessage({ type: "getHelperStatus" });
}

// ─── Download History Sync ────────────────────────────────────────────────

/**
 * Get the synced download history from storage.sync.
 * Returns `{ ok, history, syncInfo }`.
 */
function getDownloadSyncHistory(): Promise<MessageResult> {
  return runtimeMessage({ type: "getDownloadSyncHistory" });
}

/**
 * Set whether download history syncing is enabled.
 *
 * @param enabled — omitted means enabled, hence the optional.
 */
function setDownloadSyncEnabled(enabled?: boolean): Promise<MessageResult> {
  return runtimeMessage({ type: "setDownloadSyncEnabled", enabled });
}

/**
 * Clear the synced download history.
 */
function clearDownloadSyncHistory(): Promise<MessageResult> {
  return runtimeMessage({ type: "clearDownloadSyncHistory" });
}

export {
  runtimeMessage,
  tabsQuery,
  getVideos,
  getVideoFormats,
  getFormatsForUrl,
  grabThumbnailFrame,
  thumbnailFrames,
  rescanForFrames,
  rescanTab,
  clearVideos,
  clearDownloads,
  downloadVideo,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  openDownloadedFile,
  showDownloadedFile,
  removeDownload,
  saveSettings,
  chooseDownloadFolder,
  pingNativeHost,
  getHelperStatus,
  // Download History Sync
  getDownloadSyncHistory,
  setDownloadSyncEnabled,
  clearDownloadSyncHistory,
};
