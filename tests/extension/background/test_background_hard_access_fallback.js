import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const backgroundBundle = fs.readFileSync(path.join(__dirname, "../../../dist/test/background.bundle.js"), "utf8");

const TAB_ID = 42;
const PAGE_URL = "https://example.com/watch/movie";
const STALE_URL = "https://cdn.example.com/media/movie.mp4?token=gone";
const FRESH_URL = "https://cdn.example.com/media/movie.mp4?token=fresh";
const HINT_ONLY_URL = "https://cdn.example.com/player/hls/provider?id=123";
const PROVIDER_ASSET_URL = "https://george.xtremestream.xyz/player/assets/jwplayer-8.34.0/provider.hlsjs";
const PLAYER_URL = "https://george.xtremestream.xyz/player/index.php?data=40542c0b28735b6a870c5cf8bc13269d";
const PLAYER_MANIFEST_URL = "https://george.xtremestream.xyz/hls/40542c0b28735b6a870c5cf8bc13269d/master.m3u8";
const PLAYER_BACKUP_MANIFEST_URL = "https://backup.example.com/hls/40542c0b28735b6a870c5cf8bc13269d/master.m3u8";
const ACCESS_ERROR = "ERROR: [generic] Unable to download webpage: HTTP Error 410: Gone";
const UNSUPPORTED_URL_ERROR = `ERROR: Unsupported URL: ${PLAYER_URL}`;
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

function createBackgroundHarness(nativeHandler, initialStorageState = {}) {
  let runtimeListener = null;
  const storageState = { ...initialStorageState };
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
    clearInterval,
    navigator: { userAgent: "Qwin Test Browser" },
    setTimeout,
    setInterval,
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(backgroundBundle, context, { filename: "background.bundle.js" });

  async function sendRuntimeMessage(message) {
    assert.equal(typeof runtimeListener, "function", "background runtime listener must be registered");
    return await new Promise((resolve) => {
      runtimeListener(message, { tab: { id: TAB_ID, url: PAGE_URL }, url: PAGE_URL }, resolve);
    });
  }

  return { chrome, nativePorts, runtimeMessages, sendRuntimeMessage };
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

async function addSingleDetectedVideo(harness, overrides = {}) {
  await harness.sendRuntimeMessage({
    type: "contentDetectedVideos",
    videos: [
      {
        url: STALE_URL,
        title: "Movie",
        pageUrl: PAGE_URL,
        format: "MP4",
        duration: 420,
        height: 720,
        sizeBytes: 100_000_000,
        downloadable: true,
        ...overrides,
      },
    ],
  });

  const listResponse = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  assert.equal(listResponse.ok, true);
  assert.equal(listResponse.videos.length, 1);
  return listResponse.videos[0];
}

async function testBeforeRequestDoesNotListHintOnlyUrlBeforeHeadersConfirmMedia() {
  const harness = createBackgroundHarness();
  const beforeRequest = harness.chrome.webRequest.onBeforeRequest.listeners[0];
  const headersReceived = harness.chrome.webRequest.onHeadersReceived.listeners[0];

  beforeRequest({
    tabId: TAB_ID,
    type: "media",
    url: HINT_ONLY_URL,
    documentUrl: PAGE_URL,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  let response = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  assert.equal(response.ok, true);
  assert.equal(response.videos.length, 0);

  headersReceived({
    tabId: TAB_ID,
    type: "media",
    url: HINT_ONLY_URL,
    documentUrl: PAGE_URL,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "100000000" },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  response = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  assert.equal(response.ok, true);
  assert.equal(response.videos.length, 1);
  assert.equal(response.videos[0].url, HINT_ONLY_URL);
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

async function testFormatLookupRetriesPlayerPageAfterInvalidDetectedSource() {
  const formatMessages = [];
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type === "download") {
      downloadMessages.push(message);
      return;
    }
    if (message.type !== "formats") {
      return;
    }
    formatMessages.push(message);
    if (message.url === STALE_URL) {
      native.emit({ type: "error", id: message.id, error: INVALID_MEDIA_ERROR });
      return;
    }
    if (message.url === PAGE_URL) {
      native.emit({
        type: "formats",
        id: message.id,
        title: "Movie From Player Page",
        formats: [
          {
            id: "best",
            label: "Best available MP4",
            ext: "mp4",
            note: "Recommended",
          },
        ],
      });
    }
  });
  const video = await addSingleDetectedVideo(harness);

  const response = await harness.sendRuntimeMessage({
    type: "getVideoFormats",
    tabId: TAB_ID,
    videoId: video.id,
  });

  assert.equal(response.ok, true);
  assert.equal(formatMessages.length, 2);
  assert.equal(formatMessages[0].url, STALE_URL);
  assert.equal(formatMessages[1].url, PAGE_URL);
  assert.equal(response.title, "Movie From Player Page");
  assert.equal(response.formats[0].source, "yt-dlp / example.com");
  assert.ok(response.videoId);
  assert.notEqual(response.formats[0].variantId, "");

  const downloadResponse = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: response.videoId,
    formatId: response.formats[0].formatId,
    variantId: response.formats[0].variantId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(downloadResponse.ok, true);
  assert.equal(downloadMessages.length, 1);
  assert.equal(downloadMessages[0].url, PAGE_URL);
}

async function testFormatLookupRetriesPlayerPageAfterUnsupportedDetectedSource() {
  const formatMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    if (message.type !== "formats") {
      return;
    }
    formatMessages.push(message);
    if (message.url === STALE_URL) {
      native.emit({ type: "error", id: message.id, error: `ERROR: Unsupported URL: ${STALE_URL}` });
      return;
    }
    if (message.url === PAGE_URL) {
      native.emit({
        type: "formats",
        id: message.id,
        title: "Movie From Unsupported Source Page",
        formats: [
          {
            id: "best",
            label: "Best available MP4",
            ext: "mp4",
            note: "Recommended",
          },
        ],
      });
    }
  });
  const video = await addSingleDetectedVideo(harness);

  const response = await harness.sendRuntimeMessage({
    type: "getVideoFormats",
    tabId: TAB_ID,
    videoId: video.id,
  });

  assert.equal(response.ok, true);
  assert.equal(formatMessages.length, 2);
  assert.equal(formatMessages[0].url, STALE_URL);
  assert.equal(formatMessages[1].url, PAGE_URL);
  assert.equal(response.title, "Movie From Unsupported Source Page");
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

async function testDownloadTriesEveryResolvedMediaCandidate() {
  const nativeMessages = [];
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    nativeMessages.push(message);
    if (message.type === "resolveMediaCandidates") {
      native.emit({
        type: "mediaCandidates",
        id: message.id,
        title: "Movie From Player Config",
        candidates: [
          {
            url: PLAYER_MANIFEST_URL,
            format: "M3U8",
            source: "player-config",
            confidence: 95,
          },
          {
            url: PLAYER_BACKUP_MANIFEST_URL,
            format: "M3U8",
            source: "player-config",
            confidence: 90,
          },
        ],
      });
      return;
    }
    if (message.type !== "download") {
      return;
    }
    downloadMessages.push(message);
    if (message.url === PLAYER_URL || message.url === PLAYER_MANIFEST_URL) {
      native.emit({ type: "error", id: message.id, error: `ERROR: Unsupported URL: ${message.url}` });
    }
  });
  const video = await addSingleDetectedVideo(harness, {
    url: PLAYER_URL,
    pageUrl: PLAYER_URL,
    frameUrl: PLAYER_URL,
    format: "PAGE",
    source: "page-fallback",
    sizeBytes: 0,
  });

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: video.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.deepEqual(
    downloadMessages.map((message) => message.url),
    [PLAYER_URL, PLAYER_MANIFEST_URL, PLAYER_BACKUP_MANIFEST_URL],
  );
  assert.equal(downloadMessages[2].id, downloadMessages[0].id);
  assert.equal(
    nativeMessages.some((message) => message.type === "resolveMediaCandidates" && message.url === PLAYER_URL),
    true,
  );
}

async function testDownloadRetriesPlayerPageAfterInvalidDetectedSource() {
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
  const video = await addSingleDetectedVideo(harness);

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: video.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(downloadMessages.length, 2);
  assert.equal(downloadMessages[0].url, STALE_URL);
  assert.equal(downloadMessages[1].url, PAGE_URL);
  assert.equal(downloadMessages[1].format, "PAGE");
  assert.equal(downloadMessages[1].id, downloadMessages[0].id);
}

async function testDownloadResolvesMediaCandidatesAfterUnsupportedPlayerPage() {
  const nativeMessages = [];
  const downloadMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    nativeMessages.push(message);
    if (message.type === "resolveMediaCandidates") {
      native.emit({
        type: "mediaCandidates",
        id: message.id,
        title: "Movie From Player Config",
        candidates: [
          {
            url: PLAYER_MANIFEST_URL,
            format: "M3U8",
            source: "player-config",
            confidence: 95,
          },
        ],
      });
      return;
    }
    if (message.type !== "download") {
      return;
    }
    downloadMessages.push(message);
    if (message.url === PLAYER_URL) {
      native.emit({ type: "error", id: message.id, error: UNSUPPORTED_URL_ERROR });
    }
  });
  const video = await addSingleDetectedVideo(harness, {
    url: PLAYER_URL,
    pageUrl: PLAYER_URL,
    frameUrl: PLAYER_URL,
    format: "PAGE",
    source: "page-fallback",
    sizeBytes: 0,
  });

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: video.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(downloadMessages.length, 2);
  assert.equal(downloadMessages[0].url, PLAYER_URL);
  assert.equal(downloadMessages[1].url, PLAYER_MANIFEST_URL);
  assert.equal(downloadMessages[1].format, "M3U8");
  assert.equal(downloadMessages[1].backend, "auto");
  assert.equal(
    nativeMessages.some((message) => message.type === "resolveMediaCandidates" && message.url === PLAYER_URL),
    true,
  );
}

async function testFormatLookupResolvesMediaCandidatesAfterUnsupportedPlayerPage() {
  const nativeMessages = [];
  const harness = createBackgroundHarness((message, native) => {
    nativeMessages.push(message);
    if (message.type === "resolveMediaCandidates") {
      native.emit({
        type: "mediaCandidates",
        id: message.id,
        title: "Movie From Player Config",
        candidates: [
          {
            url: PLAYER_MANIFEST_URL,
            format: "M3U8",
            source: "player-config",
            confidence: 95,
          },
        ],
      });
      return;
    }
    if (message.type !== "formats") {
      return;
    }
    if (message.url === PLAYER_URL) {
      native.emit({ type: "error", id: message.id, error: UNSUPPORTED_URL_ERROR });
      return;
    }
    if (message.url === PLAYER_MANIFEST_URL) {
      native.emit({
        type: "formats",
        id: message.id,
        title: "Movie From Resolved HLS",
        formats: [
          {
            id: "best",
            label: "Best available MP4",
            ext: "mp4",
            note: "Recommended",
          },
        ],
      });
    }
  });
  const video = await addSingleDetectedVideo(harness, {
    url: PLAYER_URL,
    pageUrl: PLAYER_URL,
    frameUrl: PLAYER_URL,
    format: "PAGE",
    source: "page-fallback",
    sizeBytes: 0,
  });

  const response = await harness.sendRuntimeMessage({
    type: "getVideoFormats",
    tabId: TAB_ID,
    videoId: video.id,
  });

  assert.equal(response.ok, true);
  assert.equal(response.title, "Movie From Resolved HLS");
  assert.equal(response.formats[0].backend, "auto");
  assert.equal(
    nativeMessages.some((message) => message.type === "resolveMediaCandidates" && message.url === PLAYER_URL),
    true,
  );
  assert.equal(
    nativeMessages.some((message) => message.type === "formats" && message.url === PLAYER_MANIFEST_URL),
    true,
  );
}

async function testDownloadReportsExhaustedSourcesAfterAllFallbacksFail() {
  const harness = createBackgroundHarness((message, native) => {
    if (message.type === "resolveMediaCandidates") {
      native.emit({
        type: "mediaCandidates",
        id: message.id,
        candidates: [
          {
            url: PLAYER_MANIFEST_URL,
            format: "M3U8",
            source: "player-config",
            confidence: 95,
          },
        ],
      });
      return;
    }
    if (message.type === "download") {
      native.emit({ type: "error", id: message.id, error: `ERROR: Unsupported URL: ${message.url}` });
    }
  });
  const video = await addSingleDetectedVideo(harness, {
    url: PLAYER_URL,
    pageUrl: PLAYER_URL,
    frameUrl: PLAYER_URL,
    format: "PAGE",
    source: "page-fallback",
    sizeBytes: 0,
  });

  const response = await harness.sendRuntimeMessage({
    type: "downloadVideo",
    tabId: TAB_ID,
    videoId: video.id,
    formatId: "best",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const historyResponse = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  const failedJob = historyResponse.downloads.find((job) => job.id === response.jobId);

  assert.equal(response.ok, true);
  assert.equal(failedJob.status, "error");
  assert.match(failedJob.error, /Tried 2 sources/i);
  assert.match(failedJob.error, /Unsupported URL/);
}

async function testRetryBlockedHistorySourceUsesStoredPlayerPage() {
  const downloadMessages = [];
  const harness = createBackgroundHarness(
    (message) => {
      if (message.type === "download") {
        downloadMessages.push(message);
      }
    },
    {
      qwinDownloadsById: {
        job_provider: {
          id: "job_provider",
          status: "error",
          url: PROVIDER_ASSET_URL,
          format: "VIDEO",
          title: "Movie",
          pageUrl: PAGE_URL,
          requestHeaders: [],
        },
      },
    },
  );

  const historyResponse = await harness.sendRuntimeMessage({ type: "getVideos", tabId: TAB_ID });
  assert.equal(historyResponse.downloads.length, 1);

  const response = await harness.sendRuntimeMessage({
    type: "retryDownload",
    tabId: TAB_ID,
    jobId: "job_provider",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(downloadMessages.length, 1);
  assert.equal(downloadMessages[0].url, PAGE_URL);
  assert.equal(downloadMessages[0].format, "PAGE");
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

async function testRescanClearsStaleVideosBeforeRequestingContentScan() {
  const harness = createBackgroundHarness();
  await addSingleDetectedVideo(harness);

  const response = await harness.sendRuntimeMessage({
    type: "rescanTab",
    tabId: TAB_ID,
  });
  const videosResponse = await harness.sendRuntimeMessage({
    type: "getVideos",
    tabId: TAB_ID,
  });

  assert.equal(response.ok, true);
  assert.equal(
    videosResponse.videos.length,
    0,
    "refresh must remove stale videos before content script reports fresh detections",
  );
  assert.equal(
    harness.runtimeMessages.some(
      (message) => message.type === "videoListUpdated" && message.tabId === TAB_ID && message.videos.length === 0,
    ),
    true,
    "background must notify the popup that stale detected videos were cleared",
  );
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
  await testBeforeRequestDoesNotListHintOnlyUrlBeforeHeadersConfirmMedia();
  await testFormatLookupFallsBackToFreshDetectedVariant();
  await testFormatLookupRetriesPlayerPageAfterInvalidDetectedSource();
  await testFormatLookupRetriesPlayerPageAfterUnsupportedDetectedSource();
  await testDownloadRetriesFreshVariantAfterHardAccessError();
  await testDownloadRetriesFreshVariantAfterInvalidMediaSourceError();
  await testDownloadTriesEveryResolvedMediaCandidate();
  await testDownloadRetriesPlayerPageAfterInvalidDetectedSource();
  await testDownloadResolvesMediaCandidatesAfterUnsupportedPlayerPage();
  await testFormatLookupResolvesMediaCandidatesAfterUnsupportedPlayerPage();
  await testDownloadReportsExhaustedSourcesAfterAllFallbacksFail();
  await testRetryBlockedHistorySourceUsesStoredPlayerPage();
  await testPausedDownloadDoesNotStartDuplicateNativeDownload();
  await testManualUrlFormatLookupUsesYtDlpExtractorPage();
  await testManualUrlFormatLookupRejectsStoryboardOnlyExtractorResult();
  await testRescanClearsStaleVideosBeforeRequestingContentScan();
  await testChooseDownloadFolderPersistsNativeSelectedPath();
  await testChooseFolderAliasPersistsNativeSelectedPath();
  console.log("background hard access fallback tests passed");
})();
