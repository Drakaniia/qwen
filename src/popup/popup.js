"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const isPromiseApi = typeof browser !== "undefined";
const videoFilters = globalThis.QwinVideoFilters;

let activeTabId = null;
let currentVideos = [];
let currentDownloads = [];
let viewMode = "videos";

const elements = {
  helperStatus: document.getElementById("helperStatus"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  showVideos: document.getElementById("showVideos"),
  showDownloads: document.getElementById("showDownloads"),
  downloadFolder: document.getElementById("downloadFolder"),
  saveSettings: document.getElementById("saveSettings"),
  message: document.getElementById("message"),
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
  if (["M3U8", "MPD"].includes(String(video.format || "").toUpperCase())) {
    return "full video";
  }
  return video.source || "detected";
}

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
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
  elements.showVideos.classList.toggle("active", !downloadsOnly);
  elements.showDownloads.classList.toggle("active", downloadsOnly);
  elements.showVideos.setAttribute("aria-pressed", String(!downloadsOnly));
  elements.showDownloads.setAttribute("aria-pressed", String(downloadsOnly));
}

function jobForVideo(videoId) {
  return currentDownloads.find((job) => job.videoId === videoId && ["queued", "connecting", "running"].includes(job.status));
}

function renderVideos() {
  elements.videoList.textContent = "";

  if (!currentVideos.length) {
    setMessage("Scanning for videos...");
    return;
  }

  setMessage(`${currentVideos.length} video URL${currentVideos.length === 1 ? "" : "s"} detected.`);

  for (const video of currentVideos) {
    const item = document.createElement("section");
    item.className = "video-item";

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
      button.textContent = runningJob ? "Downloading" : "Unsupported";
    }

    main.append(details, button);

    const meta = document.createElement("div");
    meta.className = "meta";
    const badge = document.createElement("span");
    badge.className = `badge ${video.downloadable ? "" : "warning"}`.trim();
    badge.textContent = displayFormat(video);
    const source = document.createElement("span");
    source.textContent = sourceLabel(video);
    meta.append(badge, source);

    if (!video.downloadable) {
      const warning = document.createElement("div");
      warning.className = "download-message error";
      warning.textContent = "Browser-only URL. Wait for a downloadable video stream. The helper saves supported streams as MP4.";
      item.append(main, meta, warning);
    } else {
      item.append(main, meta);
    }

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

    const message = document.createElement("div");
    message.className = `download-message ${job.status === "error" ? "error" : ""}`.trim();
    message.textContent = job.error || job.message || job.url || "";

    header.append(badge, title);
    item.append(header);

    if (typeof job.percent === "number" && job.status !== "error") {
      const progress = document.createElement("div");
      progress.className = "progress";
      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, job.percent))}%`;
      bar.append(fill);
      progress.append(bar);
      item.append(progress);
    }

    item.append(message);

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
  setViewMode(viewMode);
}

function hideQualityDialog() {
  elements.qualityDialog.hidden = true;
  elements.qualityList.textContent = "";
}

function chooseQuality({ title, formats }) {
  return new Promise((resolve) => {
    elements.qualityTitle.textContent = title ? `Choose quality: ${title}` : "Choose quality";
    elements.qualityList.textContent = "";

    const choices = formats && formats.length ? formats : [{ id: "best", label: "Best available MP4" }];
    for (const format of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quality-option";
      button.dataset.formatId = format.id || "best";

      const label = document.createElement("span");
      label.textContent = format.label || format.id || "Best";
      const meta = document.createElement("small");
      meta.textContent = [format.size, format.note].filter(Boolean).join(" / ");
      button.append(label, meta);

      button.addEventListener("click", () => {
        hideQualityDialog();
        resolve(button.dataset.formatId || "best");
      });
      elements.qualityList.append(button);
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

  setHelperStatus(`Helper ready (${response.version || "installed"}).`, "ok");
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
  button.textContent = "Quality...";
  const formatsResponse = await runtimeMessage({
    type: "getVideoFormats",
    tabId: activeTabId,
    videoId: button.dataset.videoId,
  });

  if (!formatsResponse || !formatsResponse.ok) {
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
    formatId: selectedFormat,
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
  elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
});

elements.showVideos.addEventListener("click", () => {
  setViewMode("videos");
});

elements.showDownloads.addEventListener("click", () => {
  setViewMode("downloads");
});

elements.saveSettings.addEventListener("click", async () => {
  const response = await runtimeMessage({
    type: "saveSettings",
    settings: { downloadFolder: elements.downloadFolder.value.trim() },
  });
  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Could not save settings.", true);
    return;
  }
  setMessage("Settings saved.");
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

  if (message.type === "downloadUpdated" && message.job && message.job.tabId === activeTabId) {
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
