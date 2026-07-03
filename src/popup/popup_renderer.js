"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as DownloadList from "./download_list.js";
import { elements, AUDIO_FORMAT, ACTIVE_DOWNLOAD_STATUSES } from "./popup_elements.js";
import {
  setMessage,
  videoTitle,
  displayFormat,
  sourceLabel,
  videoSizeLabel,
  videoThumbnailUrl,
  startRecording,
} from "./popup_helpers.js";

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

export function renderVideos(videos, downloads) {
  if (videos === null) {
    return;
  }

  elements.videoList.textContent = "";

  if (!videos.length) {
    setMessage("No downloadable video or music detected yet.");
    const recordPageBtn = document.createElement("button");
    recordPageBtn.type = "button";
    recordPageBtn.className = "record-page-button primary";
    recordPageBtn.textContent = "Record this page";
    recordPageBtn.title = "No video URL detected. Record the tab's video output instead.";
    recordPageBtn.addEventListener("click", () => {
      startRecording({ title: "Page recording", format: "RECORDING" });
    });
    elements.videoList.append(recordPageBtn);
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

    if (!video.downloadable && !runningJob) {
      const recordBtn = document.createElement("button");
      recordBtn.type = "button";
      recordBtn.className = "record-button";
      recordBtn.textContent = "Record";
      recordBtn.title = "No downloadable URL found. Record the tab's video output.";
      recordBtn.dataset.videoId = video.id;
      recordBtn.dataset.action = "record";
      recordBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startRecording(video);
      });
      main.append(recordBtn);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const badge = document.createElement("span");
    badge.className = `badge ${video.downloadable ? "" : "warning"}`.trim();
    badge.textContent = displayFormat(video);
    const source = document.createElement("span");
    source.textContent = video.variantCount > 1 ? `${video.variantCount} versions` : sourceLabel(video);
    meta.append(badge, source);
    if (video.hasSubtitles) {
      const subBadge = document.createElement("span");
      subBadge.className = "subtitle-badge";
      const langCount = video.subtitleLanguages || 0;
      subBadge.textContent = langCount > 0 ? `CC ${langCount}` : "CC";
      subBadge.title =
        langCount > 0 ? `${langCount} subtitle language${langCount === 1 ? "" : "s"} available` : "Subtitles available";
      meta.append(subBadge);
    }
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
      warning.textContent = "Browser-only URL. Wait for a downloadable video stream or use the Record button above.";
      content.append(main, meta, warning);
    } else {
      content.append(main, meta);
      DownloadList.appendDownloadProgress(content, runningJob, { compact: true });
    }

    item.append(content);
    elements.videoList.append(item);
  }
}
