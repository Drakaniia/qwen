"use strict";

import * as PopupState from "../shared/popup_state.js";
import { elements } from "./popup_elements.js";

/**
 * Render the synced download history section in the downloads view.
 *
 * Creates a "Synced History" section below the download list showing
 * recent downloads synced from other devices/browsers.
 */
export function renderSyncedHistory() {
  const state = PopupState.getState();
  const isDownloadView = state.viewMode === "downloads";

  if (!isDownloadView) {
    return;
  }

  const syncedHistory = state.syncedHistory || [];
  const syncInfo = state.syncInfo || {};

  const existingSection = document.getElementById("syncedHistorySection");
  if (existingSection) {
    existingSection.remove();
  }

  if (!syncedHistory.length) {
    return;
  }

  const section = document.createElement("div");
  section.id = "syncedHistorySection";
  section.className = "synced-section";

  const header = document.createElement("div");
  header.className = "synced-header";

  const title = document.createElement("span");
  title.className = "synced-title";
  title.textContent = "Synced History";
  header.append(title);

  if (syncInfo.totalCount > 0) {
    const count = document.createElement("span");
    count.className = "synced-count";
    count.textContent = syncInfo.syncEnabled ? String(syncInfo.totalCount) + " entries" : "Syncing paused";
    header.append(count);
  }

  section.append(header);

  const maxShow = Math.min(5, syncedHistory.length);
  for (let i = 0; i < maxShow; i++) {
    const entry = syncedHistory[i];
    const item = document.createElement("div");
    item.className = "synced-item";

    const entryTitle = document.createElement("div");
    entryTitle.className = "synced-item-title";
    entryTitle.textContent = entry.title || "Unknown";
    entryTitle.title = entry.url || "";
    item.append(entryTitle);

    const meta = document.createElement("div");
    meta.className = "synced-item-meta";

    if (entry.format) {
      const formatBadge = document.createElement("span");
      formatBadge.className = "badge";
      formatBadge.textContent = entry.format;
      meta.append(formatBadge);
    }

    const statusBadge = document.createElement("span");
    statusBadge.className = "badge " + (entry.status === "error" ? "warning" : "");
    statusBadge.textContent = (entry.status || "").toUpperCase();
    meta.append(statusBadge);

    if (entry.sourceHost) {
      const source = document.createElement("span");
      source.className = "synced-source";
      source.textContent = entry.sourceHost;
      meta.append(source);
    }

    if (entry.completedAt) {
      const time = document.createElement("span");
      time.className = "synced-time";
      time.textContent = new Date(entry.completedAt).toLocaleDateString();
      meta.append(time);
    }

    if (entry.totalSize) {
      const size = document.createElement("span");
      size.className = "synced-size";
      size.textContent = entry.totalSize;
      meta.append(size);
    }

    item.append(meta);
    section.append(item);
  }

  if (syncedHistory.length > maxShow) {
    const more = document.createElement("div");
    more.className = "synced-more";
    more.textContent = "+ " + String(syncedHistory.length - maxShow) + " more";
    section.append(more);
  }

  elements.downloadList.parentNode.insertBefore(section, elements.downloadList.nextSibling);
}
