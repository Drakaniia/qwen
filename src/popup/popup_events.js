"use strict";

// ─── Side-effect imports: register event listeners in sub-modules ───────────
import "./popup_url_events.js";
import "./popup_background_events.js";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupApi from "../shared/popup_api.js";
import * as PopupState from "../shared/popup_state.js";
import * as DownloadList from "./download_list.js";
import { elements } from "./popup_elements.js";
import {
  hasActiveTab,
  setMessage,
  setViewMode,
  setVideoLayoutMode,
  hideQualityDialog,
  showQualityLoading,
  isCurrentQualityRequest,
  chooseQuality,
  refresh,
  rescanActiveTab,
  clearActiveTabVideos,
  downloadAllPlaylist,
  updateActiveTabContext,
  shortenUrl,
  updateBatchUI,
  updatePlaylistPrompt,
  renderSyncedHistory,
  updateIndicatorFromVideos,
} from "./popup_helpers.js";
import { renderVideos as renderVideosFn } from "./popup_renderer.js";

// ─── Orchestrator: render ───────────────────────────────────────────────────

function render() {
  const state = PopupState.getState();
  const mode = state.viewMode;

  let filteredVideos = state.currentVideos;
  if (filteredVideos === null) {
    return;
  }

  if (mode === "videos") {
    filteredVideos = state.currentVideos.filter((v) => String(v.format || "").toUpperCase() !== "AUDIO");
  } else if (mode === "music") {
    filteredVideos = state.currentVideos.filter((v) => String(v.format || "").toUpperCase() === "AUDIO");
  }

  renderVideosFn(filteredVideos, state.currentDownloads);
  DownloadList.renderDownloads(elements.downloadList, state.currentDownloads, { shortenUrl });
  renderSyncedHistory();
  updateIndicatorFromVideos(state.currentVideos);
  setVideoLayoutMode(state.videoLayoutMode);
  setViewMode(mode);
  updateBatchUI();
  updatePlaylistPrompt();
}

PopupState.subscribe(render);

// ─── Event listeners ────────────────────────────────────────────────────────

// Video download button
elements.videoList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-video-id]");
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = "Loading...";

  const tabChanged = await updateActiveTabContext();
  if (!hasActiveTab()) {
    hideQualityDialog();
    setMessage("No active tab found.", true);
    elements.message.hidden = false;
    button.disabled = false;
    button.textContent = "Download";
    return;
  }
  if (tabChanged) {
    button.disabled = false;
    button.textContent = "Download";
    await rescanActiveTab();
    setMessage("Active tab changed. Choose a video from the refreshed list.");
    elements.message.hidden = false;
    return;
  }

  const requestToken = showQualityLoading();
  const formatsResponse = await PopupApi.getVideoFormats(PopupState.get("activeTabId"), button.dataset.videoId);

  if (!isCurrentQualityRequest(requestToken)) {
    button.disabled = false;
    button.textContent = "Download";
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setMessage(
      formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load quality choices.",
      true,
    );
    button.disabled = false;
    button.textContent = "Download";
    return;
  }

  const selectedFormat = await chooseQuality(formatsResponse);
  if (!selectedFormat) {
    button.disabled = false;
    button.textContent = "Download";
    return;
  }

  button.textContent = "Queued";
  const response = await PopupApi.downloadVideo(
    PopupState.get("activeTabId"),
    formatsResponse.videoId || button.dataset.videoId,
    selectedFormat.formatId,
    selectedFormat.variantId,
    selectedFormat.backend,
  );

  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Download failed to start.", true);
  } else {
    setViewMode("downloads");
  }

  await refresh();
});

// Download list actions
elements.downloadList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action][data-job-id]");
  if (!button) {
    return;
  }

  const action = button.getAttribute("data-action");
  const jobId = button.getAttribute("data-job-id");
  const tabId = PopupState.get("activeTabId");

  let response = null;
  button.disabled = true;

  switch (action) {
    case "pause":
      response = await PopupApi.pauseDownload(tabId, jobId);
      break;
    case "resume":
      response = await PopupApi.resumeDownload(tabId, jobId);
      break;
    case "cancel":
      response = await PopupApi.cancelDownload(tabId, jobId);
      break;
    case "retry":
      response = await PopupApi.retryDownload(tabId, jobId);
      break;
    case "open-file":
      response = await PopupApi.openDownloadedFile(tabId, jobId);
      break;
    case "show-folder":
      response = await PopupApi.showDownloadedFile(tabId, jobId);
      break;
    case "remove":
      response = await PopupApi.removeDownload(tabId, jobId);
      break;

  }

  if (!response || !response.ok) {
    button.disabled = false;
    button.title = response && response.error ? response.error : "Download action failed.";
    setMessage(button.title, true);
    elements.message.hidden = false;
    return;
  }

  if (action === "retry") {
    setViewMode("downloads");
  }
  await refresh();
});

// Settings / view toggle events
elements.settingsToggle.addEventListener("click", async () => {
  const { setSettingsOpen } = await import("./popup_helpers.js");
  setSettingsOpen(elements.settingsPanel.hidden);
});

// View mode buttons
elements.showVideos.addEventListener("click", () => {
  setViewMode("videos");
  render();
});

elements.showMusic.addEventListener("click", () => {
  setViewMode("music");
  render();
});

elements.showDownloads.addEventListener("click", () => {
  setViewMode("downloads");
  render();
});

// Layout mode buttons
elements.showListLayout.addEventListener("click", () => {
  setVideoLayoutMode("list");
});

elements.showBoxLayout.addEventListener("click", () => {
  setVideoLayoutMode("boxes");
});

// Rescan / clear
elements.rescan.addEventListener("click", async () => {
  await rescanActiveTab();
});

elements.clear.addEventListener("click", async () => {
  await clearActiveTabVideos();
});

// ─── Batch event handlers ─────────────────────────────────────────────────

elements.downloadAllBtn.addEventListener("click", async () => {
  await downloadAllPlaylist();
});
