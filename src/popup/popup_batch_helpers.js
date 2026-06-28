"use strict";

import * as PopupApi from "../shared/popup_api.js";
import * as PopupState from "../shared/popup_state.js";
import * as playlistDetection from "../shared/playlist_detection.js";
import { elements } from "./popup_elements.js";

// ─── Dependencies injected from popup_helpers.js ─────────────────────────
// These are set by popup_helpers.js after import to avoid circular deps.
/** @type {Function} */
let _setMessage;
/** @type {Function} */
let _setViewMode;
/** @type {Function} */
let _refresh;

/**
 * Initialize batch/playlist helpers with core UI functions from popup_helpers.js.
 * Called once at startup to break circular dependency.
 */
export function initBatchHelpers(deps) {
  _setMessage = deps.setMessage;
  _setViewMode = deps.setViewMode;
  _refresh = deps.refresh;
}

// ─── Batch UI ─────────────────────────────────────────────────────────────

export function updateBatchUI() {
  if (!elements.batchBar) {
    return;
  }

  const batchInfo = PopupState.get("batchInfo");
  if (!batchInfo || batchInfo.status === "idle" || batchInfo.status === "completed" || batchInfo.status === "canceled") {
    elements.batchBar.hidden = true;
    return;
  }

  elements.batchBar.hidden = false;

  if (elements.batchLabel) {
    elements.batchLabel.textContent = batchInfo.label || "";
  }

  if (elements.batchProgressFill) {
    const percent = batchInfo.percent || 0;
    elements.batchProgressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  if (elements.batchStatus) {
    const completed = batchInfo.completedItems || 0;
    const total = batchInfo.totalItems || 0;
    const failed = (batchInfo.failedItems && batchInfo.failedItems.length) || 0;

    if (batchInfo.status === "paused") {
      elements.batchStatus.textContent = `Paused — ${completed}/${total} complete`;
    } else if (failed > 0) {
      elements.batchStatus.textContent = `Downloading — ${completed}/${total} (${failed} failed)`;
    } else {
      elements.batchStatus.textContent = `Downloading — ${completed}/${total}`;
    }
  }

  if (elements.batchCancelBtn) {
    elements.batchCancelBtn.hidden = batchInfo.status === "completed" || batchInfo.status === "canceled";
  }
}

// ─── Playlist prompt UI ───────────────────────────────────────────────────

export function updatePlaylistPrompt() {
  if (!elements.playlistPrompt) {
    return;
  }

  const activeTabUrl = PopupState.get("activeTabUrl");
  if (!activeTabUrl) {
    elements.playlistPrompt.hidden = true;
    return;
  }

  if (!playlistDetection.isPlaylistPage(activeTabUrl)) {
    elements.playlistPrompt.hidden = true;
    return;
  }

  const batchInfo = PopupState.get("batchInfo");
  if (batchInfo && (batchInfo.status === "running" || batchInfo.status === "paused")) {
    elements.playlistPrompt.hidden = true;
    return;
  }

  const playlistTitle = playlistDetection.getPlaylistTitle(activeTabUrl);
  const source = playlistDetection.getPlaylistSource(activeTabUrl);

  elements.playlistPrompt.hidden = false;
  if (elements.playlistTitle) {
    elements.playlistTitle.textContent = playlistTitle || `${source.charAt(0).toUpperCase() + source.slice(1)} Playlist Detected`;
  }
}

// ─── Download all playlist ────────────────────────────────────────────────

export async function downloadAllPlaylist() {
  const activeTabUrl = PopupState.get("activeTabUrl");
  const tabId = PopupState.get("activeTabId");

  if (!activeTabUrl || !tabId) {
    _setMessage("No active tab found.", true);
    return;
  }

  elements.downloadAllBtn.disabled = true;
  elements.downloadAllBtn.textContent = "Enumerating...";

  const enumerateResponse = await PopupApi.enumeratePlaylist(activeTabUrl, tabId);

  if (!enumerateResponse || !enumerateResponse.ok) {
    _setMessage(
      enumerateResponse && enumerateResponse.error
        ? `Playlist enumeration failed: ${enumerateResponse.error}`
        : "Could not enumerate playlist items.",
      true,
    );
    elements.downloadAllBtn.disabled = false;
    elements.downloadAllBtn.textContent = "Download All";
    return;
  }

  const items = enumerateResponse.items || [];
  if (items.length === 0) {
    _setMessage("No items found in this playlist.", true);
    elements.downloadAllBtn.disabled = false;
    elements.downloadAllBtn.textContent = "Download All";
    return;
  }

  const videos = items.map((item) => ({
    id: item.id || `playlist_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    url: item.url,
    title: item.title || "Untitled",
    format: "",
    source: "playlist",
    pageUrl: activeTabUrl,
    downloadable: true,
  }));

  const batchResponse = await PopupApi.startBatchDownload(tabId, videos);

  if (!batchResponse || !batchResponse.ok) {
    _setMessage(
      batchResponse && batchResponse.error ? batchResponse.error : "Could not start batch download.",
      true,
    );
    elements.downloadAllBtn.disabled = false;
    elements.downloadAllBtn.textContent = "Download All";
    return;
  }

  elements.playlistPrompt.hidden = true;
  _setViewMode("downloads");
  await _refresh();
}
