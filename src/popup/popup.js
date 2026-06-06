"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const isPromiseApi = typeof browser !== "undefined";
const videoFilters = globalThis.QwinVideoFilters;
const qualityFormat = globalThis.QwinQualityFormat;

let activeTabId = null;
let currentVideos = [];
let currentDownloads = [];
let viewMode = "videos";
let videoLayoutMode = "list";
let qualityRequestSerial = 0;
const ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

const elements = {
  helperStatus: document.getElementById("helperStatus"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsStatus: document.getElementById("settingsStatus"),
  viewToggle: document.getElementById("viewToggle"),
  contentView: document.getElementById("contentView"),
  footerActions: document.getElementById("footerActions"),
  showVideos: document.getElementById("showVideos"),
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
};

function runtimeMessage(message) {
  if (isPromiseApi) {
    return api.runtime.sendMessage(message);
  }
  return new Promise((resolve) => {
    api.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response);
    });
  });
}

function tabsQuery(query) {
  if (isPromiseApi) {
    return api.tabs.query(query);
  }
  return new Promise((resolve) => api.tabs.query(query, resolve));
}

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
  return video.title || shortenUrl(video.url) || "Video";
}

function displayFormat(video) {
  if (videoFilters && typeof videoFilters.displayVideoFormat === "function") {
    return videoFilters.displayVideoFormat(video);
  }
  return video.format || "VIDEO";
}

function sourceLabel(video) {
  if (["M3U8", "MPD", "YOUTUBE"].includes(String(video.format || "").toUpperCase())) {
    return "full video";
  }
  if (video.source === "manual-url" || String(video.format || "").toUpperCase() === "PAGE") {
    return "manual link";
  }
  return video.source || "detected";
}

function videoSizeLabel(video) {
  if (videoFilters && typeof videoFilters.displayVideoSize === "function") {
    return videoFilters.displayVideoSize(video);
  }
  return video.size || "";
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
    if (/\.(?:gif|gifv)(?:$|[?#])/i.test(parsed.href)) {
      return "";
    }
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
}

function setSettingsStatus(text, isError = false) {
  const value = String(text || "").trim();
  elements.settingsStatus.textContent = value;
  elements.settingsStatus.hidden = !value;
  elements.settingsStatus.classList.toggle("error", isError);
}

function isUnknownMessageTypeError(response) {
  return /unknown message type/i.test(String(response?.error || ""));
}

function setHelperStatus(text, className = "") {
  elements.helperStatus.textContent = text;
  elements.helperStatus.className = `helper-status ${className}`.trim();
}

function setViewMode(mode) {
  viewMode = mode === "downloads" ? "downloads" : "videos";
  const downloadsOnly = viewMode === "downloads";

  elements.videoList.hidden = downloadsOnly;
  elements.downloadList.hidden = !downloadsOnly;
  elements.message.hidden = downloadsOnly;
  elements.videoToolbar.hidden = downloadsOnly || !currentVideos.length;
  elements.showVideos.classList.toggle("active", !downloadsOnly);
  elements.showDownloads.classList.toggle("active", downloadsOnly);
  elements.showVideos.setAttribute("aria-pressed", String(!downloadsOnly));
  elements.showDownloads.setAttribute("aria-pressed", String(downloadsOnly));
}

function setSettingsOpen(open) {
  elements.settingsPanel.hidden = !open;
  elements.viewToggle.hidden = open;
  elements.contentView.hidden = open;
  elements.footerActions.hidden = open;
  elements.settingsToggle.classList.toggle("active", open);
  elements.settingsToggle.setAttribute("aria-expanded", String(open));

  if (open) {
    hideQualityDialog();
  }
}

function setVideoLayoutMode(mode) {
  videoLayoutMode = mode === "boxes" ? "boxes" : "list";
  const boxes = videoLayoutMode === "boxes";
  elements.videoList.classList.toggle("boxes", boxes);
  elements.showListLayout.classList.toggle("active", !boxes);
  elements.showBoxLayout.classList.toggle("active", boxes);
  elements.showListLayout.setAttribute("aria-pressed", String(!boxes));
  elements.showBoxLayout.setAttribute("aria-pressed", String(boxes));
}

function jobForVideo(videoId) {
  return currentDownloads.find((job) => job.videoId === videoId && ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued"));
}

function hasDownloadPercent(job) {
  return typeof job?.percent === "number" && Number.isFinite(job.percent);
}

function clampDownloadPercent(percent) {
  return Math.max(0, Math.min(100, Number(percent)));
}

function formatDownloadPercent(percent) {
  return `${Math.round(clampDownloadPercent(percent))}%`;
}

function downloadProgressButtonText(job) {
  const stage = String(job?.stage || "").trim();
  if (stage === "postprocess") {
    return "Converting";
  }

  if (hasDownloadPercent(job)) {
    return formatDownloadPercent(job.percent);
  }

  const status = job?.status || "queued";
  if (status === "queued") {
    return "Queued";
  }
  if (status === "connecting") {
    return "Connecting";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "pausing") {
    return "Pausing";
  }
  if (status === "canceling") {
    return "Canceling";
  }
  if (job?.fragment) {
    return `Frag ${job.fragment}`;
  }
  if (job?.speed) {
    return job.speed;
  }
  if (stage === "download") {
    return "Active";
  }
  return "Starting";
}

function downloadProgressLabel(job) {
  const stage = String(job?.stage || "").trim();
  if (stage === "postprocess") {
    return "Converting into playable video";
  }

  if (hasDownloadPercent(job)) {
    return `${formatDownloadPercent(job.percent)} downloaded`;
  }

  if (stage === "download") {
    if (job?.fragment) {
      return `Downloading fragments ${job.fragment}`;
    }
    if (job?.speed) {
      return `Downloading at ${job.speed}`;
    }
    return "Downloading video";
  }
  if (stage === "extract") {
    if (job?.fragment) {
      return `Preparing fragments ${job.fragment}`;
    }
    return "Preparing video";
  }
  if (stage === "destination") {
    return "Preparing file";
  }

  const status = job?.status || "queued";
  if (status === "queued") {
    return "Queued";
  }
  if (status === "connecting") {
    return "Connecting to helper";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "pausing") {
    return "Pausing";
  }
  if (status === "canceling") {
    return "Canceling";
  }
  if (status === "running") {
    return "Download running";
  }
  return "Starting";
}

function isFakeDownloadMessage(text) {
  return /^Downloading(?:\.\.\.| to\b)/i.test(String(text || "").trim());
}

function downloadMessageText(job) {
  if (!job) {
    return "";
  }
  if (job.error) {
    return job.error;
  }
  if (hasDownloadPercent(job)) {
    return "";
  }

  const text = String(job.message || "").trim();
  if (!text || isFakeDownloadMessage(text) || ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued")) {
    return "";
  }
  return text || job.url || "";
}

function formatDownloadTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toLocaleString();
}

function cleanDetailValue(value) {
  return String(value || "").trim();
}

function appendDetailEntry(entries, label, value) {
  const text = cleanDetailValue(value);
  if (text) {
    entries.push({ label, value: text });
  }
}

function downloadDetailEntries(job) {
  const entries = [];
  if (!job) {
    return entries;
  }

  appendDetailEntry(entries, "Status", job.status || "queued");
  if (hasDownloadPercent(job)) {
    appendDetailEntry(entries, "Progress", `${formatDownloadPercent(job.percent)} of 100%`);
  }
  if (typeof job.rawPercent === "number" && Number.isFinite(job.rawPercent)) {
    appendDetailEntry(entries, "Tool percent", formatDownloadPercent(job.rawPercent));
  }
  appendDetailEntry(entries, "Speed", job.speed);
  appendDetailEntry(entries, "ETA", job.eta);
  appendDetailEntry(entries, "Downloaded", job.downloadedSize);
  appendDetailEntry(entries, "Total size", job.totalSize);
  appendDetailEntry(entries, "Connections", job.connections);
  appendDetailEntry(entries, "Fragment", job.fragment);
  appendDetailEntry(entries, "Stage", job.stage);
  appendDetailEntry(entries, "Format", job.format);
  appendDetailEntry(entries, "Quality", job.formatId);
  appendDetailEntry(entries, "Saved file", job.filepath);
  appendDetailEntry(entries, "Artifact folder", job.artifactRoot);
  appendDetailEntry(entries, "Page URL", job.pageUrl);
  appendDetailEntry(entries, "Source URL", job.url);
  appendDetailEntry(entries, "Helper output", job.rawProgressLine);
  appendDetailEntry(entries, "Last update", formatDownloadTimestamp(job.updatedAt));
  return entries;
}

function appendDownloadDetails(container, job) {
  const entries = downloadDetailEntries(job);
  if (!entries.length) {
    return;
  }

  const details = document.createElement("div");
  details.className = "download-details";

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "download-detail";

    const label = document.createElement("span");
    label.className = "download-detail-label";
    label.textContent = entry.label;

    const value = document.createElement("span");
    value.className = "download-detail-value";
    value.textContent = entry.value;

    row.append(label, value);
    details.append(row);
  }

  container.append(details);
}

function appendDownloadProgress(container, job, options = {}) {
  if (!job || job.status === "error") {
    return;
  }

  const knownPercent = hasDownloadPercent(job);
  const displayPercent = knownPercent ? clampDownloadPercent(job.percent) : 0;

  const progress = document.createElement("div");
  progress.className = `progress ${options.compact ? "compact" : ""}`.trim();
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Download progress");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuetext", downloadProgressLabel(job));
  if (knownPercent) {
    progress.setAttribute("aria-valuenow", String(Math.round(displayPercent)));
  }

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const fill = document.createElement("span");
  fill.style.width = `${displayPercent}%`;
  bar.append(fill);

  const label = document.createElement("div");
  label.className = "progress-label";
  label.textContent = downloadProgressLabel(job);

  progress.append(bar, label);
  container.append(progress);
}

function appendVideoPlaceholder(container) {
  const placeholder = document.createElement("div");
  placeholder.className = "video-placeholder";
  const icon = document.createElement("span");
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

function renderVideos() {
  elements.videoList.textContent = "";

  if (!currentVideos.length) {
    setMessage("No downloadable video URL detected yet.");
    return;
  }

  setMessage(`${currentVideos.length} full video${currentVideos.length === 1 ? "" : "s"} detected.`);

  for (const video of currentVideos) {
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
    button.textContent = "Download";
    button.dataset.videoId = video.id;

    const runningJob = jobForVideo(video.id);
    if (!video.downloadable || runningJob) {
      button.disabled = true;
      button.textContent = runningJob ? downloadProgressButtonText(runningJob) : "Unsupported";
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
    const sizeLabel = videoSizeLabel(video);
    if (sizeLabel) {
      const size = document.createElement("span");
      size.className = "video-size";
      size.textContent = sizeLabel;
      meta.append(size);
    }

    if (!video.downloadable) {
      const warning = document.createElement("div");
      warning.className = "download-message error";
      warning.textContent = "Browser-only URL. Wait for a downloadable video stream. The helper saves supported streams as MP4.";
      content.append(main, meta, warning);
    } else {
      content.append(main, meta);
      appendDownloadProgress(content, runningJob, { compact: true });
    }

    item.append(content);
    elements.videoList.append(item);
  }
}

function renderDownloads() {
  elements.downloadList.textContent = "";
  const recent = currentDownloads;

  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "download-message";
    empty.textContent = "No downloads yet.";
    elements.downloadList.append(empty);
    return;
  }

  for (const job of recent) {
    const item = document.createElement("section");
    item.className = "download-item";

    const header = document.createElement("div");
    header.className = "download-header";

    const badge = document.createElement("span");
    badge.className = `badge ${job.status === "error" ? "warning" : ""}`.trim();
    badge.textContent = job.status || "queued";

    const title = document.createElement("div");
    title.className = "download-title";
    title.textContent = job.title || shortenUrl(job.url) || "Video";

    const messageText = downloadMessageText(job);
    const message = document.createElement("div");
    message.className = `download-message ${job.status === "error" ? "error" : ""}`.trim();
    message.textContent = messageText;

    header.append(badge, title);
    item.append(header);

    appendDownloadProgress(item, job);

    if (messageText) {
      item.append(message);
    }

    appendDownloadDetails(item, job);

    const actions = document.createElement("div");
    actions.className = "download-actions";
    const status = job.status || "queued";
    const active = ["queued", "connecting", "running", "pausing", "canceling"].includes(status);

    if (["queued", "connecting", "running"].includes(status)) {
      appendDownloadAction(actions, "Pause", "pause", job.id);
    }
    if (status === "paused") {
      appendDownloadAction(actions, "Resume", "resume", job.id, true);
    }
    if (active || status === "paused") {
      appendDownloadAction(actions, "Cancel", "cancel", job.id);
    }
    if (["done", "error", "canceled"].includes(status)) {
      appendDownloadAction(actions, status === "done" ? "Redownload" : "Retry", "retry", job.id, true);
    }
    if (job.filepath) {
      appendDownloadAction(actions, "Open", "open-file", job.id);
      appendDownloadAction(actions, "Folder", "show-folder", job.id);
    }
    if (!active && status !== "paused") {
      appendDownloadAction(actions, "Remove", "remove", job.id);
    }

    if (actions.children.length) {
      item.append(actions);
    }

    elements.downloadList.append(item);
  }
}

function appendDownloadAction(container, label, action, jobId, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("data-action", action);
  button.setAttribute("data-job-id", jobId);
  if (primary) {
    button.className = "primary";
  }
  container.append(button);
}

function render() {
  renderVideos();
  renderDownloads();
  setVideoLayoutMode(videoLayoutMode);
  setViewMode(viewMode);
}

function hideQualityDialog() {
  elements.qualityDialog.hidden = true;
  elements.qualityList.textContent = "";
  elements.cancelQuality.disabled = false;
  elements.cancelQuality.textContent = "Cancel";
}

function showQualityLoading(title = "Loading versions...") {
  const requestToken = ++qualityRequestSerial;
  elements.qualityTitle.textContent = title;
  elements.qualityList.textContent = "";

  const loading = document.createElement("div");
  loading.className = "quality-loading";
  loading.textContent = "Checking available video versions...";
  elements.qualityList.append(loading);

  elements.cancelQuality.disabled = false;
  elements.cancelQuality.textContent = "Cancel";
  elements.cancelQuality.onclick = () => {
    qualityRequestSerial += 1;
    hideQualityDialog();
  };
  elements.qualityDialog.hidden = false;
  return requestToken;
}

function isCurrentQualityRequest(requestToken) {
  return requestToken === qualityRequestSerial;
}

function formatQualityValue(format) {
  return qualityFormat.formatQualityValue(format);
}

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

function formatSizeValue(format) {
  return qualityFormat.formatSizeValue(format, videoFilters);
}

function formatFormatValue(format) {
  return qualityFormat.formatFormatValue(format);
}

function formatBitrateValue(format) {
  return qualityFormat.formatBitrateValue(format);
}

function formatSourceValue(format) {
  return qualityFormat.formatSourceValue(format);
}

function appendQualityCell(row, text, className = "") {
  const cell = document.createElement("span");
  cell.className = `quality-cell ${className}`.trim();
  cell.textContent = text || "Unknown";
  row.append(cell);
}

function appendQualityHeader(table) {
  const header = document.createElement("div");
  header.className = "quality-row quality-header";
  header.setAttribute("role", "row");
  for (const label of ["Quality", "Size", "Format", "Bitrate", "Source"]) {
    appendQualityCell(header, label);
  }
  table.append(header);
}

function chooseQuality({ title, formats, nativeError }) {
  return new Promise((resolve) => {
    elements.qualityTitle.textContent = title ? `Compare versions: ${title}` : "Compare versions";
    elements.qualityList.textContent = "";

    const choices = formats && formats.length ? formats : [{ id: "best", label: "Best available MP4" }];
    const table = document.createElement("div");
    table.className = "quality-table";
    table.setAttribute("role", "table");
    appendQualityHeader(table);

    for (const format of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quality-row quality-option";
      button.dataset.formatId = format.formatId || format.id || "best";
      button.dataset.variantId = format.variantId || "";
      button.setAttribute("role", "row");
      button.title = format.sourceUrl || format.label || "";

      appendQualityCell(button, formatQualityValue(format), "primary-cell");
      appendQualityCell(button, formatSizeValue(format));
      appendQualityCell(button, formatFormatValue(format));
      appendQualityCell(button, formatBitrateValue(format));
      appendQualityCell(button, formatSourceValue(format));

      button.addEventListener("click", () => {
        hideQualityDialog();
        resolve({
          formatId: button.dataset.formatId || "best",
          variantId: button.dataset.variantId || "",
        });
      });
      table.append(button);
    }

    elements.qualityList.append(table);
    if (nativeError) {
      const note = document.createElement("div");
      note.className = "quality-note";
      note.textContent = nativeError;
      elements.qualityList.append(note);
    }

    const cancel = () => {
      hideQualityDialog();
      resolve(null);
    };
    elements.cancelQuality.onclick = cancel;
    elements.qualityDialog.hidden = false;
  });
}

async function refresh() {
  if (!activeTabId) {
    return;
  }

  const response = await runtimeMessage({ type: "getVideos", tabId: activeTabId });
  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Could not read extension state.", true);
    return;
  }

  currentVideos = response.videos || [];
  currentDownloads = response.downloads || [];
  elements.downloadFolder.value = (response.settings && response.settings.downloadFolder) || "";
  render();
}

async function checkNativeHost() {
  const response = await runtimeMessage({ type: "pingNativeHost" });
  if (!response || !response.ok) {
    setHelperStatus("Helper not connected. Run scripts\\install.bat.", "error");
    return;
  }

  const dependencies = response.dependencies || {};
  if (!dependencies.ytDlp || !dependencies.ffmpeg) {
    setHelperStatus("Helper found, but yt-dlp or ffmpeg is missing. Run scripts\\install.bat.", "error");
    return;
  }

  const mode = dependencies.aria2c ? "fast mode" : "standard mode";
  setHelperStatus(`Helper ready (${response.version || "installed"}, ${mode}).`, "ok");
}

async function init() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  activeTabId = tabs && tabs[0] ? tabs[0].id : null;

  if (!activeTabId) {
    setMessage("No active tab found.", true);
    return;
  }

  await refresh();
  await runtimeMessage({ type: "rescanTab", tabId: activeTabId });
  await checkNativeHost();
}

elements.videoList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-video-id]");
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = "Loading...";
  const requestToken = showQualityLoading();
  const formatsResponse = await runtimeMessage({
    type: "getVideoFormats",
    tabId: activeTabId,
    videoId: button.dataset.videoId,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    button.disabled = false;
    button.textContent = "Download";
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setMessage(formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load quality choices.", true);
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
  const response = await runtimeMessage({
    type: "downloadVideo",
    tabId: activeTabId,
    videoId: button.dataset.videoId,
    formatId: selectedFormat.formatId,
    variantId: selectedFormat.variantId,
  });

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
  let request = null;

  if (action === "pause") {
    request = { type: "pauseDownload", tabId: activeTabId, jobId };
  } else if (action === "resume") {
    request = { type: "resumeDownload", tabId: activeTabId, jobId };
  } else if (action === "cancel") {
    request = { type: "cancelDownload", tabId: activeTabId, jobId };
  } else if (action === "retry") {
    request = { type: "retryDownload", tabId: activeTabId, jobId };
  } else if (action === "open-file") {
    request = { type: "openDownloadedFile", tabId: activeTabId, jobId };
  } else if (action === "show-folder") {
    request = { type: "showDownloadedFile", tabId: activeTabId, jobId };
  } else if (action === "remove") {
    request = { type: "removeDownload", tabId: activeTabId, jobId };
  }

  if (!request) {
    return;
  }

  button.disabled = true;
  const response = await runtimeMessage(request);
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
});

elements.showDownloads.addEventListener("click", () => {
  setViewMode("downloads");
});

elements.showListLayout.addEventListener("click", () => {
  setVideoLayoutMode("list");
});

elements.showBoxLayout.addEventListener("click", () => {
  setVideoLayoutMode("boxes");
});

elements.saveSettings.addEventListener("click", async () => {
  const response = await runtimeMessage({
    type: "saveSettings",
    settings: { downloadFolder: elements.downloadFolder.value.trim() },
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

  const response = await runtimeMessage({ type: "chooseDownloadFolder" });

  elements.chooseDownloadFolder.disabled = false;
  elements.chooseDownloadFolder.textContent = "Browse";

  if (!response || !response.ok) {
    if (isUnknownMessageTypeError(response)) {
      setSettingsStatus("Reload Qwin from the browser extensions page, then open settings and click Browse again.", true);
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
  const manualUrl = normalizeManualUrl(elements.manualUrl.value);
  if (!manualUrl) {
    setSettingsStatus("Enter a valid http:// or https:// video page URL.", true);
    return;
  }

  setSettingsStatus("");
  elements.downloadManualUrl.disabled = true;
  elements.downloadManualUrl.textContent = "Loading...";
  const requestToken = showQualityLoading("Loading link...");
  const formatsResponse = await runtimeMessage({
    type: "getFormatsForUrl",
    tabId: activeTabId,
    video: {
      url: manualUrl,
      pageUrl: manualUrl,
      title: shortenUrl(manualUrl) || "Manual link",
      format: "PAGE",
      source: "manual-url",
      downloadable: true,
    },
  });

  if (!isCurrentQualityRequest(requestToken)) {
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setSettingsStatus(
      formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load quality choices for that link.",
      true
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
  const response = await runtimeMessage({
    type: "downloadVideo",
    tabId: activeTabId,
    videoId: formatsResponse.videoId,
    formatId: selectedFormat.formatId,
    variantId: selectedFormat.variantId,
  });

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

elements.rescan.addEventListener("click", async () => {
  await runtimeMessage({ type: "rescanTab", tabId: activeTabId });
  window.setTimeout(refresh, 350);
});

elements.clear.addEventListener("click", async () => {
  await runtimeMessage({ type: "clearVideos", tabId: activeTabId });
  await refresh();
});

api.runtime.onMessage.addListener((message) => {
  if (!message) {
    return;
  }

  if (message.type === "videoListUpdated" && message.tabId === activeTabId) {
    currentVideos = message.videos || [];
    render();
  }

  if (message.type === "downloadUpdated" && message.job) {
    const existingIndex = currentDownloads.findIndex((job) => job.id === message.job.id);
    if (existingIndex >= 0) {
      currentDownloads[existingIndex] = message.job;
    } else {
      currentDownloads.unshift(message.job);
    }
    render();
  }

  if (message.type === "downloadRemoved" && message.jobId) {
    currentDownloads = currentDownloads.filter((job) => job.id !== message.jobId);
    render();
  }
});

init();
