"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupState from "../shared/popup_state.js";
import * as PopupApi from "../shared/popup_api.js";
import * as DownloadList from "./download_list.js";
import * as videoFilters from "../shared/video_filters.js";
import * as qualityFormat from "../shared/quality_format.js";
import * as qualityDialog from "../shared/quality_dialog.js";
import * as VideoPicker from "../shared/video_picker.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ─── Constants ──────────────────────────────────────────────────────────────
const ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);
const RESCAN_IDLE_LABEL = "Rescan";
const RESCAN_BUSY_LABEL = "Refreshing";

// Format-type constants used to route items into the correct tab.
// "AUDIO" items go to the Music tab; video formats (MP4, WEBM, M3U8, etc.) go to the Videos tab.
const AUDIO_FORMAT = "AUDIO";

const INDICATOR_STATES = {
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
};
const INDICATOR_TOOLTIPS = {
  checking: "Checking for videos...",
  available: "Downloadable video available",
  unavailable: "No downloadable video detected",
};
const INDICATOR_ARIA_LABELS = {
  checking: "Checking for downloadable videos",
  available: "Downloadable video available",
  unavailable: "No downloadable video detected",
};
const INDICATOR_DEBOUNCE_MS = 300;

let indicatorDebounceTimer = null;
let currentIndicatorState = INDICATOR_STATES.CHECKING;

// ─── Elements ───────────────────────────────────────────────────────────────
const elements = {
  helperStatus: document.getElementById("helperStatus"),
  downloadIndicator: document.getElementById("downloadIndicator"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsStatus: document.getElementById("settingsStatus"),
  viewToggle: document.getElementById("viewToggle"),
  contentView: document.getElementById("contentView"),
  footerActions: document.getElementById("footerActions"),
  showVideos: document.getElementById("showVideos"),
  showMusic: document.getElementById("showMusic"),
  showDownloads: document.getElementById("showDownloads"),
  manualUrl: document.getElementById("manualUrl"),
  downloadManualUrl: document.getElementById("downloadManualUrl"),
  downloadFolder: document.getElementById("downloadFolder"),
  chooseDownloadFolder: document.getElementById("chooseDownloadFolder"),
  saveSettings: document.getElementById("saveSettings"),
  message: document.getElementById("message"),
  videoToolbar: document.getElementById("videoToolbar"),
  showListLayout: document.getElementById("showListLayout"),
  showBoxLayout: document.getElementById("showBoxLayout"),
  videoList: document.getElementById("videoList"),
  downloadList: document.getElementById("downloadList"),
  qualityDialog: document.getElementById("qualityDialog"),
  qualityTitle: document.getElementById("qualityTitle"),
  qualityList: document.getElementById("qualityList"),
  cancelQuality: document.getElementById("cancelQuality"),
  rescan: document.getElementById("rescan"),
  clear: document.getElementById("clear"),
  musicLinkSection: document.getElementById("musicLinkSection"),
  musicLinkUrl: document.getElementById("musicLinkUrl"),
  downloadMusicLink: document.getElementById("downloadMusicLink"),
  audioFormat: document.getElementById("audioFormat"),
};

// ─── Quality chooser ────────────────────────────────────────────────────────
const qualityChooser = qualityDialog.create({
  document,
  root: elements.qualityDialog,
  title: elements.qualityTitle,
  list: elements.qualityList,
  cancel: elements.cancelQuality,
  qualityFormat,
  videoFilters,
  style: "classes",
});

// ─── Indicator ──────────────────────────────────────────────────────────────

function setDownloadIndicator(status, { immediate = false } = {}) {
  const nextStatus = INDICATOR_STATES[status.toUpperCase()] ? status : INDICATOR_STATES.UNAVAILABLE;

  if (indicatorDebounceTimer) {
    window.clearTimeout(indicatorDebounceTimer);
    indicatorDebounceTimer = null;
  }

  const apply = () => {
    if (currentIndicatorState === nextStatus) {
      return;
    }
    currentIndicatorState = nextStatus;
    elements.downloadIndicator.dataset.status = nextStatus;
    elements.downloadIndicator.title = INDICATOR_TOOLTIPS[nextStatus] || "";
    elements.downloadIndicator.setAttribute("aria-label", INDICATOR_ARIA_LABELS[nextStatus] || "");
  };

  if (immediate || nextStatus === INDICATOR_STATES.CHECKING) {
    apply();
  } else {
    indicatorDebounceTimer = window.setTimeout(apply, INDICATOR_DEBOUNCE_MS);
  }
}

function updateIndicatorFromVideos(videos) {
  const hasDownloadable = Array.isArray(videos) && videos.some((video) => video && video.downloadable);
  setDownloadIndicator(hasDownloadable ? INDICATOR_STATES.AVAILABLE : INDICATOR_STATES.UNAVAILABLE);
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

function hasActiveTab() {
  return PopupState.get("activeTabId") !== null && PopupState.get("activeTabId") !== undefined;
}

function setRescanRefreshing(refreshing) {
  const label = refreshing ? RESCAN_BUSY_LABEL : RESCAN_IDLE_LABEL;
  elements.rescan.disabled = refreshing;
  elements.rescan.classList.toggle("is-refreshing", refreshing);
  elements.rescan.setAttribute("aria-busy", String(refreshing));
  elements.rescan.setAttribute("aria-label", label);
  elements.rescan.title = label;
}

function activeDownloadJobs(downloads) {
  return downloads.filter((job) => ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued"));
}

function setMessage(text, isError) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function setSettingsStatus(text, isError) {
  const value = String(text || "").trim();
  elements.settingsStatus.textContent = value;
  elements.settingsStatus.hidden = !value;
  elements.settingsStatus.classList.toggle("error", isError);
}

function isUnknownMessageTypeError(response) {
  return /unknown message type/i.test(String(response?.error || ""));
}

function setHelperStatus(text, className) {
  elements.helperStatus.textContent = text;
  elements.helperStatus.className = `helper-status ${className}`.trim();
}

function setViewMode(mode) {
  const modes = ["videos", "music", "downloads"];
  const nextMode = modes.includes(mode) ? mode : "videos";
  PopupState.set("viewMode", nextMode);

  const isVideos = nextMode === "videos";
  const isMusic = nextMode === "music";
  const isDownloads = nextMode === "downloads";

  elements.videoList.hidden = isDownloads;
  elements.downloadList.hidden = !isDownloads;
  elements.message.hidden = isDownloads;
  elements.videoToolbar.hidden = isDownloads || !PopupState.get("currentVideos").length;
  elements.musicLinkSection.hidden = !isMusic;

  elements.showVideos.classList.toggle("active", isVideos);
  elements.showMusic.classList.toggle("active", isMusic);
  elements.showDownloads.classList.toggle("active", isDownloads);

  elements.showVideos.setAttribute("aria-pressed", String(isVideos));
  elements.showMusic.setAttribute("aria-pressed", String(isMusic));
  elements.showDownloads.setAttribute("aria-pressed", String(isDownloads));

  if (isMusic) {
    setMusicMode(true);
  } else if (isVideos) {
    setMusicMode(false);
  }
}

function setSettingsOpen(open) {
  elements.settingsPanel.hidden = !open;
  elements.viewToggle.hidden = open;
  elements.contentView.hidden = open;
  elements.footerActions.hidden = open;
  elements.musicLinkSection.hidden = open;
  elements.settingsToggle.classList.toggle("active", open);
  elements.settingsToggle.setAttribute("aria-expanded", String(open));

  if (open) {
    hideQualityDialog();
  }
}

function setVideoLayoutMode(mode) {
  const nextMode = mode === "boxes" ? "boxes" : "list";
  PopupState.set("videoLayoutMode", nextMode);

  const boxes = nextMode === "boxes";
  elements.videoList.classList.toggle("boxes", boxes);
  elements.showListLayout.classList.toggle("active", !boxes);
  elements.showBoxLayout.classList.toggle("active", boxes);
  elements.showListLayout.setAttribute("aria-pressed", String(!boxes));
  elements.showBoxLayout.setAttribute("aria-pressed", String(boxes));
}

function setMusicMode(enabled) {
  const mode = Boolean(enabled);
  PopupState.set("musicMode", mode);
  elements.showMusic.classList.toggle("active", mode);
  elements.showMusic.setAttribute("aria-pressed", String(mode));
  elements.showMusic.title = mode
    ? "Music mode active - download audio"
    : "Music mode - download audio instead of video";
}

// ─── URL / video helpers ────────────────────────────────────────────────────

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path = `${parsed.hostname}${parsed.pathname}`;
    const suffix = parsed.search ? "?..." : "";
    return path.length > 74 ? `${path.slice(0, 34)}...${path.slice(-30)}${suffix}` : `${path}${suffix}`;
  } catch (_error) {
    return String(url || "").slice(0, 95);
  }
}

function videoTitle(video) {
  if (video.title) {
    return video.title;
  }
  const isAudio = String(video.format || "").toUpperCase() === AUDIO_FORMAT;
  return shortenUrl(video.url) || (isAudio ? "Music" : "Video");
}

function displayFormat(video) {
  return VideoPicker.displayFormat(video, videoFilters);
}

function sourceLabel(video) {
  return VideoPicker.sourceLabel(video, videoFilters);
}

function videoSizeLabel(video) {
  return VideoPicker.videoSizeLabel(video, videoFilters);
}

function videoThumbnailUrl(video) {
  const value = video && (video.thumbnailUrl || video.poster || video.image || "");
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "blob:", "data:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

// ─── Video rendering ────────────────────────────────────────────────────────

function appendVideoPlaceholder(container) {
  const placeholder = container.ownerDocument.createElement("div");
  placeholder.className = "video-placeholder";
  const icon = placeholder.ownerDocument.createElement("span");
  icon.className = "video-placeholder-icon";
  placeholder.append(icon);
  container.append(placeholder);
}

function createVideoPreview(video) {
  const preview = document.createElement("div");
  preview.className = "video-preview";
  preview.setAttribute("aria-hidden", "true");

  const thumbnail = videoThumbnailUrl(video);
  if (!thumbnail) {
    appendVideoPlaceholder(preview);
    return preview;
  }

  const thumb = document.createElement("img");
  thumb.className = "video-thumbnail";
  thumb.alt = "";
  thumb.loading = "lazy";
  thumb.decoding = "async";
  thumb.src = thumbnail;
  thumb.addEventListener("error", () => {
    preview.textContent = "";
    appendVideoPlaceholder(preview);
  });
  preview.append(thumb);
  return preview;
}

function renderVideos(videos, downloads) {
  if (videos === null) {
    return;
  }

  elements.videoList.textContent = "";

  if (!videos.length) {
    setMessage("No downloadable video or music detected yet.");
    return;
  }

  const audioCount = videos.filter((v) => String(v.format || "").toUpperCase() === AUDIO_FORMAT).length;
  const videoCount = videos.length - audioCount;
  const messageParts = [];
  if (videoCount > 0) {
    messageParts.push(`${videoCount} full video${videoCount === 1 ? "" : "s"}`);
  }
  if (audioCount > 0) {
    messageParts.push(`${audioCount} music track${audioCount === 1 ? "" : "s"}`);
  }
  setMessage(
    messageParts.length
      ? `${messageParts.join(" and ")} detected.`
      : `${videos.length} item${videos.length === 1 ? "" : "s"} detected.`,
  );

  for (const video of videos) {
    const item = document.createElement("section");
    item.className = "video-item";
    item.append(createVideoPreview(video));

    const content = document.createElement("div");
    content.className = "video-content";

    const main = document.createElement("div");
    main.className = "video-main";

    const details = document.createElement("div");
    const title = document.createElement("div");
    title.className = "video-title";
    title.title = video.url;
    title.textContent = videoTitle(video);
    details.append(title);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    const isAudioItem = String(video.format || "").toUpperCase() === AUDIO_FORMAT;
    button.textContent = isAudioItem ? "Download Music" : "Download";
    button.dataset.videoId = video.id;

    const runningJob = downloads.find(
      (job) => job.videoId === video.id && ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued"),
    );
    if (!video.downloadable || runningJob) {
      button.disabled = true;
      button.textContent = runningJob ? DownloadList.downloadProgressButtonText(runningJob) : "Unsupported";
    }

    main.append(details, button);

    const meta = document.createElement("div");
    meta.className = "meta";
    const badge = document.createElement("span");
    badge.className = `badge ${video.downloadable ? "" : "warning"}`.trim();
    badge.textContent = displayFormat(video);
    const source = document.createElement("span");
    source.textContent = video.variantCount > 1 ? `${video.variantCount} versions` : sourceLabel(video);
    meta.append(badge, source);
    const size = videoSizeLabel(video);
    if (size) {
      const sizeEl = document.createElement("span");
      sizeEl.className = "video-size";
      sizeEl.textContent = size;
      meta.append(sizeEl);
    }

    if (!video.downloadable) {
      const warning = document.createElement("div");
      warning.className = "download-message error";
      warning.textContent =
        "Browser-only URL. Wait for a downloadable video stream. The helper saves supported streams as MP4.";
      content.append(main, meta, warning);
    } else {
      content.append(main, meta);
      DownloadList.appendDownloadProgress(content, runningJob, { compact: true });
    }

    item.append(content);
    elements.videoList.append(item);
  }
}

// ─── Quality dialog helpers ─────────────────────────────────────────────────

function hideQualityDialog() {
  qualityChooser.hide();
}

function showQualityLoading(title) {
  const serial = PopupState.get("qualityRequestSerial") + 1;
  PopupState.set("qualityRequestSerial", serial);
  qualityChooser.showLoading({
    loadingTitle: title,
    onCancel() {
      PopupState.set("qualityRequestSerial", PopupState.get("qualityRequestSerial") + 1);
    },
  });
  return serial;
}

function isCurrentQualityRequest(requestToken) {
  return requestToken === PopupState.get("qualityRequestSerial");
}

function chooseQuality({ title, formats, nativeError }) {
  return qualityChooser.showChoices({
    choiceTitle: title,
    formats,
    nativeError,
  });
}

// ─── URL helpers ────────────────────────────────────────────────────────────

function normalizeManualUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

// ─── Tab context ────────────────────────────────────────────────────────────

async function updateActiveTabContext() {
  const tabs = await PopupApi.tabsQuery();
  const activeTab = tabs && tabs[0] ? tabs[0] : null;
  const nextTabId = activeTab ? activeTab.id : null;
  const nextTabUrl = activeTab && typeof activeTab.url === "string" ? activeTab.url : "";
  const changed = PopupState.get("activeTabId") !== nextTabId || PopupState.get("activeTabUrl") !== nextTabUrl;

  PopupState.set("activeTabId", nextTabId);
  PopupState.set("activeTabUrl", nextTabUrl);
  return changed;
}

// ─── Main flows ─────────────────────────────────────────────────────────────

async function refresh(options = {}) {
  if (options.syncActiveTab !== false) {
    await updateActiveTabContext();
  }

  if (!hasActiveTab()) {
    return false;
  }

  const response = await PopupApi.getVideos(PopupState.get("activeTabId"));
  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Could not read extension state.", true);
    elements.message.hidden = false;
    return false;
  }

  PopupState.update({
    currentVideos: response.videos || [],
    currentDownloads: response.downloads || [],
  });

  elements.downloadFolder.value = (response.settings && response.settings.downloadFolder) || "";
  setMusicMode(response.settings && response.settings.musicMode ? true : false);
  if (response.settings && response.settings.audioFormat) {
    elements.audioFormat.value = response.settings.audioFormat;
  } else {
    elements.audioFormat.value = "mp3";
  }
  return true;
}

async function checkNativeHost() {
  const response = await PopupApi.pingNativeHost();
  if (!response || !response.ok) {
    const errorMsg = response && response.error ? `: ${response.error}` : "";
    setHelperStatus(`Helper not connected${errorMsg}. Run scripts\\install.bat.`, "error");
    return;
  }

  const dependencies = response.dependencies || {};
  if (!dependencies.ytDlp || !dependencies.ffmpeg) {
    setHelperStatus("Helper found, but yt-dlp or ffmpeg is missing. Run scripts\\install.bat.", "error");
    return;
  }

  const mode = dependencies.aria2c ? "fast mode" : "standard mode";
  const streamFallbacks = dependencies.nM3u8DlRe || dependencies.streamlink;
  const fallbackMode = streamFallbacks ? "stream fallbacks" : "yt-dlp only";
  setHelperStatus(`Helper ready (${response.version || "installed"}, ${mode}, ${fallbackMode}).`, "ok");
}

async function init() {
  await updateActiveTabContext();

  if (!hasActiveTab()) {
    setMessage("No active tab found.", true);
    setDownloadIndicator(INDICATOR_STATES.UNAVAILABLE, { immediate: true });
    return;
  }

  await refresh({ syncActiveTab: false });
  await checkNativeHost();
}

async function rescanActiveTab() {
  setDownloadIndicator(INDICATOR_STATES.CHECKING, { immediate: true });
  setRescanRefreshing(true);

  await updateActiveTabContext();

  if (!hasActiveTab()) {
    setRescanRefreshing(false);
    setMessage("No active tab found.", true);
    elements.message.hidden = false;
    return;
  }

  try {
    const response = await PopupApi.rescanTab(PopupState.get("activeTabId"));
    if (!response || !response.ok) {
      setMessage(response && response.error ? response.error : "Could not refresh this tab.", true);
      elements.message.hidden = false;
      return;
    }

    await refresh({ syncActiveTab: false });
    // Retry after content scan should have completed
    window.setTimeout(() => refresh({ syncActiveTab: false }), 2000);
  } finally {
    setRescanRefreshing(false);
  }
}

async function clearActiveTabVideos() {
  await updateActiveTabContext();

  if (!hasActiveTab()) {
    setMessage("No active tab found.", true);
    elements.message.hidden = false;
    return;
  }

  setDownloadIndicator(INDICATOR_STATES.CHECKING, { immediate: true });
  elements.clear.disabled = true;
  try {
    const tabId = PopupState.get("activeTabId");
    const response = await PopupApi.clearVideos(tabId);
    if (!response || !response.ok) {
      setMessage(response && response.error ? response.error : "Could not clear detected videos.", true);
      elements.message.hidden = false;
      return;
    }

    const downloadsResponse = await PopupApi.clearDownloads(tabId);
    if (!downloadsResponse || !downloadsResponse.ok) {
      setMessage(
        downloadsResponse && downloadsResponse.error ? downloadsResponse.error : "Could not clear downloaded list.",
        true,
      );
      elements.message.hidden = false;
      return;
    }

    PopupState.update({
      currentVideos: [],
      currentDownloads: activeDownloadJobs(PopupState.get("currentDownloads")),
    });
    await refresh();
  } finally {
    elements.clear.disabled = false;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

function render() {
  const state = PopupState.getState();
  const mode = state.viewMode;

  let filteredVideos = state.currentVideos;
  if (filteredVideos === null) {
    // Initial loading - skip rendering to avoid jump
    return;
  }

  if (mode === "videos") {
    // Exclude audio-only items — Videos tab shows only video formats (MP4, WEBM, M3U8, etc.)
    filteredVideos = state.currentVideos.filter((v) => String(v.format || "").toUpperCase() !== AUDIO_FORMAT);
  } else if (mode === "music") {
    // Include ONLY audio-only items — no video files should appear here
    filteredVideos = state.currentVideos.filter((v) => String(v.format || "").toUpperCase() === AUDIO_FORMAT);
  }

  renderVideos(filteredVideos, state.currentDownloads);
  DownloadList.renderDownloads(elements.downloadList, state.currentDownloads, { shortenUrl });
  updateIndicatorFromVideos(state.currentVideos);
  setVideoLayoutMode(state.videoLayoutMode);
  setViewMode(mode);
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

elements.saveSettings.addEventListener("click", async () => {
  const response = await PopupApi.saveSettings({
    downloadFolder: elements.downloadFolder.value.trim(),
    audioFormat: elements.audioFormat.value,
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

// ─── Background message listener ────────────────────────────────────────────

api.runtime.onMessage.addListener((message) => {
  if (!message) {
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
});

// ─── Boot ───────────────────────────────────────────────────────────────────
init();
