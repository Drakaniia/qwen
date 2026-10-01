"use strict";

/**
 * Download control message handlers.
 */

export function registerDownloadHandlers(messageRouter, ctx) {
  const {
    senderTabId,
    getTabVideos,
    getVisibleVideosForTab,
    addDetectedVideo,
    chooseDownloadFolder,
    tabState,
    nativeRequest,
    notifyPopup,
  } = ctx;
  const { variantsForVideo, findGroupedVideoForVariant } = ctx.downloadHelpers;
  const { getNativeFormatsForVideo } = ctx.formatHelpers;
  const {
    startNativeDownload,
    startNativeDownloadForUrl,
    getBestDownloadableVideo,
    startBestNativeDownload,
    controlActiveDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    openDownloadedPath,
    removeDownload,
    clearDownloads,
  } = ctx;

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
      ...(await getNativeFormatsForVideo(
        tabId,
        video,
        getVisibleVideosForTab,
        notifyPopup,
        nativeRequest,
        addDetectedVideo,
      )),
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
      ...(await getNativeFormatsForVideo(
        tabId,
        groupedVideo,
        getVisibleVideosForTab,
        notifyPopup,
        nativeRequest,
        addDetectedVideo,
      )),
    };
  });

  // ── Get best video formats ────────────────────────────────────────────

  messageRouter.handle("getBestVideoFormats", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const video = await getBestDownloadableVideo(tabId);
    return {
      ok: true,
      videoId: video.id,
      ...(await getNativeFormatsForVideo(
        tabId,
        video,
        getVisibleVideosForTab,
        notifyPopup,
        nativeRequest,
        addDetectedVideo,
      )),
    };
  });

  // ── Folder picker ──────────────────────────────────────────────────────

  messageRouter.handle("chooseDownloadFolder", chooseFolderHandler);

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
