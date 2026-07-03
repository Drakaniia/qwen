"use strict";

/**
 * Batch/playlist download message handlers.
 */

export function registerBatchHandlers(messageRouter, ctx) {
  const { batchOrchestration } = ctx;

  // ── Playlist enumeration ───────────────────────────────────────────────

  messageRouter.handle("enumeratePlaylist", async (message, sender) => {
    const url = String(message.url || "").trim();
    if (!url) {
      return { ok: false, error: "No URL provided for playlist enumeration." };
    }
    const pageUrl = message.pageUrl || (sender.tab && sender.tab.url) || url;
    return batchOrchestration.enumeratePlaylist(url, { pageUrl });
  });

  // ── Batch download ─────────────────────────────────────────────────────

  messageRouter.handle("batchDownload", async (message, sender) => {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const videos = Array.isArray(message.videos) ? message.videos : [];
    if (!tabId) {
      return { ok: false, error: "No tab ID provided for batch download." };
    }
    return batchOrchestration.startBatchDownload(tabId, videos);
  });

  messageRouter.handle("batchDownloadSelected", async (message, sender) => {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const videoIds = Array.isArray(message.videoIds) ? message.videoIds : [];
    if (!tabId) {
      return { ok: false, error: "No tab ID provided." };
    }
    if (!videoIds.length) {
      return { ok: false, error: "No videos selected for batch download." };
    }
    return batchOrchestration.startSelectedDownload(tabId, videoIds);
  });

  messageRouter.handle("batchStatus", async () => {
    return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
  });

  messageRouter.handle("batchPause", async () => {
    batchOrchestration.pauseBatch();
    return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
  });

  messageRouter.handle("batchResume", async () => {
    batchOrchestration.resumeBatch();
    return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
  });

  messageRouter.handle("batchCancel", async () => {
    batchOrchestration.cancelBatch();
    return { ok: true, batchInfo: batchOrchestration.getBatchInfo() };
  });
}
