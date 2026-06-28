"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupState from "../shared/popup_state.js";
import * as PopupApi from "../shared/popup_api.js";
import * as PopupUI from "./popup_ui.js";
import { elements, qualityChooser, INDICATOR_STATES, INDICATOR_TOOLTIPS, INDICATOR_ARIA_LABELS, RESCAN_IDLE_LABEL, RESCAN_BUSY_LABEL } from "./popup_elements.js";

// ─── Re-exports from sub-modules (backward compatibility) ────────────────────

import { initBatchHelpers } from "./popup_batch_helpers.js";

export {
  updateBatchUI,
  updatePlaylistPrompt,
  downloadAllPlaylist,
} from "./popup_batch_helpers.js";

export {
  renderSyncedHistory,
} from "./popup_sync_history.js";

// ─── Mutable indicator state ────────────────────────────────────────────────
let indicatorDebounceTimer = null;
let currentIndicatorState = INDICATOR_STATES.CHECKING;

// ─── Indicator ──────────────────────────────────────────────────────────────

export function setDownloadIndicator(status, { immediate = false } = {}) {
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
    indicatorDebounceTimer = window.setTimeout(apply, 300);
  }
}

export function updateIndicatorFromVideos(videos) {
  const hasDownloadable = Array.isArray(videos) && videos.some((video) => video && video.downloadable);
  setDownloadIndicator(hasDownloadable ? INDICATOR_STATES.AVAILABLE : INDICATOR_STATES.UNAVAILABLE);
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

export function hasActiveTab() {
  return PopupState.get("activeTabId") !== null && PopupState.get("activeTabId") !== undefined;
}

export function setRescanRefreshing(refreshing) {
  const label = refreshing ? RESCAN_BUSY_LABEL : RESCAN_IDLE_LABEL;
  elements.rescan.disabled = refreshing;
  elements.rescan.classList.toggle("is-refreshing", refreshing);
  elements.rescan.setAttribute("aria-busy", String(refreshing));
  elements.rescan.setAttribute("aria-label", label);
  elements.rescan.title = label;
}

export function setMessage(text, isError) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

export function setSettingsStatus(text, isError) {
  const value = String(text || "").trim();
  elements.settingsStatus.textContent = value;
  elements.settingsStatus.hidden = !value;
  elements.settingsStatus.classList.toggle("error", isError);
}

export function setHelperStatus(text, className) {
  elements.helperStatus.textContent = text;
  elements.helperStatus.className = `helper-status ${className}`.trim();
}

export function setViewMode(mode) {
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

export function setSettingsOpen(open) {
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

export function setVideoLayoutMode(mode) {
  const nextMode = mode === "boxes" ? "boxes" : "list";
  PopupState.set("videoLayoutMode", nextMode);

  const boxes = nextMode === "boxes";
  elements.videoList.classList.toggle("boxes", boxes);
  elements.showListLayout.classList.toggle("active", !boxes);
  elements.showBoxLayout.classList.toggle("active", boxes);
  elements.showListLayout.setAttribute("aria-pressed", String(!boxes));
  elements.showBoxLayout.setAttribute("aria-pressed", String(boxes));
}

export function setMusicMode(enabled) {
  const mode = Boolean(enabled);
  PopupState.set("musicMode", mode);
  elements.showMusic.classList.toggle("active", mode);
  elements.showMusic.setAttribute("aria-pressed", String(mode));
  elements.showMusic.title = mode
    ? "Music mode active - download audio"
    : "Music mode - download audio instead of video";
}

// ─── URL / video helpers (re-exports from popup-ui) ────────────────────────

export const shortenUrl = PopupUI.shortenUrl;
export const videoTitle = PopupUI.videoTitle;
export const displayFormat = PopupUI.displayFormat;
export const sourceLabel = PopupUI.sourceLabel;
export const videoSizeLabel = PopupUI.videoSizeLabel;
export const videoThumbnailUrl = PopupUI.videoThumbnailUrl;
export const normalizeManualUrl = PopupUI.normalizeManualUrl;

// ─── Quality dialog helpers ─────────────────────────────────────────────────

export function hideQualityDialog() {
  qualityChooser.hide();
}

export function showQualityLoading(title) {
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

export function isCurrentQualityRequest(requestToken) {
  return requestToken === PopupState.get("qualityRequestSerial");
}

export function chooseQuality({ title, formats, nativeError, hasSubtitles }) {
  return qualityChooser.showChoices({
    choiceTitle: title,
    formats,
    nativeError,
    hasSubtitles,
  });
}

// ─── Recording flow ────────────────────────────────────────────────────────

export async function startRecording(video) {
  await updateActiveTabContext();
  if (!hasActiveTab()) {
    setMessage("No active tab found to record.", true);
    return;
  }

  const tabId = PopupState.get("activeTabId");
  const recordingMode = elements.recordingMode ? elements.recordingMode.value : "ask";

  if (recordingMode === "ask") {
    const confirmed = await qualityChooser.showChoices({
      choiceTitle: "Start recording?",
      formats: [
        {
          id: "record",
          label: "Start screen recording",
          ext: "RECORDING",
          note: video.title
            ? `Recording "${video.title}" — quality matches source (best-effort)`
            : "Recording the current tab — quality matches source (best-effort)",
          source: "recording",
          size: "",
        },
      ],
    });

    if (!confirmed) {
      return;
    }
  }

  const jobId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const response = await PopupApi.startRecording(tabId, {
    jobId,
    title: video.title || "Screen recording",
    url: video.url || "",
    format: "RECORDING",
  });

  if (!response || !response.ok) {
    setMessage(
      response && response.error
        ? response.error
        : "Could not start recording. CDP/recording binary may not be available.",
      true,
    );
    return;
  }

  setViewMode("downloads");
  await refresh();
}

// ─── Tab context ────────────────────────────────────────────────────────────

export async function updateActiveTabContext() {
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

export async function refresh(options = {}) {
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
  if (response.settings && response.settings.recordingMode) {
    elements.recordingMode.value = response.settings.recordingMode;
  } else {
    elements.recordingMode.value = "ask";
  }
  if (elements.downloadSubtitles) {
    elements.downloadSubtitles.checked = response.settings && response.settings.downloadSubtitles !== false;
  }
  if (elements.backend) {
    elements.backend.value = (response.settings && response.settings.backend) || "auto";
  }
  const syncEnabled = response.settings && response.settings.downloadSyncEnabled !== false;
  if (elements.syncHistoryToggle) {
    elements.syncHistoryToggle.checked = syncEnabled;
  }
  PopupApi.getDownloadSyncHistory().then(function (syncResponse) {
    if (syncResponse && syncResponse.ok) {
      PopupState.update({
        syncedHistory: syncResponse.history || [],
        syncInfo: syncResponse.syncInfo || { totalCount: 0, isSyncing: false, syncEnabled: syncEnabled },
      });
    }
  }).catch(function () {});
  return true;
}

export async function checkHelperStatus() {
  const response = await PopupApi.getHelperStatus();
  const connected = response && response.ok && response.connected;
  const dependencies = (response && response.dependencies) || {};
  const hasMissingDeps = connected && (!dependencies.ytDlp || !dependencies.ffmpeg);

  if (connected) {
    if (hasMissingDeps) {
      setHelperStatus("Helper ready, some tools missing.", "error");
      elements.helperStatus.title = "See the banner above for details.";
    } else {
      const streamFallbacks = dependencies.nM3u8DlRe || dependencies.streamlink;
      const fallbackMode = streamFallbacks ? "stream fallbacks" : "yt-dlp only";
      let capability = "";
      if (dependencies.cdmCapture && dependencies.recording) {
        capability = ", CDM capture + recording";
      } else if (dependencies.recording) {
        capability = ", recording available";
      } else if (dependencies.cdmCapture) {
        capability = ", CDM capture";
      }
      setHelperStatus(`Helper ready (${response.version || "installed"}, fast mode, ${fallbackMode}${capability}).`, "ok");
    }
  } else {
    setHelperStatus("Helper not connected.", "error");
  }

  return { connected, dependencies, hasMissingDeps };
}

export function copyInstallCommand(btn) {
  const command = "scripts/install.sh";
  navigator.clipboard.writeText(command).then(function () {
    const originalText = btn.innerHTML;
    btn.classList.add("copied");
    btn.innerHTML = '<span class="setup-button-icon">\u2713</span> Copied!';
    window.setTimeout(function () {
      btn.classList.remove("copied");
      btn.innerHTML = originalText;
    }, 2000);
  }).catch(function () {
    // Fallback: nothing else to do
  });
}

export function renderDepBanner(dependencies) {
  if (!elements.depBanner) {
    return;
  }

  elements.depBanner.hidden = false;
  elements.depBannerList.textContent = "";

  const depItems = [
    { key: "ytDlp", label: "yt-dlp (video downloads)" },
    { key: "ffmpeg", label: "ffmpeg (audio/video processing)" },
    { key: "aria2c", label: "aria2c (fast downloads)" },
    { key: "nM3u8DlRe", label: "HLS stream downloader" },
    { key: "streamlink", label: "Stream fallback" },
  ];

  let missingCount = 0;
  for (const dep of depItems) {
    const available = dependencies[dep.key] === true;
    if (!available) missingCount++;

    const item = document.createElement("div");
    item.className = "dep-banner-item";
    const statusSpan = document.createElement("span");
    statusSpan.className = available ? "dep-banner-item-ok" : "dep-banner-item-missing";
    statusSpan.textContent = available ? "\u2713" : "\u2717";
    item.append(statusSpan);
    item.append(" " + dep.label);
    elements.depBannerList.append(item);
  }

  if (elements.depBannerTitle) {
    elements.depBannerTitle.textContent = missingCount > 0
      ? missingCount + " download tool" + (missingCount > 1 ? "s" : "") + " missing"
      : "All download tools available";
  }

  if (elements.depBannerToggle) {
    const shouldExpand = missingCount > 0;
    elements.depBannerToggle.setAttribute("aria-expanded", String(shouldExpand));
    elements.depBannerBody.classList.toggle("expanded", shouldExpand);
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function init() {
  // Initialize batch helpers with core UI function references
  initBatchHelpers({ setMessage, setViewMode, refresh });

  await updateActiveTabContext();

  if (!hasActiveTab()) {
    setMessage("No active tab found.", true);
    setDownloadIndicator(INDICATOR_STATES.UNAVAILABLE, { immediate: true });
    return;
  }

  await refresh({ syncActiveTab: false });

  const helperStatus = await checkHelperStatus();

  if (helperStatus.hasMissingDeps) {
    renderDepBanner(helperStatus.dependencies);
  }
}

// ─── Rescan / clear ────────────────────────────────────────────────────────

export async function rescanActiveTab() {
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

    await new Promise(resolve => window.setTimeout(resolve, 2000));
    await refresh({ syncActiveTab: false });
  } finally {
    setRescanRefreshing(false);
  }
}

export async function clearActiveTabVideos() {
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

// ─── Active download jobs helper (re-export) ──────────────────────────────
import { activeDownloadJobs, isUnknownMessageTypeError } from "./popup_state.js";
export { activeDownloadJobs, isUnknownMessageTypeError };
