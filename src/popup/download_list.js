(function attachQwinDownloadList(root, factory) {
  const downloadList = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = downloadList;
  }
  root.QwinDownloadList = downloadList;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinDownloadList() {
  "use strict";

  const ACTIVE_STATUSES = new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]);

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function hasDownloadPercent(job) {
    return typeof job?.percent === "number" && Number.isFinite(job.percent);
  }

  function clampDownloadPercent(percent) {
    return Math.max(0, Math.min(100, Number(percent)));
  }

  function formatDownloadPercent(percent) {
    return `${Math.round(clampDownloadPercent(percent))}%`;
  }

  function isProcessingStage(job) {
    const stage = String(job?.stage || "").trim();
    return stage === "postprocess" || stage === "destination" || stage === "filepath";
  }

  function downloadProgressButtonText(job) {
    const stage = String(job?.stage || "").trim();
    if (stage === "postprocess") {
      return "Merging";
    }
    if (stage === "destination" || stage === "filepath") {
      return "Finalizing";
    }

    if (hasDownloadPercent(job) && !isProcessingStage(job)) {
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
    if (stage === "extract") {
      return "Preparing";
    }
    return "Starting";
  }

  function downloadProgressLabel(job) {
    const stage = String(job?.stage || "").trim();
    if (stage === "postprocess") {
      return "Merging downloaded segments...";
    }
    if (stage === "destination" || stage === "filepath") {
      return "Finalizing output...";
    }

    if (hasDownloadPercent(job) && !isProcessingStage(job)) {
      return `${formatDownloadPercent(job.percent)} downloaded`;
    }

    if (stage === "download") {
      if (job?.fragment) {
        return `Downloading video segments... (${job.fragment})`;
      }
      if (job?.speed) {
        return `Downloading video segments at ${job.speed}`;
      }
      return "Downloading video segments...";
    }
    if (stage === "extract") {
      if (job?.fragment) {
        return `Preparing fragments ${job.fragment}`;
      }
      return "Preparing video...";
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
    if (!text || isFakeDownloadMessage(text) || ACTIVE_STATUSES.has(job.status || "queued")) {
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

    const processing = isProcessingStage(job);
    appendDetailEntry(entries, "Status", job.status || "queued");
    if (hasDownloadPercent(job) && !processing) {
      appendDetailEntry(entries, "Progress", `${formatDownloadPercent(job.percent)} of 100%`);
    }
    if (typeof job.rawPercent === "number" && Number.isFinite(job.rawPercent) && !processing) {
      appendDetailEntry(entries, "Tool percent", formatDownloadPercent(job.rawPercent));
    }
    if (!processing) {
      appendDetailEntry(entries, "Speed", job.speed);
      appendDetailEntry(entries, "ETA", job.eta);
    }
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

  // ─── DOM builders ──────────────────────────────────────────────────────────

  function appendDownloadDetails(container, job) {
    const entries = downloadDetailEntries(job);
    if (!entries.length) {
      return;
    }

    const details = container.ownerDocument.createElement("div");
    details.className = "download-details";

    for (const entry of entries) {
      const row = details.ownerDocument.createElement("div");
      row.className = "download-detail";

      const label = row.ownerDocument.createElement("span");
      label.className = "download-detail-label";
      label.textContent = entry.label;

      const value = row.ownerDocument.createElement("span");
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

    const doc = container.ownerDocument;
    const processing = isProcessingStage(job);
    const knownPercent = hasDownloadPercent(job) && !processing;
    const displayPercent = knownPercent ? clampDownloadPercent(job.percent) : 0;

    const progress = doc.createElement("div");
    progress.className = `progress ${options.compact ? "compact" : ""}`.trim();
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", processing ? "Processing progress" : "Download progress");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuetext", downloadProgressLabel(job));
    if (knownPercent) {
      progress.setAttribute("aria-valuenow", String(Math.round(displayPercent)));
    }

    const bar = doc.createElement("div");
    bar.className = `progress-bar ${processing ? "indeterminate" : ""}`.trim();
    const fill = doc.createElement("span");
    fill.style.width = processing ? "" : `${displayPercent}%`;
    bar.append(fill);

    const label = doc.createElement("div");
    label.className = "progress-label";
    label.textContent = downloadProgressLabel(job);

    progress.append(bar, label);
    container.append(progress);
  }

  function appendDownloadAction(container, label, action, jobId, primary) {
    const button = container.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("data-action", action);
    button.setAttribute("data-job-id", jobId);
    if (primary) {
      button.className = "primary";
    }
    container.append(button);
  }

  // ─── Main render entry ─────────────────────────────────────────────────────

  /**
   * Render the download list into a container element.
   * @param {HTMLElement} container - The download list container (e.g. #downloadList)
   * @param {Array} downloads - Array of download job objects
   * @param {Object} [options]
   * @param {function(string): string} [options.shortenUrl] - URL shortening function
   */
  function renderDownloads(container, downloads, options = {}) {
    const doc = container.ownerDocument;
    container.textContent = "";

    const recent = Array.isArray(downloads) ? downloads : [];

    if (!recent.length) {
      const empty = doc.createElement("div");
      empty.className = "download-message";
      empty.textContent = "No downloads yet.";
      container.append(empty);
      return;
    }

    const shortenUrl = typeof options.shortenUrl === "function" ? options.shortenUrl : String;

    for (const job of recent) {
      const item = doc.createElement("section");
      item.className = "download-item";

      const header = doc.createElement("div");
      header.className = "download-header";

      const badge = doc.createElement("span");
      badge.className = `badge ${job.status === "error" ? "warning" : ""}`.trim();
      badge.textContent = job.status || "queued";

      const title = doc.createElement("div");
      title.className = "download-title";
      const isAudio = String(job.format || "").toUpperCase() === "AUDIO" || String(job.title || "").includes(" - ");
      title.textContent = job.title || shortenUrl(job.url) || (isAudio ? "Music" : "Video");

      const messageText = downloadMessageText(job);
      const message = doc.createElement("div");
      message.className = `download-message ${job.status === "error" ? "error" : ""}`.trim();
      message.textContent = messageText;

      header.append(badge, title);
      item.append(header);

      appendDownloadProgress(item, job);

      if (messageText) {
        item.append(message);
      }

      appendDownloadDetails(item, job);

      const actions = doc.createElement("div");
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

      container.append(item);
    }
  }

  return {
    renderDownloads,
    appendDownloadProgress,
    downloadProgressButtonText,
    downloadProgressLabel,
    downloadDetailEntries,
    downloadMessageText,
  };
});
