import assert from "node:assert/strict";

/**
 * Bug: createOperations receives { ...deps, startNativeDownloadFromVideo: null }.
 * Later, ops.startNativeDownloadFromVideo is patched — but the internal `deps`
 * inside createOperations still sees null. So resumeDownload/retryDownload throw
 * TypeError: deps.startNativeDownloadFromVideo is not a function.
 *
 * This test verifies that retryDownload properly sees the patched function.
 */

// Set up minimal browser API mocks BEFORE importing modules that reference
// `chrome` or `browser` at the top level (browser_api.js).
globalThis.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    connectNative: () => ({
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {},
      disconnect: () => {},
    }),
    sendMessage: () => {},
    id: "test-extension-id",
  },
  storage: {
    local: {
      get: (_keys, cb) => cb({}),
      set: (_items, cb) => cb?.(),
      remove: (_keys, cb) => cb?.(),
    },
  },
  tabs: {
    query: (_query, cb) => cb([{ id: 42, url: "https://example.com" }]),
    sendMessage: (_tabId, _msg, cb) => cb?.(null),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: {
    executeScript: (_details, cb) => cb?.([]),
  },
  cookies: {
    getAll: (_details, cb) => cb([]),
  },
  webRequest: {
    onBeforeRequest: { addListener: () => {} },
    onBeforeSendHeaders: { addListener: () => {} },
    onHeadersReceived: { addListener: () => {} },
  },
};
globalThis.browser = undefined;
// navigator is read-only in Node.js; override its userAgent via defineProperty
if (!globalThis.navigator) {
  globalThis.navigator = { userAgent: "Qwin Test" };
} else {
  Object.defineProperty(globalThis.navigator, "userAgent", {
    value: "Qwin Test",
    configurable: true,
  });
}
globalThis.URL = URL;

// Dynamic import — ensures globals are set up before the module graph evaluates.
const mod = await import("../../../src/background/download/index.js");
const { create } = mod;

async function testRetryDownloadSeesPatchedStartNativeDownloadFromVideo() {
  const orchestrator = create({
    // ── Core state ──────────────────────────────────────────────────────
    getSettings: () => ({}),
    ensureStateLoaded: async () => {},
    getTabVideos: async () => [],
    getDownloadsById: () => ({
      job_retry_test: {
        id: "job_retry_test",
        status: "error",
        url: "https://example.com/video.mp4",
        title: "Test Video",
        format: "MP4",
        formatId: "best",
        requestHeaders: [],
        pageUrl: "https://example.com",
        backend: "auto",
      },
    }),
    setDownloadsById: () => {},
    downloadPortsById: {},
    persistDownloads: async () => {},
    persistSettings: async () => {},
    notifyPopup: () => {},

    // ── URL/video helpers ──────────────────────────────────────────────
    normalizeUrl: (url) => url,
    hashId: (_url) => _url,
    detectFormat: (_url) => "MP4",
    titleFromUrl: (_url) => "Video",
    videoFilters: { isBlockedVideoUrl: () => false, isGenericTitle: () => false },
    pageFallbackVideoForSource: () => null,
    variantsForVideo: () => [],
    findVariant: (video) => video,

    // ── Download progress ──────────────────────────────────────────────
    updateDownload: () => {},
    normalizeDownloadProgress: (_a, b) => b,
    downloadProgressMessage: (pct) => `${pct}%`,
    resetDownloadProgressDetails: () => ({}),
    progressDetailPatchFromMessage: () => ({}),
    artifactPatchFromMessage: () => ({}),
    cleanupPatchFromMessage: () => ({}),
    clearedArtifactPatch: () => ({}),
    cleanupDownloadArtifacts: async () => ({}),

    // ── Error handling ─────────────────────────────────────────────────
    isHardAccessError: () => false,
    isRetryableSourceError: () => false,
    exhaustedSourcesError: (e) => e,
    userFriendlyDownloadError: () => "",
    markVideoUrlUnavailable: async () => {},
    fallbackVideoForDownload: async () => null,

    // ── Native messaging ───────────────────────────────────────────────
    nativeRequest: async () => ({}),
    nativeRequestHeadersForVideo: async () => [],
    hostName: "com.qwin.video_downloader",
    callTabsQuery: async () => [{ url: "https://example.com" }],
    userAgent: () => "test",

    // ── Chrome API mocks ───────────────────────────────────────────────
    api: {
      runtime: {
        lastError: null,
        connectNative: () => ({
          onMessage: { addListener: () => {} },
          onDisconnect: { addListener: () => {} },
          postMessage: () => {},
          disconnect: () => {},
        }),
      },
      tabs: { query: async () => [{ url: "https://example.com" }] },
    },

    // ── Blocking statuses ──────────────────────────────────────────────
    blockingDownloadStatuses: new Set(["queued", "connecting", "running", "paused", "pausing", "canceling"]),
  });

  try {
    await orchestrator.retryDownload(1, "job_retry_test");
    // If we reach here, startNativeDownloadFromVideo was called successfully.
    // The patch works — not a TypeError.
  } catch (error) {
    // With the BUG, this throws TypeError: deps.startNativeDownloadFromVideo is not a function
    if (
      error instanceof TypeError &&
      (error.message.includes("startNativeDownloadFromVideo") || error.message.includes("is not a function"))
    ) {
      assert.fail(
        `BUG: deps.startNativeDownloadFromVideo was null when retryDownload called it. ` +
          `The circular dependency patch is broken — createOperations() internal deps ` +
          `still sees null instead of the real function.\nError: ${error.message}`,
      );
    }
    // Any other error means the function was reached but something else in
    // the mock setup is missing — still a valid test failure, rethrow.
    throw error;
  }
}

await testRetryDownloadSeesPatchedStartNativeDownloadFromVideo();
console.log("PASS: test_start_native_download_deps.js");
