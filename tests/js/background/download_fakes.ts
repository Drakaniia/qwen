/**
 * The orchestration bag `download/index.ts` is built from, faked to the REAL contract:
 * `connectNative` hands back a port that accepts the request and stays silent until the
 * test delivers a message — exactly the window in which a gate that released on *start*
 * had already let everything through.
 */
import { ACTIVE_DOWNLOAD_STATUSES } from "../../../src/shared/download_statuses.js";

export interface FakePort {
  jobId: string;
  posted: Array<Record<string, unknown>>;
  emit: (message: Record<string, unknown>) => void;
  disconnect: () => void;
}

export type FakeJob = Record<string, unknown>;

export function fakeDeps(videoCount: number, settings: Record<string, unknown> = {}) {
  const jobs: Record<string, FakeJob> = {};
  const openPorts: FakePort[] = [];
  const browserDownloads: Array<{ url: string; reply: (id: number) => void }> = [];

  const deps = {
    api: {
      runtime: { connectNative: (): unknown => null, lastError: null as null | { message: string } },
      downloads: {
        download(options: { url: string }, callback: (id: number) => void) {
          browserDownloads.push({ url: options.url, reply: callback });
        },
      },
    },
    hostName: "com.qwin.video_downloader",
    callTabsQuery: async () => [{ url: "https://example.com/watch" }],
    ensureStateLoaded: async () => {},
    downloadPortsById: {} as Record<string, unknown>,
    getSettings: () => settings,
    getDownloadsById: () => jobs,
    nativeRequestHeadersForVideo: async () => [],
    normalizeUrl: (url: string) => url,
    userAgent: () => "UA",
    detectFormat: () => "MP4",
    titleFromUrl: () => "untitled",
    hashId: (value: string) => `h_${value}`,
    resetDownloadProgressDetails: () => ({}),
    artifactPatchFromMessage: () => ({}),
    progressDetailPatchFromMessage: () => ({}),
    cleanupPatchFromMessage: () => ({}),
    clearedArtifactPatch: () => ({}),
    cleanupDownloadArtifacts: async () => ({}),
    normalizeDownloadProgress: (_jobId: string, percent: unknown) => Number(percent),
    downloadProgressMessage: (percent: number | null) => `${percent}%`,
    isRetryableSourceError: (_error: unknown) => false,
    isHardAccessError: () => false,
    markVideoUrlUnavailable: async () => false,
    fallbackVideoForDownload: async (): Promise<unknown> => null,
    exhaustedSourcesError: (error: unknown) => String(error),
    pageFallbackVideoForSource: () => null,
    videoFilters: { isBlockedVideoUrl: () => false },
    userFriendlyDownloadError: (error: unknown) => String(error),
    variantsForVideo: () => [],
    findVariant: (video: Record<string, unknown>) => video,
    // The REAL set, not a hand-picked subset: `"queued"` is in it, which is what let the
    // duplicate check match a row against its own placeholder and open no port at all.
    blockingDownloadStatuses: ACTIVE_DOWNLOAD_STATUSES,
    updateDownload: (jobId: string, patch: Record<string, unknown>) => {
      jobs[jobId] = { ...(jobs[jobId] || { id: jobId }), ...patch };
    },
    getTabVideos: async () =>
      Array.from({ length: videoCount }, (_value, index) => ({
        id: `v${index}`,
        url: `https://example.com/v${index}.mp4`,
        title: `Video ${index}`,
        format: "MP4",
        pageUrl: "https://example.com/watch",
        downloadable: true,
      })),
  };

  deps.api.runtime.connectNative = () => {
    let listener: (message: Record<string, unknown>) => void = () => {};
    const disconnectListeners: Array<() => void> = [];
    const handle: FakePort = {
      jobId: "",
      posted: [],
      emit(message) {
        listener(message);
      },
      disconnect() {
        disconnectListeners.forEach((fn) => fn());
      },
    };
    openPorts.push(handle);
    return {
      postMessage(message: Record<string, unknown>) {
        handle.posted.push(message);
        handle.jobId = handle.jobId || String(message.id || "");
      },
      disconnect() {},
      onMessage: {
        addListener(fn: (message: Record<string, unknown>) => void) {
          listener = fn;
        },
      },
      onDisconnect: {
        addListener(fn: () => void) {
          disconnectListeners.push(fn);
        },
      },
    };
  };

  return { deps, jobs, openPorts, browserDownloads, settings };
}

// A macrotask, not a microtask: one release admits the next row through several awaits
// (the starter's own `callTabsQuery`, then the headers lookup), and a fixed microtask count
// would race that.
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
