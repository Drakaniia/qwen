"use strict";

/**
 * CDP and deep inspection message handlers.
 */

export function registerCdpHandlers(messageRouter, ctx) {
  const { cdpRelay, cdpExtraction, isExtensionPageSender, addDetectedVideo,
    notifyPopup, getVisibleVideosForTab } = ctx;
  const { detectFormat } = ctx.videoUtils;

  // ── CDP relay handlers ────────────────────────────────────────────────

  messageRouter.handle("cdpCommand", async (message) => {
    return cdpRelay.handleCdpCommand(message);
  });

  messageRouter.handle("cdpAttach", async (message) => {
    return cdpRelay.handleCdpAttach(message);
  });

  messageRouter.handle("cdpDetach", async (message) => {
    return cdpRelay.handleCdpDetach(message);
  });

  messageRouter.handle("cdpStatus", async () => {
    return cdpRelay.handleCdpStatus();
  });

  // ── Deep Network Inspection handlers ────────────────────────────────────

  messageRouter.handle("enableDeepInspection", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only extension pages may enable deep inspection." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    return cdpRelay.enableDeepNetworkInspection(tabId);
  });

  messageRouter.handle("disableDeepInspection", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only extension pages may disable deep inspection." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    return cdpRelay.disableDeepNetworkInspection(tabId);
  });

  messageRouter.handle("isDeepInspectionActive", async (message) => {
    const tabId = Number(message.tabId) || 0;
    return { ok: true, active: cdpRelay.isDeepInspectionActive(tabId) };
  });

  // ── CDP extraction handler ────────────────────────────────────────────

  messageRouter.handle("cdpExtractVideos", async (message, sender) => {
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, videos: [], error: "No tabId provided for CDP extraction." };
    }

    const extractionResult = await cdpExtraction.extractVideosFromTab(tabId, {
      timeout: message.timeout || 15000,
    });

    const pageUrl = message.pageUrl || sender?.tab?.url || "";
    let integratedCount = 0;

    if (extractionResult.ok && Array.isArray(extractionResult.videos)) {
      for (const video of extractionResult.videos) {
        if (!video.url) continue;
        if (video.url.startsWith("blob:") || video.url.startsWith("data:")) continue;

        const added = await addDetectedVideo(
          tabId,
          {
            url: video.url,
            format: detectFormat(video.url, video.type || ""),
            source: "cdp-" + (video.source || "extraction"),
            pageUrl: pageUrl,
            contentType: video.type || "",
            width: Number(video.width) || 0,
            height: Number(video.height) || 0,
            duration: Number(video.duration) || 0,
          },
          false,
        );
        if (added) integratedCount++;
      }
    }

    return {
      ok: true,
      videos: extractionResult.videos || [],
      tabVideos: getVisibleVideosForTab(tabId),
      integrated: integratedCount,
      error: extractionResult.error || "",
    };
  });
}
