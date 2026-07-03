"use strict";

/**
 * Tab/content video message handlers.
 */

export function registerTabHandlers(messageRouter, ctx) {
  const {
    senderTabId,
    notifyPopup,
    getVisibleVideosForTab,
    addDetectedVideo,
    clearTab,
    getTabVideos,
    getTabDownloads,
    setPageTitle,
    tabState,
    browserApi,
  } = ctx;

  // ── MSE captured segments ───────────────────────────────────────────────

  messageRouter.handle("mseCapturedSegments", async (message, sender) => {
    const { recording, segmentCapture } = ctx;
    const result = recording.handleMseCapturedSegments(message, sender, senderTabId);
    if (result) {
      notifyPopup({
        type: "mseCaptureComplete",
        tabId: result.tabId,
        totalSegments: result.totalSegments,
        streams: result.streams,
      });
    }

    const tabId = senderTabId(message, sender);
    if (tabId && Array.isArray(message.segments) && message.segments.length > 0) {
      const captureStatus = segmentCapture.getStatus(tabId);
      if (captureStatus.active) {
        segmentCapture.addSegments(tabId, message.segments);
      }
    }
    return { ok: true };
  });

  // ── Content detected videos ────────────────────────────────────────────

  messageRouter.handle("contentDetectedVideos", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const videos = Array.isArray(message.videos) ? message.videos : [];

    if (sender?.tab?.title) {
      setPageTitle(tabId, sender.tab.title);
    }

    await tabState.load();
    let changed = false;

    for (const video of videos) {
      const added = await addDetectedVideo(
        tabId,
        {
          ...video,
          source: video.source || "dom",
          pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
          frameUrl: video.frameUrl || sender.url || "",
        },
        false,
      );
      if (added) changed = true;
    }

    if (changed) {
      notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    }
    return { ok: true };
  });

  // ── Get videos ─────────────────────────────────────────────────────────

  messageRouter.handle("getVideos", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      videos: await getTabVideos(tabId),
      downloads: await getTabDownloads(tabId),
      settings: tabState.getSettings(),
    };
  });

  // ── Rescan tab ─────────────────────────────────────────────────────────

  messageRouter.handle("rescanTab", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    await clearTab(tabId);

    const contentResponse = await browserApi.tabs.sendMessage(tabId, { type: "scanNow" });

    if (contentResponse && contentResponse.ok && Array.isArray(contentResponse.videos)) {
      for (const video of contentResponse.videos) {
        await addDetectedVideo(
          tabId,
          {
            ...video,
            source: video.source || "dom",
            pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
            frameUrl: video.frameUrl || sender.url || "",
          },
          false,
        );
      }
      notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    }

    await browserApi.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.dispatchEvent(new CustomEvent("qwin-video-scan-now")),
    });
    return { ok: true };
  });

  // ── Clear tab ──────────────────────────────────────────────────────────

  messageRouter.handle("clearVideos", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    await clearTab(tabId);
    return { ok: true };
  });
}
