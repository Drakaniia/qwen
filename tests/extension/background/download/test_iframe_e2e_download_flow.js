"use strict";

/**
 * End-to-End Test: Iframe Download Flow
 *
 * Tests the full pipeline from iframe video detection through to yt-dlp download:
 *
 *  1. Parent page detects iframe → creates iframe-page / PAGE candidate
 *  2. Content script inside iframe detects HLS video → creates dom-video / M3U8 candidate
 *  3. Background processes both, groups them, and broadcasts popup notifications
 *  4. Popup retrieves videos via getVideos (formats include yt-dlp source)
 *  5. Download starts via native messaging (yt-dlp sends HLS URL to native host)
 *  6. When iframe-page PAGE fails, fallback discovers the iframe-detected video
 *
 * Scenario:
 *  - Parent page: https://pinaypie.com/watch/episode-10
 *  - Iframe src: https://playmogo.com/e/k2c18kmf5fea
 *  - Iframe-detected HLS: https://cdn.playmogo.com/hls/master.m3u8?token=abc123
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const backgroundBundle = fs.readFileSync(path.join(__dirname, "../../../dist/test/background.bundle.js"), "utf8");

const TAB_ID = 42;
const PAGE_URL = "https://pinaypie.com/watch/episode-10";
const IFRAME_URL = "https://playmogo.com/e/k2c18kmf5fea";
const HLS_URL = "https://cdn.playmogo.com/hls/master.m3u8?token=abc123";
const PAGE_TITLE = "Watch Episode 10 Online - PinayPie";
const IFRAME_TITLE = "Video Player | playmogo";

// ─── Helpers ───────────────────────────────────────────────────────────────

function createEvent() {
  return {
    listeners: [],
    addListener(listener) {
      this.listeners.push(listener);
    },
  };
}

/**
 * Create a test harness around the bundled background script.
 *
 * @param {Function|null} nativeHandler - Called with (message, { port, emit, disconnect })
 *   for each native message. Use port.postMessage for outgoing; emit() for incoming responses.
 * @param {Object} initialStorageState - Pre-seeded chrome.storage.local state
 */
function createBackgroundHarness(nativeHandler, initialStorageState = {}) {
  let runtimeListener = null;
  const storageState = { ...initialStorageState };
  const nativePorts = [];
  const runtimeMessages = [];

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        },
      },
      sendMessage(message) {
        runtimeMessages.push(message);
      },
      connectNative(name) {
        const messageListeners = [];
        const disconnectListeners = [];
        const port = {
          name,
          postedMessages: [],
          disconnected: false,
          onMessage: {
            addListener(listener) {
              messageListeners.push(listener);
            },
          },
          onDisconnect: {
            addListener(listener) {
              disconnectListeners.push(listener);
            },
          },
          postMessage(message) {
            this.postedMessages.push(message);
            if (nativeHandler) {
              nativeHandler(message, {
                port,
                emit(response) {
                  for (const listener of messageListeners) {
                    listener(response);
                  }
                },
                disconnect() {
                  for (const listener of disconnectListeners) {
                    listener();
                  }
                },
              });
            }
          },
          disconnect() {
            this.disconnected = true;
          },
        };
        nativePorts.push(port);
        return port;
      },
    },
    storage: {
      local: {
        get(keys, callback) {
          const result = {};
          for (const key of Array.isArray(keys) ? keys : Object.keys(storageState)) {
            result[key] = storageState[key];
          }
          callback(result);
        },
        set(items, callback) {
          Object.assign(storageState, items);
          if (callback) callback();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageState[key];
          }
          if (callback) callback();
        },
      },
      sync: {
        get(_keys, callback) {
          callback({});
        },
        set(_items, callback) {
          if (callback) callback();
        },
      },
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: TAB_ID, url: PAGE_URL, title: PAGE_TITLE }]);
      },
      sendMessage(_tabId, _message, callback) {
        if (callback) callback(null);
      },
      onRemoved: createEvent(),
      onUpdated: createEvent(),
    },
    scripting: {
      executeScript(_details, callback) {
        if (callback) callback([]);
      },
    },
    cookies: {
      getAll(_details, callback) {
        callback([]);
      },
    },
    webRequest: {
      onBeforeRequest: createEvent(),
      onBeforeSendHeaders: createEvent(),
      onHeadersReceived: createEvent(),
    },
  };

  // Unref setInterval so background timers (helper ping every 30s) don't
  // keep the Node.js process alive after tests complete.
  const unrefInterval = function (fn, ms, ...args) {
    const timer = setInterval(fn, ms, ...args);
    timer.unref();
    return timer;
  };

  const context = {
    URL,
    chrome,
    console,
    clearTimeout,
    clearInterval,
    navigator: { userAgent: "Qwin Test Browser" },
    setTimeout,
    setInterval: unrefInterval,
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(backgroundBundle, context, { filename: "background.bundle.js" });

  /**
   * Send a runtime message as if from an extension content script.
   * @param {Object} message - The message payload
   * @param {Object} [senderOverrides] - Overrides for the sender object
   */
  async function sendRuntimeMessage(message, senderOverrides = {}) {
    assert.equal(typeof runtimeListener, "function", "background runtime listener must be registered");
    const sender = {
      id: "test-extension-id",
      tab: { id: TAB_ID, url: PAGE_URL, title: PAGE_TITLE },
      url: PAGE_URL,
      ...senderOverrides,
    };
    return await new Promise((resolve) => {
      runtimeListener(message, sender, resolve);
    });
  }

  return { chrome, nativePorts, runtimeMessages, sendRuntimeMessage };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 1: Iframe-detected video is stored with correct frameUrl
  // ═══════════════════════════════════════════════════════════════════════
  {
    console.log("--- Scenario 1: Iframe-detected video is stored with correct frameUrl ---");

    const harness = createBackgroundHarness();

    // Simulate the content script inside the iframe detecting an HLS video.
    // The sender.url is the iframe's URL (playmogo.com).
    const response = await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: HLS_URL,
            format: "M3U8",
            source: "dom-video",
            pageUrl: PAGE_URL,
            frameUrl: IFRAME_URL,
            title: IFRAME_TITLE,
            downloadable: true,
            contentType: "application/x-mpegURL",
            height: 1080,
            width: 1920,
            duration: 1800,
            bitrate: 5000,
          },
        ],
      },
      { url: IFRAME_URL, tab: { id: TAB_ID, url: IFRAME_URL, title: IFRAME_TITLE } },
    );

    assert.equal(response.ok, true, "contentDetectedVideos should return ok");

    // Verify the background sent videoListUpdated to the popup
    const popupNotification = harness.runtimeMessages.find(
      (m) => m.type === "videoListUpdated" && m.tabId === TAB_ID && m.videos.length === 1,
    );
    assert.ok(popupNotification, "background should notify popup of video list update");
    assert.equal(popupNotification.videos[0].format, "M3U8", "popup notification should include the HLS video format");

    // Verify the video was stored and retrievable via getVideos
    const listResponse = await harness.sendRuntimeMessage({
      type: "getVideos",
      tabId: TAB_ID,
    });
    assert.equal(listResponse.ok, true, "getVideos should return ok");
    assert.equal(listResponse.videos.length, 1, "should have 1 video (the HLS from iframe)");

    const video = listResponse.videos[0];
    assert.ok(video, "video should be defined");
    assert.equal(video.format, "M3U8", "format should be M3U8");
    assert.equal(video.source, "dom-video", "source should be dom-video");
    assert.equal(video.url, HLS_URL, "url should be the HLS URL");
    assert.equal(video.frameUrl, IFRAME_URL, "frameUrl should be the iframe URL");
    assert.equal(video.downloadable, true, "video should be downloadable");
    assert.equal(video.height, 1080, "height should be preserved");

    console.log("  ✓ Iframe-detected video stored with correct frameUrl, format, and source");
    console.log("  ✓ Popup notified via videoListUpdated message");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 2: Parent page creates iframe-page candidate alongside iframe-detected video
  // ═══════════════════════════════════════════════════════════════════════
  {
    console.log("\n--- Scenario 2: Parent page creates iframe-page candidate ---");

    const harness = createBackgroundHarness();

    // Parent page content script detects iframe → iframe-page PAGE candidate.
    // This simulates scanVisiblePlayerFrames() in content.js
    await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: IFRAME_URL,
            format: "PAGE",
            source: "iframe-page",
            pageUrl: PAGE_URL,
            frameUrl: PAGE_URL,
            title: PAGE_TITLE,
            downloadable: true,
            width: 640,
            height: 480,
            duration: 0,
          },
        ],
      },
      { url: PAGE_URL, tab: { id: TAB_ID, url: PAGE_URL, title: PAGE_TITLE } },
    );

    // Iframe content script detects HLS video
    await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: HLS_URL,
            format: "M3U8",
            source: "dom-video",
            pageUrl: PAGE_URL,
            frameUrl: IFRAME_URL,
            title: IFRAME_TITLE,
            downloadable: true,
            contentType: "application/x-mpegURL",
            height: 1080,
            width: 1920,
            duration: 1800,
            bitrate: 5000,
          },
        ],
      },
      { url: IFRAME_URL, tab: { id: TAB_ID, url: IFRAME_URL, title: IFRAME_TITLE } },
    );

    // Verify popup was notified after each detection
    const popupNotifications = harness.runtimeMessages.filter(
      (m) => m.type === "videoListUpdated" && m.tabId === TAB_ID,
    );
    assert.ok(popupNotifications.length >= 2, "popup should be notified after each content detection");

    // Verify both candidates are accessible via getVideos.
    // The iframe-page PAGE candidate and the HLS video are NOT grouped together
    // because they have different URLs, stems, and titles. isSameFullVideo requires
    // matching URLs OR matching pageKey+stemKey OR matching pageKey+titleKey.
    // Since the iframe embed URL differs from the HLS stream URL, they appear
    // as separate entries. The frameUrl on the HLS video preserves the iframe src
    // for fallback resolution.
    const listResponse = await harness.sendRuntimeMessage({
      type: "getVideos",
      tabId: TAB_ID,
    });
    assert.equal(listResponse.ok, true);

    console.log(
      "  Videos:",
      JSON.stringify(
        listResponse.videos.map((v) => ({
          id: v.id,
          format: v.format,
          source: v.source,
          url: (v.url || "").slice(0, 60),
          frameUrl: v.frameUrl,
          pageUrl: v.pageUrl,
        })),
        null,
        2,
      ),
    );

    assert.equal(
      listResponse.videos.length,
      2,
      "should have 2 separate videos: iframe-page/PAGE and iframe-detected/M3U8",
    );

    // Verify the iframe-page PAGE candidate
    const pageCandidate = listResponse.videos.find((v) => v.source === "iframe-page");
    assert.ok(pageCandidate, "should have the iframe-page PAGE candidate");
    assert.equal(pageCandidate.url, IFRAME_URL, "iframe-page URL should be the iframe src");
    assert.equal(pageCandidate.format, "PAGE", "iframe-page format should be PAGE");
    assert.equal(pageCandidate.frameUrl, PAGE_URL, "iframe-page frameUrl should be parent page URL");

    // Verify the iframe-detected HLS video
    const hlsVideo = listResponse.videos.find((v) => v.format === "M3U8");
    assert.ok(hlsVideo, "should have the iframe-detected HLS video");
    assert.equal(hlsVideo.url, HLS_URL, "HLS video URL should be the stream URL");
    assert.equal(hlsVideo.frameUrl, IFRAME_URL, "HLS video frameUrl should be the iframe src");
    assert.equal(hlsVideo.source, "dom-video", "HLS video source should be dom-video");

    console.log("  ✓ iframe-page PAGE candidate present with correct format and frameUrl");
    console.log("  ✓ iframe-detected HLS M3U8 video present with frameUrl = iframe src");
    console.log("  ✓ Popup received multiple videoListUpdated notifications");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 3: Download iframe-detected video via yt-dlp
  // ═══════════════════════════════════════════════════════════════════════
  {
    console.log("\n--- Scenario 3: Download iframe-detected video via yt-dlp ---");

    const nativeMessages = [];
    let formatsResolved = false;

    const harness = createBackgroundHarness((message, native) => {
      nativeMessages.push(message);

      if (message.type === "formats") {
        // Respond with yt-dlp format results
        native.emit({
          type: "formats",
          id: message.id,
          title: "Video from iframe player",
          formats: [
            {
              id: "best",
              label: "Best available MP4",
              ext: "mp4",
              note: "Recommended",
              source: "yt-dlp / playmogo.com",
            },
            {
              id: "bestvideo",
              label: "Best video only",
              ext: "mp4",
              note: "Video only",
              source: "yt-dlp / playmogo.com",
            },
          ],
        });
        formatsResolved = true;
        return;
      }

      if (message.type === "download") {
        native.emit({ type: "started", id: message.id });
        setTimeout(() => {
          native.emit({
            type: "done",
            id: message.id,
            filepath: "C:\\Downloads\\Video\\master.mp4",
            message: "Download complete.",
          });
        }, 10);
      }
    });

    // Add the iframe-detected HLS video
    await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: HLS_URL,
            format: "M3U8",
            source: "dom-video",
            pageUrl: PAGE_URL,
            frameUrl: IFRAME_URL,
            title: IFRAME_TITLE,
            downloadable: true,
            contentType: "application/x-mpegURL",
            height: 1080,
            width: 1920,
            duration: 1800,
            bitrate: 5000,
          },
        ],
      },
      { url: IFRAME_URL, tab: { id: TAB_ID, url: IFRAME_URL, title: IFRAME_TITLE } },
    );

    // Retrieve the video ID
    const listResponse = await harness.sendRuntimeMessage({
      type: "getVideos",
      tabId: TAB_ID,
    });
    assert.equal(listResponse.videos.length, 1);
    const videoId = listResponse.videos[0].id;

    // Step 1: Get formats via yt-dlp (popup "show formats" action)
    const formatsResponse = await harness.sendRuntimeMessage({
      type: "getVideoFormats",
      tabId: TAB_ID,
      videoId,
    });

    assert.equal(formatsResponse.ok, true, "getVideoFormats should succeed");
    assert.ok(formatsResponse.formats, "formats response should include formats array");
    assert.ok(formatsResponse.formats.length >= 1, "should have at least 1 format option");
    assert.ok(formatsResolved, "native host should have been called for format resolution");

    // Verify yt-dlp source is present in format metadata
    const ytDlpFormats = formatsResponse.formats.filter((f) => String(f.source || "").includes("yt-dlp"));
    assert.ok(
      ytDlpFormats.length > 0,
      "formats should include yt-dlp-sourced options (received: " +
        JSON.stringify(formatsResponse.formats.map((f) => f.source)) +
        ")",
    );

    // Step 2: Start the download
    const downloadResponse = await harness.sendRuntimeMessage({
      type: "downloadVideo",
      tabId: TAB_ID,
      videoId,
      formatId: "best",
      variantId: "",
      backend: "auto",
    });

    assert.equal(downloadResponse.ok, true, "downloadVideo should return ok");
    assert.ok(downloadResponse.jobId, "download should have a jobId");

    // Allow native messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the native host received the correct download message
    const downloadMsg = nativeMessages.find((m) => m.type === "download");
    assert.ok(downloadMsg, "native host should receive a download message");
    assert.equal(downloadMsg.url, HLS_URL, "native host should receive the HLS URL");
    assert.equal(downloadMsg.format, "M3U8", "native host should receive the correct format");
    assert.equal(downloadMsg.backend, "auto", "native host should receive the correct backend");

    console.log("  ✓ yt-dlp format lookup returned", ytDlpFormats.length, "yt-dlp-sourced formats");
    console.log("  ✓ Download initiated with correct HLS URL via native messaging");
    console.log("  ✓ Native message url:", downloadMsg.url);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 4: Iframe fallback — iframe-page PAGE fails, fallback finds iframe-detected video
  // ═══════════════════════════════════════════════════════════════════════
  {
    console.log("\n--- Scenario 4: Iframe fallback ---");

    const downloadMessages = [];
    const resolveMessages = [];

    const harness = createBackgroundHarness((message, native) => {
      if (message.type === "resolveMediaCandidates") {
        resolveMessages.push(message);
        native.emit({
          type: "mediaCandidates",
          id: message.id,
          candidates: [],
        });
        return;
      }
      if (message.type === "download") {
        downloadMessages.push(message);
        // First download (iframe-page PAGE) fails
        if (message.url === IFRAME_URL) {
          native.emit({
            type: "error",
            id: message.id,
            error: "ERROR: Unsupported URL: " + message.url,
          });
        } else if (message.url === HLS_URL) {
          // Fallback to the iframe-detected HLS succeeds
          native.emit({ type: "started", id: message.id });
          setTimeout(() => {
            native.emit({
              type: "done",
              id: message.id,
              filepath: "C:\\Downloads\\Video\\master.mp4",
              message: "Download complete (iframe fallback).",
            });
          }, 10);
        } else {
          native.emit({
            type: "error",
            id: message.id,
            error: "ERROR: Unsupported URL: " + message.url,
          });
        }
      }
    });

    // Add both the iframe-page PAGE candidate and the iframe-detected HLS
    // Parent page detects iframe → iframe-page PAGE candidate
    await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: IFRAME_URL,
            format: "PAGE",
            source: "iframe-page",
            pageUrl: PAGE_URL,
            frameUrl: PAGE_URL,
            title: PAGE_TITLE,
            downloadable: true,
            width: 640,
            height: 480,
            duration: 0,
          },
        ],
      },
      { url: PAGE_URL, tab: { id: TAB_ID, url: PAGE_URL, title: PAGE_TITLE } },
    );

    // Iframe content script detects HLS video → dom-video M3U8
    await harness.sendRuntimeMessage(
      {
        type: "contentDetectedVideos",
        videos: [
          {
            url: HLS_URL,
            format: "M3U8",
            source: "dom-video",
            pageUrl: PAGE_URL,
            frameUrl: IFRAME_URL,
            title: IFRAME_TITLE,
            downloadable: true,
            contentType: "application/x-mpegURL",
            height: 1080,
            width: 1920,
            duration: 1800,
            bitrate: 5000,
          },
        ],
      },
      { url: IFRAME_URL, tab: { id: TAB_ID, url: IFRAME_URL, title: IFRAME_TITLE } },
    );

    // Get the video list
    const listResponse = await harness.sendRuntimeMessage({
      type: "getVideos",
      tabId: TAB_ID,
    });
    assert.ok(listResponse.videos.length >= 1, "should have at least 1 video");

    console.log(
      "  All videos:",
      listResponse.videos.map((v) => ({
        id: v.id,
        format: v.format,
        source: v.source,
        url: (v.url || "").slice(0, 60),
      })),
    );

    // Explicitly find the iframe-page PAGE candidate
    const primaryVideo = listResponse.videos.find((v) => v.source === "iframe-page");
    assert.ok(
      primaryVideo,
      "should have an iframe-page video in the list. Available sources: " +
        JSON.stringify(listResponse.videos.map((v) => v.source)),
    );
    assert.equal(primaryVideo.url, IFRAME_URL, "primary video should be the iframe embed URL");

    // Attempt to download the iframe-page PAGE candidate
    const downloadResponse = await harness.sendRuntimeMessage({
      type: "downloadVideo",
      tabId: TAB_ID,
      videoId: primaryVideo.id,
      formatId: "best",
      variantId: "",
      backend: "auto",
    });
    assert.equal(downloadResponse.ok, true);

    // Wait for the fallback chain to execute
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Verify the download chain
    assert.equal(downloadMessages[0]?.url, IFRAME_URL, "first download attempt should be the iframe URL");

    // After the iframe-page PAGE fails, fallback should find the HLS video
    const hlsDownload = downloadMessages.find((m) => m.url === HLS_URL);
    assert.ok(hlsDownload, "fallback should find the iframe-detected HLS video and retry with it");

    // Verify final download state is "done"
    const downloadHistoryResponse = await harness.sendRuntimeMessage({
      type: "getVideos",
      tabId: TAB_ID,
    });
    const completedJob = downloadHistoryResponse.downloads.find(
      (j) => j.videoId === primaryVideo.id && j.status === "done",
    );
    assert.ok(completedJob, "the download job should have status 'done' after successful HLS fallback");
    assert.equal(
      completedJob.filepath,
      "C:\\Downloads\\Video\\master.mp4",
      "download should have a filepath from the HLS download",
    );

    console.log("  ✓ iframe-page PAGE fallback found iframe-detected HLS video");
    console.log("  ✓ Download retried with iframe-detected HLS URL:", HLS_URL);
    console.log("  ✓ Download completed successfully via iframe fallback");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENARIO 5: Unit test — fallbackVideoForDownload uses findIframeDetectedVideo
  // ═══════════════════════════════════════════════════════════════════════
  {
    console.log("\n--- Scenario 5: unit test — fallbackVideoForDownload iframe fallback ---");

    // Set up minimal browser API mocks BEFORE dynamic imports
    // (browser_api.js references `chrome` at module evaluation time)
    globalThis.chrome = {
      runtime: {
        id: "test-extension-id",
        onMessage: { addListener: () => {} },
        onConnect: { addListener: () => {} },
      },
      storage: {
        local: {
          get: (_keys, cb) => cb({}),
          set: (_items, cb) => {
            if (cb) cb();
          },
        },
      },
      tabs: {
        query: (_q, cb) => cb([]),
      },
      cookies: {
        getAll: (_d, cb) => cb([]),
      },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
        onBeforeSendHeaders: { addListener: () => {} },
        onHeadersReceived: { addListener: () => {} },
      },
    };
    globalThis.browser = undefined;

    // Import the module directly for isolated unit testing
    const downloadFallbacks = await import("../../../src/background/download_fallbacks.js");
    const videoUtils = await import("../../../src/background/video_utils.js");

    // Test isIframePageVideo
    assert.equal(
      downloadFallbacks.isIframePageVideo({ source: "iframe-page", format: "PAGE" }),
      true,
      "isIframePageVideo detects iframe-page + PAGE",
    );
    assert.equal(
      downloadFallbacks.isIframePageVideo({ source: "dom-video", format: "M3U8" }),
      false,
      "isIframePageVideo returns false for dom-video",
    );
    assert.equal(downloadFallbacks.isIframePageVideo(null), false, "isIframePageVideo returns false for null");
    assert.equal(
      downloadFallbacks.isIframePageVideo({ source: "iframe-page", format: "M3U8" }),
      false,
      "isIframePageVideo returns false for non-PAGE format even with iframe-page source",
    );

    // Test fallbackVideoForDownload with iframe-detected video
    const attemptedUrls = new Set([IFRAME_URL]);
    const deps = {
      addDetectedVideo: async () => null,
      detectFormat: videoUtils.detectFormat,
      findGroupedVideoForAnyVariant: () => null,
      getVisibleVideosForTab: () => [
        {
          id: "iframe-page-1",
          url: IFRAME_URL,
          format: "PAGE",
          source: "iframe-page",
          pageUrl: PAGE_URL,
          frameUrl: PAGE_URL,
          title: PAGE_TITLE,
          downloadable: true,
        },
        {
          id: "hls-video-1",
          url: HLS_URL,
          format: "M3U8",
          source: "dom-video",
          pageUrl: PAGE_URL,
          frameUrl: IFRAME_URL,
          title: "Video Player | playmogo",
          downloadable: true,
          height: 1080,
          bitrate: 5000,
        },
      ],
      hashId: (url) => `v_${url.length}`,
      isDownloadableUrl: videoUtils.isDownloadableUrl,
      nativeRequest: async () => ({ candidates: [] }),
      nativeRequestHeadersForVideo: async () => [],
      normalizeUrl: (url) => url,
      titleFromUrl: videoUtils.titleFromUrl,
      userAgent: "Mozilla/5.0",
      variantsForVideo: (video) => (video ? [video] : []),
    };

    const failedVideo = {
      id: "iframe-page-1",
      url: IFRAME_URL,
      format: "PAGE",
      source: "iframe-page",
      pageUrl: PAGE_URL,
      frameUrl: PAGE_URL,
      title: PAGE_TITLE,
      downloadable: true,
    };

    const fallbackResult = await downloadFallbacks.fallbackVideoForDownload(TAB_ID, failedVideo, attemptedUrls, deps);

    assert.ok(fallbackResult, "fallbackVideoForDownload should return a fallback video");
    assert.equal(
      fallbackResult.url,
      HLS_URL,
      "fallback should return the iframe-detected HLS URL, got: " + (fallbackResult ? fallbackResult.url : "null"),
    );
    assert.equal(
      fallbackResult.fallbackReason,
      "iframe-detected-video",
      "fallback should indicate iframe-detected-video reason",
    );
    assert.equal(fallbackResult.source, "dom-video", "fallback should preserve dom-video source");

    console.log("  ✓ fallbackVideoForDownload finds iframe-detected HLS video");
    console.log("  ✓ Fallback reason:", fallbackResult.fallbackReason);
    console.log("  ✓ Fallback URL:", fallbackResult.url);

    // Clean up global chrome mock to avoid leaking between tests
    delete globalThis.chrome;
    delete globalThis.browser;
  }

  console.log("\n✓ All iframe end-to-end download flow tests passed!");
})().catch((error) => {
  console.error("Test failed:", error.message);
  console.error(error.stack);
  process.exitCode = 1;
});
