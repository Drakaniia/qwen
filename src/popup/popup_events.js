"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupApi from "../shared/popup_api.js";
import * as PopupState from "../shared/popup_state.js";
import * as DownloadList from "./download_list.js";
import { elements, qualityChooser, api, INDICATOR_STATES } from "./popup_elements.js";
import {
  hasActiveTab,
  setMessage,
  setSettingsStatus,
  setHelperStatus,
  setViewMode,
  setSettingsOpen,
  setVideoLayoutMode,
  setMusicMode,
  hideQualityDialog,
  showQualityLoading,
  isCurrentQualityRequest,
  chooseQuality,
  refresh,
  checkHelperStatus,
  rescanActiveTab,
  clearActiveTabVideos,
  downloadAllPlaylist,
  updateActiveTabContext,
  shortenUrl,
  normalizeManualUrl,
  startRecording,
  renderDepBanner,
  copyInstallCommand,
  updateBatchUI,
  updatePlaylistPrompt,
  renderSyncedHistory,
  updateIndicatorFromVideos,
  setVideoLayoutMode as setVideoLayout,
  isUnknownMessageTypeError,
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
  setVideoLayout(state.videoLayoutMode);
  setViewMode(mode);
  updateBatchUI();
  updatePlaylistPrompt();
}

PopupState.subscribe(render);

// ─── Event listeners ────────────────────────────────────────────────────────

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
    case "stopRecording":
      response = await PopupApi.stopRecording(jobId);
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

elements.settingsToggle.addEventListener("click", () => {
  setSettingsOpen(elements.settingsPanel.hidden);
});

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

elements.showListLayout.addEventListener("click", () => {
  setVideoLayoutMode("list");
});

elements.showBoxLayout.addEventListener("click", () => {
  setVideoLayoutMode("boxes");
});

elements.recordingMode.addEventListener("change", async () => {
  const response = await PopupApi.saveSettings({
    recordingMode: elements.recordingMode.value,
  });
  if (!response || !response.ok) {
    setSettingsStatus("Could not save recording mode.", true);
  } else {
    setSettingsStatus("Recording mode saved.");
  }
});

elements.saveSettings.addEventListener("click", async () => {
  const syncEnabled = elements.syncHistoryToggle ? elements.syncHistoryToggle.checked : true;

  PopupApi.setDownloadSyncEnabled(syncEnabled);

  const response = await PopupApi.saveSettings({
    downloadFolder: elements.downloadFolder.value.trim(),
    audioFormat: elements.audioFormat.value,
    recordingMode: elements.recordingMode.value,
    downloadSubtitles: elements.downloadSubtitles ? elements.downloadSubtitles.checked : true,
    downloadSyncEnabled: syncEnabled,
  });
  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Could not save settings.", true);
    return;
  }
  setSettingsStatus("Settings saved.");
});

elements.chooseDownloadFolder.addEventListener("click", async () => {
  setSettingsStatus("");
  elements.chooseDownloadFolder.disabled = true;
  elements.chooseDownloadFolder.textContent = "Opening...";

  const response = await PopupApi.chooseDownloadFolder();

  elements.chooseDownloadFolder.disabled = false;
  elements.chooseDownloadFolder.textContent = "Browse";

  if (!response || !response.ok) {
    if (isUnknownMessageTypeError(response)) {
      setSettingsStatus(
        "Reload Qwin from the browser extensions page, then open settings and click Browse again.",
        true,
      );
      return;
    }
    setSettingsStatus(response && response.error ? response.error : "Could not open the folder picker.", true);
    return;
  }
  if (response.canceled) {
    setSettingsStatus("Folder selection canceled.");
    return;
  }

  elements.downloadFolder.value = (response.settings && response.settings.downloadFolder) || response.path || "";
  setSettingsStatus("Download folder selected.");
});

elements.downloadManualUrl.addEventListener("click", async () => {
  await updateActiveTabContext();

  const manualUrl = normalizeManualUrl(elements.manualUrl.value);
  if (!manualUrl) {
    setSettingsStatus("Enter a valid http:// or https:// video page URL.", true);
    return;
  }

  setSettingsStatus("");
  elements.downloadManualUrl.disabled = true;
  elements.downloadManualUrl.textContent = "Loading...";
  const requestToken = showQualityLoading("Loading link...");
  const formatsResponse = await PopupApi.getFormatsForUrl(PopupState.get("activeTabId"), {
    url: manualUrl,
    pageUrl: manualUrl,
    title: shortenUrl(manualUrl) || "Manual link",
    format: "PAGE",
    source: "manual-url",
    downloadable: true,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setSettingsStatus(
      formatsResponse && formatsResponse.error
        ? formatsResponse.error
        : "Could not load quality choices for that link.",
      true,
    );
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  const selectedFormat = await chooseQuality(formatsResponse);
  if (!selectedFormat) {
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  elements.downloadManualUrl.textContent = "Queued";
  const response = await PopupApi.downloadVideo(
    PopupState.get("activeTabId"),
    formatsResponse.videoId,
    selectedFormat.formatId,
    selectedFormat.variantId,
    selectedFormat.backend,
  );

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Download failed to start.", true);
  } else {
    setViewMode("downloads");
    setSettingsOpen(false);
  }

  elements.downloadManualUrl.disabled = false;
  elements.downloadManualUrl.textContent = "Download link";
  await refresh();
});

elements.downloadMagnet.addEventListener("click", async () => {
  const magnetUrl = String(elements.magnetUrl.value || "").trim();
  if (!magnetUrl.startsWith("magnet:?")) {
    setSettingsStatus("Enter a valid magnet link starting with 'magnet:?xt=urn:btih:'.", true);
    return;
  }

  const requestToken = showQualityLoading("Preparing magnet download...");
  const confirmed = await qualityChooser.showChoices({
    choiceTitle: "Download from magnet link",
    formats: [
      {
        id: "magnet",
        label: "Start BitTorrent download",
        ext: "TORRENT",
        note: "Downloads via aria2c",
        source: "magnet",
        size: "",
      },
    ],
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!confirmed) {
    elements.magnetUrl.focus();
    return;
  }

  elements.downloadMagnet.disabled = true;
  elements.downloadMagnet.textContent = "Queued";

  const downloadFolder = elements.downloadFolder.value.trim();
  const response = await PopupApi.downloadMagnet(magnetUrl, downloadFolder);

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Failed to start magnet download.", true);
  } else {
    setViewMode("downloads");
    elements.magnetUrl.value = "";
  }

  elements.downloadMagnet.disabled = false;
  elements.downloadMagnet.textContent = "Download magnet";
  await refresh();
});

elements.downloadTorrentFile.addEventListener("click", async () => {
  setSettingsStatus("");
  elements.downloadTorrentFile.disabled = true;
  elements.downloadTorrentFile.textContent = "Opening...";

  const pickResponse = await PopupApi.chooseTorrentFile();

  if (!pickResponse || !pickResponse.ok) {
    if (isUnknownMessageTypeError(pickResponse)) {
      setSettingsStatus("Reload Qwin from the browser extensions page, then open settings and try again.", true);
    } else {
      setSettingsStatus(
        pickResponse && pickResponse.error ? pickResponse.error : "Could not open the file picker.",
        true,
      );
    }
    elements.downloadTorrentFile.disabled = false;
    elements.downloadTorrentFile.textContent = "Download .torrent file";
    return;
  }

  if (pickResponse.canceled || !pickResponse.path) {
    setSettingsStatus("Torrent file selection canceled.");
    elements.downloadTorrentFile.disabled = false;
    elements.downloadTorrentFile.textContent = "Download .torrent file";
    return;
  }

  elements.downloadTorrentFile.textContent = "Queued";
  const downloadFolder = elements.downloadFolder.value.trim();
  const response = await PopupApi.downloadTorrent(pickResponse.path, downloadFolder);

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Failed to start .torrent download.", true);
  } else {
    setViewMode("downloads");
    setSettingsOpen(false);
  }

  elements.downloadTorrentFile.disabled = false;
  elements.downloadTorrentFile.textContent = "Download .torrent file";
  await refresh();
});

elements.downloadMusicLink.addEventListener("click", async () => {
  await updateActiveTabContext();

  const musicUrl = normalizeManualUrl(elements.musicLinkUrl.value);
  if (!musicUrl) {
    setMessage("Enter a valid Spotify, YouTube Music, or other music service URL.", true);
    elements.musicLinkUrl.focus();
    return;
  }

  if (!PopupState.get("musicMode")) {
    setMusicMode(true);
    await PopupApi.saveSettings({ musicMode: true });
  }

  await PopupApi.saveSettings({ audioFormat: elements.audioFormat.value });

  const requestToken = showQualityLoading("Loading music link...");
  const formatsResponse = await PopupApi.getFormatsForUrl(PopupState.get("activeTabId"), {
    url: musicUrl,
    pageUrl: musicUrl,
    title: shortenUrl(musicUrl) || "Music link",
    format: "PAGE",
    source: "manual-url",
    downloadable: true,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setMessage(
      formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load music formats for that link.",
      true,
    );
    return;
  }

  const selectedFormat = await chooseQuality(formatsResponse);
  if (!selectedFormat) {
    return;
  }

  elements.downloadMusicLink.disabled = true;
  elements.downloadMusicLink.textContent = "Queued";
  const response = await PopupApi.downloadVideo(
    PopupState.get("activeTabId"),
    formatsResponse.videoId,
    selectedFormat.formatId,
    selectedFormat.variantId,
    selectedFormat.backend,
  );

  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Download failed to start.", true);
  } else {
    setViewMode("downloads");
    elements.musicLinkUrl.value = "";
  }

  elements.downloadMusicLink.disabled = false;
  elements.downloadMusicLink.textContent = "Download Music";
  await refresh();
});

elements.musicLinkUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    elements.downloadMusicLink.click();
  }
});

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

elements.batchCancelBtn.addEventListener("click", async () => {
  const response = await PopupApi.batchCancel();
  if (response && response.ok) {
    PopupState.update({ batchInfo: response.batchInfo });
    await refresh();
  }
});

// ─── Background message listener ────────────────────────────────────────────

api.runtime.onMessage.addListener((message) => {
  if (!message) {
    return;
  }

  if (message.type === "updateQualityLoadingStatus") {
    qualityChooser.updateLoadingStatus(message.text);
    return;
  }

  if (message.type === "videoListUpdated" && message.tabId === PopupState.get("activeTabId")) {
    PopupState.update({ currentVideos: message.videos || [] });
  }

  if (message.type === "downloadUpdated" && message.job) {
    const currentDownloads = PopupState.get("currentDownloads");
    const existingIndex = currentDownloads.findIndex((job) => job.id === message.job.id);
    let updated;
    if (existingIndex >= 0) {
      updated = [...currentDownloads];
      updated[existingIndex] = message.job;
    } else {
      updated = [message.job, ...currentDownloads];
    }
    PopupState.update({ currentDownloads: updated });
  }

  if (message.type === "downloadRemoved" && message.jobId) {
    const currentDownloads = PopupState.get("currentDownloads");
    PopupState.update({ currentDownloads: currentDownloads.filter((job) => job.id !== message.jobId) });
  }

  if (message.type === "batchUpdated") {
    PopupState.update({ batchInfo: message.batchInfo });
  }

  if (message.type === "batchComplete") {
    PopupState.update({ batchInfo: message.batchInfo });
    setMessage(message.message || "Batch download complete.");
    elements.message.hidden = false;
  }

  if (message.type === "helperStatusChanged") {
    const status = message.status || {};
    const connected = !!status.connected;
    const deps = status.dependencies || {};
    const hasMissingDeps = connected && (!deps.ytDlp || !deps.ffmpeg);

    if (connected) {
      if (hasMissingDeps) {
        renderDepBanner(deps);
      } else {
        elements.depBanner.classList.add("content-fade-out");
        window.setTimeout(function () {
          elements.depBanner.hidden = true;
          elements.depBanner.classList.remove("content-fade-out");
        }, 200);
      }
    }

    checkHelperStatus();
  }
});

// ─── Dep banner toggle ───────────────────────────────────────────────────

elements.depBannerToggle.addEventListener("click", function () {
  const expanded = elements.depBannerToggle.getAttribute("aria-expanded") === "true";
  const nextExpanded = !expanded;
  elements.depBannerToggle.setAttribute("aria-expanded", String(nextExpanded));
  elements.depBannerBody.classList.toggle("expanded", nextExpanded);
});

// ─── Dep banner: copy command button ─────────────────────────────────────

elements.depBannerCopyBtn.addEventListener("click", function () {
  copyInstallCommand(elements.depBannerCopyBtn);
});
