"use strict";

/**
 * Register all message handlers on the message router.
 *
 * @param {import("./message_router.js").MessageRouter} messageRouter
 * @param {Object} ctx - Context object with all required dependencies from background.js
 */
export function registerMessageHandlers(messageRouter, ctx) {
  const {
    // Core helpers
    senderTabId,
    notifyPopup,
    getVisibleVideosForTab,
    addDetectedVideo,
    clearTab,
    getTabVideos,
    getTabDownloads,
    isExtensionPageSender,

    // Page title management (shared mutable state from background.js)
    setPageTitle,

    // Download orchestration
    nativeRequest,
    startNativeDownload,
    startNativeDownloadForUrl,
    getBestDownloadableVideo,
    startBestNativeDownload,
    controlActiveDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    openDownloadedPath,
    chooseDownloadFolder,
    removeDownload,
    clearDownloads,
    downloadOrchestrationDeps,

    // Imported modules
    downloadQueue,
    batchOrchestration,
    cdpRelay,
    cdpExtraction,
    cdmNetworkIntercept,
    segmentCapture,
    recording,
    downloadSync,
    tabState,
    browserApi,
    videoUtils,
    downloadHelpers,
    formatHelpers,
    backgroundHelperPing,

    // Background helper ping exports
    cachedHelperStatus,
    HELPER_PING_INTERVAL_MS,
    refreshCachedHelperStatus,
    pingNativeHost,

    // Shared constants
    HOST_NAME,
    videoFilters,
    normalizeUrl,
    nativeRequestHeadersForVideo,
  } = ctx;

  const { detectFormat, isPlaylistVideo, isDownloadableUrl } = videoUtils;
  const { updateDownload, variantsForVideo, findGroupedVideoForVariant, findVariant } = downloadHelpers;
  const { detectedVariantOption, normalizeNativeFormatOption, getNativeFormatsForVideo } = formatHelpers;

  // ── Folder picker handler (used by multiple aliases) ──────────────────

  function chooseFolderHandler() {
    return chooseDownloadFolder().then((result) => ({ ok: true, ...result }));
  }

  // ── Message handler: MSE captured segments ───────────────────────────

  messageRouter.handle("mseCapturedSegments", async (message, sender) => {
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

  // ── Message handler: content detected videos ─────────────────────────

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
      if (added) {
        changed = true;
      }
    }

    if (changed) {
      notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
    }
    return { ok: true };
  });

  // ── Message handler: get videos ─────────────────────────────────────

  messageRouter.handle("getVideos", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      videos: await getTabVideos(tabId),
      downloads: await getTabDownloads(tabId),
      settings: tabState.getSettings(),
    };
  });

  // ── Message handler: download video ─────────────────────────────────

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

  // ── Message handlers: download control ──────────────────────────────

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

  // ── Message handler: get video formats ─────────────────────────────

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

  // ── Message handler: download URL ─────────────────────────────────

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

  // ── Message handler: download best video ──────────────────────────

  messageRouter.handle("downloadBestVideo", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    return {
      ok: true,
      ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
    };
  });

  // ── Message handler: get formats for URL ──────────────────────────

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

  // ── Message handler: get best video formats ───────────────────────

  messageRouter.handle("getBestVideoFormats", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    const video = await getBestDownloadableVideo(tabId);
    return {
      ok: true,
      videoId: video.id,
      ...(await getNativeFormatsForVideo(tabId, video, getVisibleVideosForTab, notifyPopup, nativeRequest, addDetectedVideo)),
    };
  });

  // ── Message handler: save/get settings ───────────────────────────

  messageRouter.handle("saveSettings", async (message) => {
    await tabState.updateSettings(message.settings || {});
    return { ok: true, settings: tabState.getSettings() };
  });

  messageRouter.handle("getSettings", async () => {
    return { ok: true, settings: tabState.getSettings() };
  });

  // ── Folder picker (multiple aliases) ──────────────────────────────

  messageRouter.handle("chooseDownloadFolder", chooseFolderHandler);
  messageRouter.handle("chooseFolder", chooseFolderHandler);
  messageRouter.handle("selectDownloadFolder", chooseFolderHandler);
  messageRouter.handle("browseDownloadFolder", chooseFolderHandler);

  // ── Open popup ─────────────────────────────────────────────────

  messageRouter.handle("openPopup", async () => {
    await browserApi.action.openPopup();
    return { ok: true };
  });

  // ── Magnet download ─────────────────────────────────────────────

  messageRouter.handle("downloadMagnet", async (message) => {
    return recording.downloadMagnet(message, notifyPopup, nativeRequest, () => {
      return browserApi.runtime.connectNative(HOST_NAME);
    });
  });

  // ── Recording handlers ────────────────────────────────────────────

  messageRouter.handle("startRecording", async (message) => {
    const tabId = Number(message.tabId) || 0;
    const options = message.options || {};
    const jobId = options.jobId || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    if (!tabId) {
      return { ok: false, error: "No tab ID provided for recording." };
    }

    const recordingJob = {
      id: jobId,
      tabId,
      title: options.title || "Screen recording",
      format: "RECORDING",
      status: "connecting",
      message: "Starting screen recording...",
      url: options.url || "",
      videoId: jobId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: "recording",
      isRecording: true,
      recordingDuration: 0,
      recordingSizeBytes: 0,
      recordingFps: 0,
      recordingDroppedFrames: 0,
      percent: null,
    };

    tabState.updateDownload(jobId, recordingJob);

    try {
      const nativeResponse = await nativeRequest(
        {
          type: "startRecording",
          id: `rec_start_${Date.now()}`,
          tabId,
          jobId,
          outputPath: "",
          quality: "best",
        },
        15000,
      );

      if (nativeResponse && nativeResponse.ok) {
        recording.addActiveRecording(jobId, tabId, nativeResponse.filepath || "");
        tabState.updateDownload(jobId, {
          status: "running",
          message: nativeResponse.message || "Recording started.",
          filepath: nativeResponse.filepath || "",
        });
        return { ok: true, jobId };
      }

      recording.addActiveRecording(jobId, tabId, "");
      tabState.updateDownload(jobId, {
        status: "running",
        message: "Recording... (native capture not yet available, placeholder mode)",
      });
      return { ok: true, jobId };
    } catch (error) {
      tabState.updateDownload(jobId, {
        status: "running",
        message: "Recording... (native capture not yet available, placeholder mode)",
      });
      return { ok: true, jobId };
    }
  });

  messageRouter.handle("stopRecording", async (message) => {
    const jobId = message.jobId;
    const rec = recording.removeActiveRecording(jobId);

    if (!rec) {
      return { ok: false, error: "Recording job not found." };
    }

    try {
      await nativeRequest(
        {
          type: "stopRecording",
          id: `rec_stop_${Date.now()}`,
          jobId,
        },
        10000,
      );
    } catch (_error) {}

    const durationSec = Math.round((Date.now() - rec.startTime) / 1000);
    const durationStr = recording.formatDuration(durationSec);

    tabState.updateDownload(jobId, {
      status: "done",
      stage: "done",
      isRecording: false,
      recordingDuration: durationSec,
      message: `Recording complete. Duration: ${durationStr}.`,
      percent: 100,
    });

    return { ok: true, jobId };
  });

  messageRouter.handle("getRecordingStatus", async () => {
    const jobs = recording.getActiveRecordings().map((rec) => ({
      jobId: rec.jobId,
      tabId: rec.tabId,
      elapsedSec: rec.elapsedSec,
      elapsedFormatted: rec.elapsedFormatted,
    }));
    return { ok: true, activeRecordings: jobs };
  });

  // ── CDP relay handlers ───────────────────────────────────────────

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

  // ── Deep Network Inspection handlers ─────────────────────────────

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

  // ── CDP extraction handler ───────────────────────────────────────

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

  // ── CDM capture handlers (sender-restricted) ─────────────────────

  messageRouter.handle("startCdmCapture", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may start CDM capture." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided for CDM capture." };
    }
    return cdmNetworkIntercept.initIntercept(tabId);
  });

  messageRouter.handle("stopCdmCapture", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may stop CDM capture." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    const exchanges = cdmNetworkIntercept.getCapturedExchanges();
    const result = await cdmNetworkIntercept.stopIntercept(tabId);
    if (result.ok) {
      cdmNetworkIntercept.clearCapturedExchanges();
    }
    return { ok: result.ok, exchanges, error: result.error };
  });

  messageRouter.handle("getCdmCaptures", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may access CDM captures." };
    }
    return {
      ok: true,
      exchanges: cdmNetworkIntercept.getCapturedExchanges(),
      status: cdmNetworkIntercept.getStatus(),
    };
  });

  messageRouter.handle("cdmStatus", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized." };
    }
    return { ok: true, status: cdmNetworkIntercept.getStatus() };
  });

  // ── CDM key extraction pipeline (sender-restricted) ────────────────

  messageRouter.handle("cdmInit", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may initialize CDM." };
    }
    const cdmPath = message.cdmPath || "";
    if (!cdmPath) {
      return { ok: false, error: "cdmPath is required." };
    }
    try {
      const response = await nativeRequest({ type: "cdmInit", id: `cdm_init_${Date.now()}`, cdmPath }, 30000);
      return {
        ok: response?.ok !== false,
        cdmVersion: response?.cdmVersion || "",
        l1Only: Boolean(response?.l1Only),
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `CDM init failed: ${error.message || error}` };
    }
  });

  messageRouter.handle("extractCdmKeys", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may extract CDM keys." };
    }
    const exchange = message.exchange;
    if (!exchange || !exchange.responseBody) {
      return { ok: false, error: "A completed license exchange with responseBody is required." };
    }

    const sessionId = `${exchange.tabId || 0}_${exchange.requestId || Date.now()}`;

    try {
      const response = await nativeRequest(
        {
          type: "extractKeys",
          id: `extract_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          sessionId,
          responseB64: exchange.responseBody,
          challengeB64: exchange.postData || "",
          initDataB64: "",
        },
        60000,
      );

      return {
        ok: response?.ok !== false,
        sessionId: response?.sessionId || sessionId,
        keys: response?.keys || [],
        l1Only: Boolean(response?.l1Only),
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `Key extraction failed: ${error.message || error}` };
    }
  });

  messageRouter.handle("decryptCdmSegments", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may decrypt segments." };
    }
    if (!message.jobId) {
      return { ok: false, error: "jobId is required." };
    }
    if (!Array.isArray(message.segments) || !message.segments.length) {
      return { ok: false, error: "At least one encrypted segment is required." };
    }
    if (!Array.isArray(message.keys) || !message.keys.length) {
      return { ok: false, error: "At least one decryption key is required." };
    }

    try {
      const response = await nativeRequest(
        {
          type: "decryptSegments",
          id: `decrypt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          jobId: message.jobId,
          segments: message.segments,
          keys: message.keys,
          outputDir: message.outputDir || "",
        },
        120000,
      );

      return {
        ok: response?.ok !== false,
        jobId: response?.jobId || message.jobId,
        decrypted: response?.decrypted || 0,
        segmentPaths: response?.segmentPaths || [],
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `Segment decryption failed: ${error.message || error}` };
    }
  });

  messageRouter.handle("assembleDecryptedSegments", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may assemble segments." };
    }
    if (!message.jobId) {
      return { ok: false, error: "jobId is required." };
    }
    if (!Array.isArray(message.filePaths) || !message.filePaths.length) {
      return { ok: false, error: "At least one segment file path is required." };
    }

    try {
      const response = await nativeRequest(
        {
          type: "assembleSegments",
          id: `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          jobId: message.jobId,
          filePaths: message.filePaths,
          outputPath: message.outputPath || "",
        },
        120000,
      );

      return {
        ok: response?.ok !== false,
        jobId: response?.jobId || message.jobId,
        filePath: response?.filePath || "",
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `Segment assembly failed: ${error.message || error}` };
    }
  });

  // ── Segment capture handlers ──────────────────────────────────────

  messageRouter.handle("startSegmentCapture", async (message) => {
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided for segment capture." };
    }
    return segmentCapture.startCapture(tabId, {
      title: message.title || "Video",
      url: message.url || "",
    });
  });

  messageRouter.handle("stopSegmentCapture", async (message) => {
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    return segmentCapture.stopCapture(tabId);
  });

  messageRouter.handle("getSegmentCaptureStatus", async (message) => {
    const tabId = Number(message.tabId) || 0;
    return { ok: true, status: segmentCapture.getStatus(tabId) };
  });

  messageRouter.handle("assembleSegments", async (message) => {
    const segments = Array.isArray(message.segments) ? message.segments : [];
    if (!segments.length) {
      return { ok: true, jobId: message.jobId || "", warning: "No segments to assemble." };
    }

    const requestId = `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const response = await nativeRequest(
        {
          type: "assembleSegments",
          id: requestId,
          tabId: message.tabId || 0,
          jobId: message.jobId || "",
          title: message.title || "Video",
          url: message.url || "",
          streams: message.streams || {},
          segments: segments.map((s) => ({
            streamId: s.streamId || "unknown",
            mimeType: s.mimeType || "",
            data: s.data || "",
            index: typeof s.index === "number" ? s.index : 0,
            timestamp: typeof s.timestamp === "number" ? s.timestamp : 0,
            isLast: Boolean(s.isLast),
          })),
        },
        120000,
      );
      return {
        ok: response && response.ok !== false,
        jobId: message.jobId || "",
        filepath: response?.filepath || "",
        error: response?.error || "",
      };
    } catch (error) {
      return {
        ok: false,
        jobId: message.jobId || "",
        error: `Native host assembly failed: ${error.message || error}`,
      };
    }
  });

  // ── Batch/playlist handlers ──────────────────────────────────────

  messageRouter.handle("enumeratePlaylist", async (message, sender) => {
    const url = String(message.url || "").trim();
    if (!url) {
      return { ok: false, error: "No URL provided for playlist enumeration." };
    }
    const pageUrl = message.pageUrl || (sender.tab && sender.tab.url) || url;
    return batchOrchestration.enumeratePlaylist(url, { pageUrl });
  });

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

  // ── Torrent handlers ─────────────────────────────────────────────

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
    return recording.downloadTorrent(message, () => {
      return browserApi.runtime.connectNative(HOST_NAME);
    });
  });

  // ── Download history sync handlers ────────────────────────────────

  messageRouter.handle("getDownloadSyncHistory", async () => {
    const history = downloadSync.getSyncedHistory();
    const syncInfo = downloadSync.getSyncInfo();
    return { ok: true, history, syncInfo };
  });

  messageRouter.handle("setDownloadSyncEnabled", async (message) => {
    const enabled = message.enabled !== false;
    downloadSync.setSyncEnabled(enabled);
    const currentSettings = tabState.getSettings();
    await tabState.setSettings(Object.assign({}, currentSettings, { downloadSyncEnabled: enabled }));
    return { ok: true, enabled };
  });

  messageRouter.handle("clearDownloadSyncHistory", async () => {
    downloadSync.clearSyncedHistory();
    await tabState.persistSyncHistoryToStorage();
    return { ok: true };
  });

  // ── Download queue handlers ──────────────────────────────────────

  messageRouter.handle("getQueueStatus", async () => {
    return { ok: true, status: downloadQueue.getStatus() };
  });

  messageRouter.handle("setAutoDownload", async (message) => {
    downloadQueue.setAutoDownload(Boolean(message.enabled));
    await tabState.updateSettings({ autoDownload: Boolean(message.enabled) });
    return { ok: true, autoDownload: downloadQueue.getAutoDownload() };
  });

  messageRouter.handle("setMaxConcurrentDownloads", async (message) => {
    const limit = Number(message.limit) || 3;
    downloadQueue.setMaxConcurrent(limit);
    await tabState.updateSettings({ maxConcurrentDownloads: limit });
    return { ok: true, maxConcurrent: downloadQueue.getMaxConcurrent() };
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
      downloadQueue.enqueue(tabId, video.id, {
        formatId: "best",
        variantId: "",
        backend: "auto",
      });
    }
    return { ok: true, queued: downloadable.length };
  });

  // ── Helper status ────────────────────────────────────────────────

  messageRouter.handle("pingNativeHost", async () => {
    return pingNativeHost();
  });

  messageRouter.handle("getHelperStatus", async () => {
    const age = Date.now() - cachedHelperStatus.lastChecked;
    if (age > HELPER_PING_INTERVAL_MS || !cachedHelperStatus.lastChecked) {
      await refreshCachedHelperStatus(notifyPopup, HOST_NAME);
    }

    return {
      ok: true,
      connected: cachedHelperStatus.connected,
      version: cachedHelperStatus.version,
      dependencies: { ...cachedHelperStatus.dependencies },
      lastChecked: cachedHelperStatus.lastChecked,
      error: cachedHelperStatus.error || "",
    };
  });

  // ── Rescan / clear tab ───────────────────────────────────────────

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

  messageRouter.handle("clearVideos", async (message, sender) => {
    const tabId = senderTabId(message, sender);
    await clearTab(tabId);
    return { ok: true };
  });
}
