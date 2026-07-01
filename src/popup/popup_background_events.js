"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupState from "../shared/popup_state.js";
import { elements, qualityChooser, api } from "./popup_elements.js";
import {
  setMessage,
  renderDepBanner,
  checkHelperStatus,
  copyInstallCommand,
} from "./popup_helpers.js";

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
    // Only show downloads for the current active tab to prevent cross-tab
    // interference — old downloads from other tabs/sites should not pollute
    // the download list when the user navigates to a new site.
    if (message.job.tabId && message.job.tabId !== PopupState.get("activeTabId")) {
      return;
    }
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

  // No tabId guard needed for downloadRemoved — the jobId is unique, and
  // cross-tab removals won't find a match in the current tab's filtered list.
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
