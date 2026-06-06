const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../src/background/background.js"), "utf8");
const filters = require(path.join(__dirname, "../../src/shared/video_filters.js"));
const downloadState = require(path.join(__dirname, "../../src/background/download_state.js"));

const TAB_ID = 42;
const PAGE_URL = "https://example.com/watch/movie";
const STALE_URL = "https://cdn.example.com/media/movie.mp4?token=gone";
const FRESH_URL = "https://cdn.example.com/media/movie.mp4?token=fresh";
const ACCESS_ERROR = "ERROR: [generic] Unable to download webpage: HTTP Error 410: Gone";
const INVALID_MEDIA_ERROR = [
  "WARNING: [generic] Falling back on generic information extractor",
  "WARNING: [generic] URL could be a direct video link, returning it as such.",
  "[download] 100% of 506.00B in 00:00:00 at 988.49B/s",
  "ERROR: Postprocessing: Error opening input files: Invalid data found when processing input",
].join("\n");

function createEvent() {
  return {
    listeners: [],
    addListener(listener) {
      this.listeners.push(listener);
    },
  };
}

function createBackgroundHarness(nativeHandler) {
  let runtimeListener = null;
  const storageState = {};
  const nativePorts = [];
  const runtimeMessages = [];

  const chrome = {
    runtime: {
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
          if (callback) {
            callback();
          }
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageState[key];
          }
          if (callback) {
            callback();
          }
        },
      },
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: TAB_ID, url: PAGE_URL }]);
      },
      sendMessage(_tabId, _message, callback) {
        if (callback) {
          callback(null);
        }
      },
      onRemoved: createEvent(),
      onUpdated: createEvent(),
    },
    scripting: {
      executeScript(_details, callback) {
        if (callback) {
          callback([]);
        }
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

  const context = {
    URL,
    chrome,
    console,
    clearTimeout,
    navigator: { userAgent: "Qwin Test Browser" },
    setTimeout,
  };
  context.globalThis = context;
  context.QwinVideoFilters = filters;
  context.QwinDownloadState = downloadState;

  vm.createContext(context);
  vm.runInContext(source, context, { filename: "background.js" });

  async function sendRuntimeMessage(message) {
    assert.equal(typeof runtimeListener, "function", "background runtime listener must be registered");
    return await new Promise((resolve) => {
      runtimeListener(message, { tab: { id: TAB_ID, url: PAGE_URL }, url: PAGE_URL }, resolve);
    });
  }

  return { nativePorts, runtimeMessages, sendRuntimeMessage };
}

async function addGroupedVideos(harness) {
  await harness.sendRuntimeMessage({
    type: "contentDetectedVideos",
    videos: [
      {
        url: FRESH_URL,
        title: "Movie",
        pageUrl: PAGE_URL,
        format: "MP4",
        duration: 420,
        height: 720,
        sizeBytes: 100_000_000,
        downloadable: true,
      },
      {
        url: STALE_URL,
        title: "Movie",
        pageUrl: PAGE_URL,
        format: "MP4",
        duration: 420,
        height: 1080,
        sizeBytes: 200_000_000,
        downloadable: true,
      },
    ],
  });

  const listResponse = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  assert.equal(listResponse.ok, true);
  assert.equal(listResponse.videos.length, 1);
  assert.equal(listResponse.videos[0].variants.length, 2);
  assert.equal(listResponse.videos[0].variants[0].url, STALE_URL);
  return listResponse.videos[0];
}

async function testFormatLookupFallsBackToFreshDetectedVariant() {
  const harness = createBackgroundHarness((message, native) => {
    if (message.type === "formats") {
      native.emit({ type: "error", id: message.id, error: ACCESS_ERROR });
    }
  });
  const groupedVideo = await addGroupedVideos(harness);

  const response = await harness.sendRuntimeMessage({
    type: "getVideoFormats",
    tabId: TAB_ID,
    videoId: groupedVideo.id,
  });

  assert.equal(response.ok, true);
  assert.match(response.nativeError, /HTTP Error 410/);
  assert.equal(response.formats.length, 1);
  assert.equal(response.formats[0].variantId, groupedVideo.variants[1].id);
  assert.equal(response.formats[0].sourceUrl, FRESH_URL);
}

async function testDownloadRetriesFreshVariantAfterHardAccessError() {
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "download") {
      return;
    }
    downloadMessages.push(message);
    if (message.url === STALE_URL) {
      native.emit({ type: "error", id: message.id, error: ACCESS_ERROR });
    }
  });
  const groupedVideo = await addGroupedVideos(harness);

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: groupedVideo.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(downloadMessages.length, 2);
  assert.equal(downloadMessages[0].url, STALE_URL);
  assert.equal(downloadMessages[1].url, FRESH_URL);
  assert.equal(downloadMessages[1].id, downloadMessages[0].id);
  assert.equal(downloadMessages[1].formatId, "best");
}

async function testDownloadRetriesFreshVariantAfterInvalidMediaSourceError() {
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "download") {
      return;
    }
    downloadMessages.push(message);
    if (message.url === STALE_URL) {
      native.emit({ type: "error", id: message.id, error: INVALID_MEDIA_ERROR });
    }
  });
  const groupedVideo = await addGroupedVideos(harness);

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: groupedVideo.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(downloadMessages.length, 2);
  assert.equal(downloadMessages[0].url, STALE_URL);
  assert.equal(downloadMessages[1].url, FRESH_URL);
  assert.equal(downloadMessages[1].id, downloadMessages[0].id);
  assert.equal(downloadMessages[1].formatId, "best");
}

async function testPausedDownloadDoesNotStartDuplicateNativeDownload() {
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "download") {
      return;
    }
    downloadMessages.push(message);
    native.emit({
      type: "paused",
      id: message.id,
      status: "paused",
      artifactRoot: "C:\\Users\\Viewer\\Downloads\\Movie",
      message: "Download paused.",
    });
  });
  const groupedVideo = await addGroupedVideos(harness);

  const firstResponse = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: groupedVideo.id,
    formatId: "best",
  });
  const secondResponse = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: groupedVideo.id,
    formatId: "best",
  });

  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.equal(secondResponse.jobId, firstResponse.jobId);
  assert.equal(downloadMessages.length, 1);
}

async function testManualUrlFormatLookupUsesYtDlpExtractorPage() {
  const manualUrl = "https://www.instagram.com/reels/ABC123/";
  const formatMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "formats") {
      return;
    }
    formatMessages.push(message);
    native.emit({
      type: "formats",
      id: message.id,
      title: "Instagram Reel",
      formats: [
        {
          id: "best",
          label: "Best available MP4",
          ext: "mp4",
          note: "Recommended",
        },
      ],
    });
  });

  const response = await harness.sendRuntimeMessage({
    type: "getFormatsForUrl",
    tabId: TAB_ID,
    video: {
      url: manualUrl,
      pageUrl: manualUrl,
      title: "Manual social link",
      format: "PAGE",
      source: "manual-url",
      duration: 8,
      downloadable: true,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.title, "Instagram Reel");
  assert.equal(response.videoId.startsWith("v_"), true);
  assert.equal(formatMessages.length, 1);
  assert.equal(formatMessages[0].url, manualUrl);
  assert.equal(formatMessages[0].pageUrl, manualUrl);
}

async function testManualUrlFormatLookupRejectsStoryboardOnlyExtractorResult() {
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "formats") {
      return;
    }
    native.emit({
      type: "formats",
      id: message.id,
      title: "Storyboard Only",
      formats: [],
    });
  });

  const response = await harness.sendRuntimeMessage({
    type: "getFormatsForUrl",
    tabId: TAB_ID,
    video: {
      url: "https://www.youtube.com/watch?v=Aa89MC8jX2c",
      pageUrl: "https://www.youtube.com/watch?v=Aa89MC8jX2c",
      title: "Manual YouTube link",
      format: "PAGE",
      source: "manual-url",
      duration: 8,
      downloadable: true,
    },
  });

  assert.equal(response.ok, false);
  assert.match(response.error, /did not find any downloadable video formats/i);
}

async function testChooseDownloadFolderPersistsNativeSelectedPath() {
  const selectedPath = "C:\\Users\\Viewer\\Videos";
  const nativeMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    nativeMessages.push(message);
    if (message.type !== "chooseFolder") {
      return;
    }
    native.emit({
      type: "folder",
      id: message.id,
      path: selectedPath,
    });
  });

  const response = await harness.sendRuntimeMessage({
    type: "chooseDownloadFolder",
    tabId: TAB_ID,
  });
  const settingsResponse = await harness.sendRuntimeMessage({
    type: "getSettings",
    tabId: TAB_ID,
  });

  assert.equal(response.ok, true);
  assert.equal(response.path, selectedPath);
  assert.equal(response.settings.downloadFolder, selectedPath);
  assert.equal(settingsResponse.settings.downloadFolder, selectedPath);
  assert.equal(nativeMessages[0].type, "chooseFolder");
  assert.equal(nativeMessages[0].initialFolder, "");
}

async function testChooseFolderAliasPersistsNativeSelectedPath() {
  const selectedPath = "C:\\Users\\Viewer\\Media";
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "chooseFolder") {
      return;
    }
    native.emit({
      type: "folder",
      id: message.id,
      path: selectedPath,
    });
  });

  const response = await harness.sendRuntimeMessage({
    type: "chooseFolder",
    tabId: TAB_ID,
  });

  assert.equal(response.ok, true);
  assert.equal(response.path, selectedPath);
  assert.equal(response.settings.downloadFolder, selectedPath);
}

(async () => {
  await testFormatLookupFallsBackToFreshDetectedVariant();
  await testDownloadRetriesFreshVariantAfterHardAccessError();
  await testDownloadRetriesFreshVariantAfterInvalidMediaSourceError();
  await testPausedDownloadDoesNotStartDuplicateNativeDownload();
  await testManualUrlFormatLookupUsesYtDlpExtractorPage();
  await testManualUrlFormatLookupRejectsStoryboardOnlyExtractorResult();
  await testChooseDownloadFolderPersistsNativeSelectedPath();
  await testChooseFolderAliasPersistsNativeSelectedPath();
  console.log("background hard access fallback tests passed");
})();
