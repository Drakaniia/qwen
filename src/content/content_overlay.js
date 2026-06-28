"use strict";

/**
 * Content Script — Overlay UI Module
 *
 * Manages the "Download" overlay buttons on detected <video> elements,
 * the quality chooser dialog, and overlay positioning.
 *
 * Extracted from content.js for modularity.
 */

import * as qualityFormat from "../shared/quality_format.js";
import * as qualityDialog from "../shared/quality_dialog.js";
import * as videoFilters from "../shared/video_filters.js";
import * as videoPicker from "../shared/video_picker.js";

// ─── Overlay state ─────────────────────────────────────────────────────────

const overlayByVideo = new WeakMap();
const overlayRecords = new Set();

let overlayDialog = null;
let overlayQualityChooser = null;
let overlayRequestSerial = 0;

// ─── Overlay button ────────────────────────────────────────────────────────

function createOverlayButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Download";
  button.title = "Open available video";
  button.setAttribute("aria-label", "Open available video");
  button.style.position = "fixed";
  button.style.zIndex = "2147483647";
  button.style.minWidth = "96px";
  button.style.height = "34px";
  button.style.padding = "0 12px";
  button.style.border = "1px solid rgba(255, 255, 255, 0.45)";
  button.style.borderRadius = "6px";
  button.style.background = "rgba(15, 118, 110, 0.96)";
  button.style.color = "#fff";
  button.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.28)";
  button.style.font = "700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  button.style.cursor = "pointer";
  button.style.display = "none";
  button.style.letterSpacing = "0";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await showAvailableVideosOverlay();
  });
  return button;
}

// ─── Overlay dialog ────────────────────────────────────────────────────────

function ensureOverlay() {
  if (overlayDialog && overlayDialog.root.isConnected) {
    return overlayDialog;
  }

  const root = document.createElement("div");
  root.id = "qwin-video-overlay";
  root.hidden = true;

  const card = document.createElement("div");
  card.className = "qwin-overlay-card";

  const header = document.createElement("div");
  header.className = "qwin-overlay-header";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "qwin-overlay-back";
  back.textContent = "Back";
  back.hidden = true;
  back.addEventListener("click", () => showAvailableVideosOverlay());

  const title = document.createElement("h2");
  title.className = "qwin-overlay-title";

  const list = document.createElement("div");
  list.className = "qwin-overlay-list";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "qwin-overlay-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => hideOverlay());

  header.append(back, title);
  card.append(header, list, cancel);
  root.append(card);
  (document.fullscreenElement || document.body || document.documentElement).append(root);
  overlayDialog = { root, card, header, back, title, list, cancel };
  overlayQualityChooser = null;
  return overlayDialog;
}

function hideOverlay() {
  if (!overlayDialog || !overlayDialog.root) {
    return;
  }

  if (overlayQualityChooser) {
    overlayQualityChooser.hide();
    return;
  }

  overlayDialog.root.hidden = true;
  overlayDialog.list.textContent = "";
  overlayDialog.back.hidden = true;
  overlayDialog.cancel.disabled = false;
  overlayDialog.cancel.textContent = "Cancel";
}

// ─── Quality chooser dialog ────────────────────────────────────────────────

function ensureQualityChooser() {
  const dialog = ensureOverlay();
  if (overlayQualityChooser) {
    return overlayQualityChooser;
  }
  if (!qualityDialog || typeof qualityDialog.create !== "function") {
    throw new Error("QwinQualityDialog is not loaded.");
  }

  overlayQualityChooser = qualityDialog.create({
    document,
    root: dialog.root,
    title: dialog.title,
    list: dialog.list,
    cancel: dialog.cancel,
    back: dialog.back,
    qualityFormat,
    videoFilters,
    loadingStatusId: "qwin-quality-loading-status",
    style: "classes",
    hideOnSelect: false,
    hideOnBack: false,
    showRoot(root) {
      root.hidden = false;
    },
    hideRoot(root) {
      root.hidden = true;
    },
  });
  return overlayQualityChooser;
}

function showQualityLoadingDialog(title = "Loading versions...") {
  const requestToken = ++overlayRequestSerial;
  ensureQualityChooser().showLoading({
    loadingTitle: title,
    onCancel() {
      overlayRequestSerial += 1;
    },
  });
  return requestToken;
}

function updateQualityLoadingStatus(text) {
  ensureQualityChooser().updateLoadingStatus(text);
}

function isCurrentQualityRequest(requestToken) {
  return requestToken === overlayRequestSerial;
}

function showQualityDialog({ title, formats }, hasBack = false) {
  return ensureQualityChooser().showChoices({
    choiceTitle: title,
    formats,
    hasBack,
  });
}

// ─── Available videos overlay ─────────────────────────────────────────────

let _showAvailableVideosHandler = null;

/**
 * Register the handler to show the available videos overlay.
 * Called by content.js to set up the cross-module handler for this function
 * which needs sendMessageWithResponse and lastDetectedVideos from content.js.
 *
 * @param {(message: Object) => Promise<Object>} sendMessageWithResponseFn
 * @param {() => Array} getLastDetectedVideosFn
 */
function setShowAvailableVideosHandler(sendMessageWithResponseFn, getLastDetectedVideosFn) {
  _showAvailableVideosHandler = async () => {
    const dialog = ensureOverlay();
    dialog.title.textContent = "Available Videos";
    dialog.list.textContent = "";
    dialog.back.hidden = true;
    dialog.root.hidden = false;

    const response = await sendMessageWithResponseFn({ type: "getVideos" });
    const videos = response && response.ok ? response.videos : getLastDetectedVideosFn();

    if (!videoPicker || typeof videoPicker.renderList !== "function") {
      dialog.list.textContent = "No downloadable video detected yet.";
      return;
    }

    videoPicker.renderList(dialog.list, videos, {
      videoFilters,
      emptyText: "No downloadable video detected yet.",
      onSelect: handleVideoSelection,
    });
  };
}

async function showAvailableVideosOverlay() {
  if (!_showAvailableVideosHandler) {
    return;
  }
  await _showAvailableVideosHandler();
}

// ─── Video selection / download flow ───────────────────────────────────────

let _sendMessageWithResponse = null;

/**
 * Initialize overlay with core dependencies from content.js.
 *
 * @param {Object} deps
 * @param {(message: Object) => Promise<Object>} deps.sendMessageWithResponse
 * @param {() => Array} deps.getLastDetectedVideos
 */
function initOverlay(deps) {
  _sendMessageWithResponse = deps.sendMessageWithResponse;
  setShowAvailableVideosHandler(deps.sendMessageWithResponse, deps.getLastDetectedVideos);
}

async function handleVideoSelection(video) {
  const dialog = ensureOverlay();
  dialog.list.textContent = "";
  dialog.title.textContent = "Loading...";

  const requestToken = showQualityLoadingDialog(video.title || "Video");
  const formatsResponse = await _sendMessageWithResponse({
    type: "getFormatsForUrl",
    video: video,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideOverlay();
    return;
  }

  const selectedFormat = await showQualityDialog(formatsResponse, true);
  if (!selectedFormat) {
    await showAvailableVideosOverlay();
    return;
  }

  dialog.list.textContent = "";
  dialog.title.textContent = "Sending...";
  const response = await _sendMessageWithResponse({
    type: "downloadVideo",
    videoId: formatsResponse.videoId,
    formatId: selectedFormat.formatId,
    variantId: selectedFormat.variantId,
    backend: selectedFormat.backend,
  });

  if (!response || !response.ok) {
    dialog.title.textContent = "Error";
    window.setTimeout(showAvailableVideosOverlay, 1000);
    return;
  }

  dialog.title.textContent = "Queued";
  window.setTimeout(hideOverlay, 700);
}

// ─── Overlay positioning ───────────────────────────────────────────────────

function positionOverlay(record) {
  if (!record.video.isConnected) {
    removeOverlay(record.video);
    return;
  }

  const rect = record.video.getBoundingClientRect();
  const visible =
    rect.width >= 160 &&
    rect.height >= 90 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  if (!visible) {
    record.button.style.display = "none";
    return;
  }

  // Ensure button is attached to the correct parent (handles fullscreen)
  const targetParent = document.fullscreenElement || document.body || document.documentElement;
  if (record.button.parentElement !== targetParent) {
    targetParent.append(record.button);
  }

  const left = Math.max(8, Math.min(rect.right - 106, window.innerWidth - 114));
  const top = Math.max(8, rect.top + 8);
  record.button.style.left = `${left}px`;
  record.button.style.top = `${top}px`;
  record.button.style.display = "block";
}

function positionAllOverlays() {
  for (const record of Array.from(overlayRecords)) {
    positionOverlay(record);
  }
}

function removeOverlay(video) {
  const record = overlayByVideo.get(video);
  if (!record) {
    return;
  }
  record.button.remove();
  overlayByVideo.delete(video);
  overlayRecords.delete(record);
}

function updateOverlay(video, candidate, allowBestDetectedFallback = false) {
  if (!candidate && !allowBestDetectedFallback) {
    removeOverlay(video);
    return;
  }

  let record = overlayByVideo.get(video);
  if (!record) {
    const button = createOverlayButton();
    (document.fullscreenElement || document.body || document.documentElement).append(button);
    record = { video, button, candidate };
    overlayByVideo.set(video, record);
    overlayRecords.add(record);
  }

  record.candidate = candidate || null;
  record.button.title = "Open available video";
  positionOverlay(record);
}

export {
  initOverlay,
  ensureOverlay,
  hideOverlay,
  showQualityLoadingDialog,
  updateQualityLoadingStatus,
  isCurrentQualityRequest,
  showQualityDialog,
  showAvailableVideosOverlay,
  positionAllOverlays,
  updateOverlay,
  removeOverlay,
};
