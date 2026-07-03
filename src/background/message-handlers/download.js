"use strict";

/**
 * Download control message handlers.
 */

export function registerDownloadHandlers(messageRouter, ctx) {
  const {
    senderTabId, getTabVideos, getVisibleVideosForTab, addDetectedVideo,
    chooseDownloadFolder, tabState, nativeRequest, browserApi, HOST_NAME,
  } = ctx;

  const { detectFormat } = ctx.videoUtils;
  const { variantsForVideo, findGroupedVideoForVariant } = ctx.downloadHelpers;
  const { getNativeFormatsForVideo } = ctx.formatHelpers;
  const { startNativeDownload, startNativeDownloadForUrl, getBestDownloadableVideo,
    startBestNativeDownload, controlActiveDownload, resumeDownload, cancelDownload,
    retryDownload, openDownloadedPath, removeDownload, clearDownloads } = ctx;

  // ── Folder picker helper ───────────────────────────────────────────────

  function chooseFolderHandler() {
    return chooseDownloadFolder().then((result) => ({ ok: true, ...result }));
  }

  // ── Download video ─────────────────────────────────────────────────────

  messageRouter.handle("downloadVideo", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      ...(await startNativeDownload(
        tabId,
        message.videoId,
        message.formatId || "best",
        message.variantId || "",
        message.backend || "auto",
      )),
    };
  });

  // ── Download control ───────────────────────────────────────────────────

  messageRouter.handle("pauseDownload", async (message) => {
    return { ok: true, ...controlActiveDownload(message.jobId, "pause") };
  });

  messageRouter.handle("resumeDownload", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return { ok: true, ...(await resumeDownload(tabId, message.jobId)) };
  });

  messageRouter.handle("cancelDownload", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return { ok: true, ...(await cancelDownload(tabId, message.jobId)) };
  });

  messageRouter.handle("retryDownload", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return { ok: true, ...(await retryDownload(tabId, message.jobId)) };
  });

  messageRouter.handle("openDownloadedFile", async (message) => {
    return { ok: true, ...(await openDownloadedPath(message.jobId, "openFile")) };
  });

  messageRouter.handle("showDownloadedFile", async (message) => {
    return { ok: true, ...(await openDownloadedPath(message.jobId, "showFile")) };
  });

  messageRouter.handle("removeDownload", async (message) => {
    return { ok: true, ...(await removeDownload(message.jobId)) };
  });

  messageRouter.handle("clearDownloads", async () => {
    return { ok: true, ...(await clearDownloads()) };
  });

  // ── Get video formats ──────────────────────────────────────────────────

  messageRouter.handle("getVideoFormats", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const videos = await getTabVideos(tabId);
    const video = videos.find(
      (item) => item.id === message.videoId || variantsForVideo(item).some((variant) => variant.id === message.videoId),
    );
    if (!video) {
      throw new Error("That video URL is no longer in the detected list.");
    }
    return {
      ok: true,
      ...(await getNativeFormatsForVideo(tabId, video, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
    };
  });

  // ── Download URL ───────────────────────────────────────────────────────

  messageRouter.handle("downloadUrl", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      ...(await startNativeDownloadForUrl(tabId, {
        ...(message.video || {}),
        pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
        frameUrl: sender.url || "",
        formatId: message.formatId || "best",
        variantId: message.variantId || "",
      })),
    };
  });

  // ── Download best video ──────────────────────────────────────────────

  messageRouter.handle("downloadBestVideo", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
    };
  });

  // ── Get formats for URL ──────────────────────────────────────────────

  messageRouter.handle("getFormatsForUrl", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const video = await addDetectedVideo(tabId, {
      ...(message.video || {}),
      pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
      frameUrl: sender.url || "",
      source: (message.video && message.video.source) || "overlay",
    });
    if (!video) {
      throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
    }
    const groupedVideo = findGroupedVideoForVariant(tabId, video, getVisibleVideosForTab) || video;
    return {
      ok: true,
      videoId: groupedVideo.id,
      ...(await getNativeFormatsForVideo(tabId, groupedVideo, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
    };
  });

  // ── Get best video formats ────────────────────────────────────────────

  messageRouter.handle("getBestVideoFormats", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const video = await getBestDownloadableVideo(tabId);
    return {
      ok: true,
      videoId: video.id,
      ...(await getNativeFormatsForVideo(tabId, video, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
    };
  });

  // ── Folder picker (multiple aliases) ──────────────────────────────────

  messageRouter.handle("chooseDownloadFolder", chooseFolderHandler);
  messageRouter.handle("chooseFolder", chooseFolderHandler);
  messageRouter.handle("selectDownloadFolder", chooseFolderHandler);
  messageRouter.handle("browseDownloadFolder", chooseFolderHandler);

  // ── Magnet download ─────────────────────────────────────────────────────

  messageRouter.handle("downloadMagnet", async (message) => {
    return ctx.recording.downloadMagnet(message, notifyPopup, nativeRequest, () => {
      return browserApi.runtime.connectNative(HOST_NAME);
    });
  });

  // ── Torrent handlers ───────────────────────────────────────────────────

  messageRouter.handle("chooseTorrentFile", async () => {
    const requestId = `torrentfile_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const response = await nativeRequest(
      {
        type: "chooseTorrentFile",
        id: requestId,
        initialFolder: tabState.getSettings().downloadFolder || "",
      },
      600000,
    );

    const selectedPath = String(response.path || "").trim();
    if (response.canceled || !selectedPath) {
      return { ok: true, canceled: true };
    }
    return { ok: true, path: selectedPath };
  });

  messageRouter.handle("downloadTorrent", async (message) => {
    return ctx.recording.downloadTorrent(message, () => {
      return browserApi.runtime.connectNative(HOST_NAME);
    });
  });

  // ── Download queue handlers ────────────────────────────────────────────

  messageRouter.handle("getQueueStatus", async () => {
    return { ok: true, status: ctx.downloadQueue.getStatus() };
  });

  messageRouter.handle("setAutoDownload", async (message) => {
    ctx.downloadQueue.setAutoDownload(Boolean(message.enabled));
    await tabState.updateSettings({ autoDownload: Boolean(message.enabled) });
    return { ok: true, autoDownload: ctx.downloadQueue.getAutoDownload() };
  });

  messageRouter.handle("setMaxConcurrentDownloads", async (message) => {
    const limit = Number(message.limit) || 3;
    ctx.downloadQueue.setMaxConcurrent(limit);
    await tabState.updateSettings({ maxConcurrentDownloads: limit });
    return { ok: true, maxConcurrent: ctx.downloadQueue.getMaxConcurrent() };
  });

  messageRouter.handle("downloadAllVideos", async (message, sender) => {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      return { ok: false, error: "No tab ID provided." };
    }
    const videos = await getTabVideos(tabId);
    const downloadable = videos.filter((v) => v.downloadable);
    if (!downloadable.length) {
      return { ok: false, error: "No downloadable videos found." };
    }
    for (const video of downloadable) {
      ctx.downloadQueue.enqueue(tabId, video.id, {
        formatId: "best",
        variantId: "",
        backend: "auto",
      });
    }
    return { ok: true, queued: downloadable.length };
  });

  // ── Download history sync ──────────────────────────────────────────────

  messageRouter.handle("getDownloadSyncHistory", async () => {
    const history = ctx.downloadSync.getSyncedHistory();
    const syncInfo = ctx.downloadSync.getSyncInfo();
    return { ok: true, history, syncInfo };
  });

  messageRouter.handle("setDownloadSyncEnabled", async (message) => {
    const enabled = message.enabled !== false;
    ctx.downloadSync.setSyncEnabled(enabled);
    const currentSettings = tabState.getSettings();
    await tabState.setSettings(Object.assign({}, currentSettings, { downloadSyncEnabled: enabled }));
    return { ok: true, enabled };
  });

  messageRouter.handle("clearDownloadSyncHistory", async () => {
    ctx.downloadSync.clearSyncedHistory();
    await tabState.persistSyncHistoryToStorage();
    return { ok: true };
  });
}
