"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as qualityFormat from "../shared/quality_format.js";
import * as videoFilters from "../shared/video_filters.js";
import * as qualityDialog from "../shared/quality_dialog.js";
import { ACTIVE_DOWNLOAD_STATUSES } from "./popup_state.js";

// ─── Constants ──────────────────────────────────────────────────────────────
export { ACTIVE_DOWNLOAD_STATUSES };
export const RESCAN_IDLE_LABEL = "Rescan";
export const RESCAN_BUSY_LABEL = "Refreshing";
export const AUDIO_FORMAT = "AUDIO";

export const INDICATOR_STATES = {
  CHECKING: "checking",
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
};
export const INDICATOR_TOOLTIPS = {
  checking: "Checking for videos...",
  available: "Downloadable video available",
  unavailable: "No downloadable video detected",
};
export const INDICATOR_ARIA_LABELS = {
  checking: "Checking for downloadable videos",
  available: "Downloadable video available",
  unavailable: "No downloadable video detected",
};
export const INDICATOR_DEBOUNCE_MS = 300;

// ─── Mutable module-level state ─────────────────────────────────────────────
export const indicatorDebounceTimer = null;
export const currentIndicatorState = INDICATOR_STATES.CHECKING;

// ─── API reference ──────────────────────────────────────────────────────────
export const api = typeof browser !== "undefined" ? browser : chrome;

// ─── DOM elements ───────────────────────────────────────────────────────────
export const elements = {
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
  backend: document.getElementById("backend"),
  downloadSubtitles: document.getElementById("downloadSubtitles"),
  // Sync elements
  syncHistoryToggle: document.getElementById("syncHistoryToggle"),
  syncStatus: document.getElementById("syncStatus"),
  // Batch/playlist elements
  batchBar: document.getElementById("batchBar"),
  batchLabel: document.getElementById("batchLabel"),
  batchProgress: document.getElementById("batchProgress"),
  batchProgressFill: document.getElementById("batchProgressFill"),
  batchStatus: document.getElementById("batchStatus"),
  batchCancelBtn: document.getElementById("batchCancelBtn"),
  playlistPrompt: document.getElementById("playlistPrompt"),
  playlistTitle: document.getElementById("playlistTitle"),
  downloadAllBtn: document.getElementById("downloadAllBtn"),
  // Dep banner elements
  depBanner: document.getElementById("depBanner"),
  depBannerToggle: document.getElementById("depBannerToggle"),
  depBannerBody: document.getElementById("depBannerBody"),
  depBannerList: document.getElementById("depBannerList"),
  depBannerTitle: document.getElementById("depBannerTitle"),
  depBannerCopyBtn: document.getElementById("depBannerCopyBtn"),
  // Overlay toggle
  overlayToggle: document.getElementById("overlayToggle"),
};

// ─── Quality chooser ────────────────────────────────────────────────────────
export const qualityChooser = qualityDialog.create({
  document,
  root: elements.qualityDialog,
  title: elements.qualityTitle,
  list: elements.qualityList,
  cancel: elements.cancelQuality,
  qualityFormat,
  videoFilters,
  style: "classes",
});
