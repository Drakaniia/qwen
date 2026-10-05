/**
 * The background layer's internal type surface.
 *
 * Every module under `background/` takes its collaborators as an injected `deps`
 * object rather than importing them, which keeps the dependency graph acyclic
 * (`download/index.js` → `download_operations.js` → the orchestration deps) but
 * means the shapes those objects have to be written down exactly once. They are
 * here.
 *
 * Wire records come from `shared/contracts.ts` and are widened rather than
 * redefined: a background-only view is `contracts.ts`'s record plus the fields
 * only this layer reads or writes. Nothing here re-declares a `message.type`,
 * a format enum value, or a status string that `contracts.ts` already owns.
 */

import type { browserApi } from "../shared/browser_api.js";
import type {
  DetectedVideo,
  DownloadJob,
  HelperStatus,
  PopupEvent,
  Settings,
  VideoListUpdatedEvent,
  BackgroundMessage,
  BackgroundMessageType,
} from "../shared/contracts.js";

/**
 * A tab id that came off the wire.
 *
 * `senderTabId(message, sender)` prefers `message.tabId` and falls back to
 * `sender.tab.id` — and the popup's own sender has no `.tab`, so this really is
 * `number | undefined`. Every consumer here already tolerates it (they index
 * `videosByTab[String(tabId)]`, and `addDetectedVideo` rejects a non-integer up
 * front), so the alias exists to keep that one `| undefined` out of thirty
 * signatures instead of to mark thirty parameters optional.
 */
export type TabId = number | undefined;

/** One captured request header, replayed verbatim to the native helper. */
export interface RequestHeader {
  name: string;
  value: string;
}

/**
 * A detected video as the background layer stores and threads through the
 * download pipeline.
 *
 * `DetectedVideo` is the wire shape; these extras are background-only state:
 * the captured headers yt-dlp needs, sibling variants the quality dialog offers,
 * the ad-block bookkeeping, and the resolver's confidence score.
 */
export interface VideoRecord extends DetectedVideo {
  /** Captured from `webRequest.onBeforeSendHeaders` and sent to the helper. */
  requestHeaders?: RequestHeader[];
  /** Sibling renditions of the same media. `variantsForVideo` reads this. */
  variants?: VideoRecord[];
  /** yt-dlp's spelling of `sizeBytes`; some call sites send it instead. */
  filesize?: number;
  /** Set by `markVideoUrlUnavailable` when the server refuses this URL. */
  blockedReason?: string;
  /** Resolver score from `resolveMediaCandidates`; orders the fallback list. */
  confidence?: number;
}

/**
 * A video candidate offered to the user.
 *
 * Built two ways — from a yt-dlp `formats` entry (`normalizeNativeFormatOption`)
 * or from a detected variant (`detectedVariantOption`) — so only the keys both
 * producers set are required.
 */
export interface FormatOption {
  id: string;
  formatId: string;
  variantId: string;
  backend: string;
  fallbackReason: string;
  optionType: "native-format" | "detected-source";
  ext: string;
  source: string;
  label?: string;
  note?: string;
  sourceUrl?: string;
  height?: number | null;
  width?: number | null;
  tbr?: number | null;
  bitrate?: number | null;
  size?: string;
  sizeBytes?: number | null;
}

/**
 * A download job as the background layer stores it in `storage.local`.
 *
 * `DownloadJob` is what the popup renders; these extras are the host-facing
 * bookkeeping the popup never reads.
 */
export interface DownloadJobRecord extends DownloadJob {
  requestHeaders?: RequestHeader[];
  artifactPaths?: string[];
  downloadFolder?: string;
  contentType?: string;
  /** Browser-download backend only: byte counters read off `downloads.onChanged`. */
  rawDownloadedBytes?: number;
  rawTotalBytes?: number;
}

/**
 * A patch applied to a job.
 *
 * `Record<string, unknown>` rather than `Partial<DownloadJobRecord>` because the
 * keys come off the native host's own progress messages, which are not a
 * compile-time-known set. Call sites that read a field back do it off
 * `getDownload(jobId)`, which is typed.
 */
export type JobPatch = Record<string, unknown>;

/** A patch applied to a stored video, by the same argument as {@link JobPatch}. */
export type VideoPatch = Record<string, unknown>;

/**
 * `storage.local["qwinSettings"]`.
 *
 * Widens `contracts.ts`'s `Settings` with the keys the native request reads but
 * the contract does not declare. `downloadSubtitles` is `!== false` semantics:
 * the helper downloads subtitles unless explicitly told not to.
 */
export type BackgroundSettings = Settings & {
  downloadSubtitles?: boolean;
};

/**
 * What `notifyPopup` broadcasts.
 *
 * `videoListUpdated` is the one widened case. `contracts.ts` declares `tabId: number`
 * because that is what every producer actually has — except the `contentDetectedVideos`
 * handler, whose tab id comes from `senderTabId` and can be `undefined`. Both variants
 * are accepted here rather than narrowing the cast at three call sites. The union is
 * written inline rather than exported under a name nothing imports.
 */
export type NotifyPopup = (event: PopupEvent | (Omit<VideoListUpdatedEvent, "tabId"> & { tabId: TabId })) => void;

/** One member of the background message union, narrowed to its own `type`. */
export type MessageOf<T extends BackgroundMessageType> = Extract<BackgroundMessage, { type: T }>;

/**
 * What a registered handler actually receives.
 *
 * `message_router.ts`'s `Handler.handle(message)` takes one argument, but these
 * handlers also need the `sender` the message arrived from. Rather than
 * widen the dispatch map (Phase 1 owns it) or stash the sender in module
 * state — which breaks the moment two dispatches interleave across an `await` —
 * `message_router.ts` merges the sender into the message once, here.
 */
export type HandlerMessage<T> = T & { sender: chrome.runtime.MessageSender };

/** A native-host request payload. The wire format is the host's; see `host.py`. */
export type NativeRequestPayload = Record<string, unknown>;

/** One entry of the host's `resolveMediaCandidates` reply. */
export interface NativeCandidate {
  id?: string;
  url?: string;
  format?: string;
  source?: string;
  contentType?: string;
  title?: string;
  bitrate?: number;
  confidence?: number;
}

/**
 * A native-host reply.
 *
 * Typed as the union of every response the background reads, with an index
 * signature because the host also forwards yt-dlp's own keys verbatim.
 */
export interface NativeResponse {
  ok?: boolean;
  error?: string;
  version?: string;
  dependencies?: Record<string, unknown>;
  title?: string;
  thumbnailUrl?: string;
  hasSubtitles?: boolean;
  subtitleLanguages?: number;
  formats?: Record<string, unknown>[];
  candidates?: NativeCandidate[];
  /**
   * `thumbnailFrame`'s answer (`hls-thumbnail-spec.md` §4.1): a
   * `data:image/jpeg;base64,…` frame, or `""` when ffmpeg ran and produced none.
   * Typed because the grab path branches on it; the index signature would hand back
   * `unknown` and every read would need a cast.
   */
  frameUrl?: string;
  path?: string;
  canceled?: boolean;
  deleted?: string[];
  missing?: string[];
  /**
   * Spec D2/D9: the `percent` on this message is an estimate, not a measurement.
   * The host sets it per backend — `true` where it counts fragments or extrapolates,
   * false/absent where a real total is known. Carried through verbatim so the popup
   * can mark it; see `contracts.ts`'s `DownloadJob.percentApproximate`.
   */
  percentApproximate?: boolean;
  [key: string]: unknown;
}

/** Send one native-messaging request and resolve with the host's reply. */
export type NativeRequestFn = (payload: NativeRequestPayload, timeoutMs?: number) => Promise<NativeResponse>;

/** The `PingResult` of `background_helper_ping.ts`. */
export type PingResult =
  | { ok: true; version?: string; dependencies?: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * The extension API surface, as `shared/browser_api.ts`'s shim hands it back.
 *
 * The shim is `globalThis.browser ??= globalThis.chrome`, so `browserApi.raw` is a
 * `chrome` namespace at runtime. Typing the parameter as `typeof chrome` (rather
 * than reaching for the untyped `browser` global) is what gives `deps.api` real
 * types — `runtime.Port`, `webRequest.*Details`, `downloads.download`.
 */
export type ExtensionApi = typeof chrome;

/** Resolve a download's saved file, or reveal it in the OS file manager. */
export type NativeFileCommand = "openFile" | "showFile";

/** Options threaded through the native download flow. */
export interface NativeDownloadOptions {
  /** Reuse an existing job instead of minting a new id — resume and retry. */
  jobId?: string;
  /** URLs already tried for this job, normalized; the fallback search skips them. */
  attemptedUrls?: string[];
  backend?: string;
  resume?: boolean;
  /**
   * Called once when the job settles — `done`, `error`, `canceled`, an unsupported
   * browser format, or the native port disconnecting. `download/queue.ts` releases its
   * slot here rather than when this call returns, because the transfer runs on a
   * detached port listener that nothing awaits. Omitted by every caller outside the
   * batch queue.
   */
  onSettled?: () => void;
}

/** Per-download collaborator bag handed to `download/browser.ts`. */
export interface BrowserDownloadOptions {
  jobId: string;
  pageUrl: string;
  requestHeaders: RequestHeader[];
  attemptedUrls: string[];
  backend: string;
}

/** Return value of every download entry point: the job id it created or reused. */
export interface DownloadStartResult {
  jobId: string;
  existing?: boolean;
}

/** What `chooseDownloadFolder` reports back through the message router. */
export interface FolderChoiceResult {
  canceled?: boolean;
  path?: string;
  settings?: BackgroundSettings;
}

/**
 * The collaborators `download_fallbacks.ts` needs from `download_helpers.ts`.
 *
 * Built by `buildDownloadFallbackDeps` rather than imported, so the fallback
 * search has no cycle back into the module that calls it.
 */
export interface DownloadFallbackDeps {
  addDetectedVideo(tabId: TabId, input: VideoInput, notify?: boolean): Promise<VideoRecord | null>;
  detectFormat(url: string, contentType?: string): string;
  findGroupedVideoForAnyVariant(tabId: TabId, video: VideoRecord): VideoRecord | undefined;
  getVisibleVideosForTab(tabId: TabId): VideoRecord[];
  hashId(value: string): string;
  isDownloadableUrl(url: string, contentType?: string): boolean;
  nativeRequest: NativeRequestFn;
  nativeRequestHeadersForVideo(videoUrl: string, pageUrl: string): Promise<RequestHeader[]>;
  normalizeUrl(url: string): string;
  titleFromUrl(url: string): string;
  userAgent: string;
  variantsForVideo(video: VideoRecord): VideoRecord[];
}

/**
 * The input `addDetectedVideo` accepts — a partially-filled detection report.
 *
 * `formatId` / `variantId` ride along because the `downloadUrl` message sends the
 * user's format choice at the top level of the request rather than inside `video`,
 * and `startNativeDownloadForUrl` forwards the whole thing to the detector.
 */
export type VideoInput = Partial<VideoRecord> & {
  url?: string;
  formatId?: string;
  variantId?: string;
};

/**
 * The full orchestration dependency bag, assembled once by `background.ts`.
 *
 * `download_operations.ts`, `download/native.ts` and `download/browser.ts` all
 * take this (or a subset of it). `startNativeDownloadFromVideo` is the one field
 * `download/index.ts` patches in after `createOperations` has closed over the
 * object — see the comment there.
 */
export interface DownloadOrchestratorDeps {
  api: ExtensionApi;
  addDetectedVideo(tabId: TabId, input: VideoInput, notify?: boolean): Promise<VideoRecord | null>;
  artifactPatchFromMessage(message: NativeResponse): JobPatch;
  /** Statuses that mean "this job is still doing something". Read-only — only `.has()` is used. */
  blockingDownloadStatuses: ReadonlySet<string>;
  callTabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[] | null>;
  cleanupDownloadArtifacts(jobId: string, job: DownloadJobRecord): Promise<JobPatch>;
  cleanupPatchFromMessage(message: NativeResponse): JobPatch;
  clearedArtifactPatch(cleanupPatch: JobPatch): JobPatch;
  detectFormat(url: string, contentType?: string): string;
  downloadPortsById: Record<string, chrome.runtime.Port>;
  downloadProgressMessage(percent: number | null): string;
  ensureStateLoaded(): Promise<unknown>;
  exhaustedSourcesError(error: unknown, attemptedUrls: Set<string>): string;
  fallbackVideoForDownload(
    tabId: TabId,
    failedVideo: VideoRecord,
    attemptedUrls: Set<string>,
  ): Promise<VideoRecord | null>;
  findVariant(video: VideoRecord, variantId: string): VideoRecord | null;
  getDownloadsById(): Record<string, DownloadJobRecord>;
  getSettings(): BackgroundSettings;
  getTabVideos(tabId: TabId): Promise<VideoRecord[]>;
  hashId(value: string): string;
  hostName: string;
  isHardAccessError(error: unknown): boolean;
  isRetryableSourceError(error: unknown): boolean;
  markVideoUrlUnavailable(
    tabId: TabId,
    url: string,
    error: unknown,
    getVisibleVideosFn?: (tabId: TabId) => VideoRecord[],
    notifyPopupFn?: NotifyPopup,
  ): Promise<boolean>;
  nativeRequest: NativeRequestFn;
  nativeRequestHeadersForVideo(videoUrl: string, pageUrl: string): Promise<RequestHeader[]>;
  /**
   * The one place a raw host `percent` becomes the job's visible `percent`.
   *
   * `nextStage` is the stage the *incoming* message claims, which is not yet on the
   * job — `download/native.ts` sets both in one patch. D7 resets the monotonic
   * baseline when it differs from the job's current stage, so the wrapper needs to
   * see both. Optional: the browser-download path (`download/browser.ts`) never
   * changes `stage` mid-transfer and passes nothing.
   */
  normalizeDownloadProgress(jobId: string, percent: unknown, nextStage?: unknown): number | null;
  normalizeUrl(url: string): string;
  notifyPopup: NotifyPopup;
  pageFallbackVideoForSource(video: VideoRecord, attemptedUrls: Set<string>): VideoRecord | null;
  persistDownloads(): Promise<unknown>;
  persistSettings(): Promise<unknown>;
  progressDetailPatchFromMessage(message: NativeResponse): JobPatch;
  resetDownloadProgressDetails(): JobPatch;
  setDownloadsById(downloads: Record<string, DownloadJobRecord>): void;
  setSettings(settings: BackgroundSettings): void;
  titleFromUrl(url: string): string;
  updateDownload(jobId: string, patch: JobPatch): void;
  userAgent(): string;
  userFriendlyDownloadError(error: unknown): string;
  variantsForVideo(video: VideoRecord): VideoRecord[];
  /**
   * The slice of `shared/video_filters.ts` the download layer calls. Narrowed
   * rather than typed as the whole namespace so a signature change upstream does
   * not ripple into every `deps` consumer.
   */
  videoFilters: {
    isBlockedVideoUrl(url: string, contentType?: string): boolean;
  };
  /**
   * Patched in by `download/index.ts` once the core flow is defined. Until then it
   * holds a throwing placeholder — `createOperations` only reads it lazily, inside
   * resume/retry, which never run before `download/index.ts` has rewritten it.
   */
  startNativeDownloadFromVideo(
    tabId: TabId,
    video: VideoRecord,
    formatId: string,
    options: NativeDownloadOptions,
  ): Promise<DownloadStartResult>;
}

/** The background's own status cache, as `background_helper_ping.ts` keeps it. */
export type { BackgroundMessageType, HelperStatus };

/** The `videoFilters`-shaped helper `background.ts` injects into `header_utils`. */
export type BlockedUrlCheck = (url: string, contentType?: string) => boolean;

// ── The context `background.ts` hands the handler modules ─────────────────

/**
 * Everything `message-handlers/*` needs, assembled once by `background.ts`.
 *
 * Handlers take no imports of their own collaborators — they close over this — which
 * is what lets each one self-register into `message_router.ts`'s dispatch map without
 * importing the download pipeline it would otherwise cycle through.
 */
export interface BackgroundContext {
  // ── Tab / detection ──
  senderTabId(message: MessageOf<BackgroundMessageType>, sender: chrome.runtime.MessageSender): TabId;
  notifyPopup: NotifyPopup;
  getVisibleVideosForTab(tabId: TabId): VideoRecord[];
  addDetectedVideo(tabId: TabId, input: VideoInput, notify?: boolean): Promise<VideoRecord | null>;
  clearTab(tabId: TabId): Promise<void>;
  getTabVideos(tabId: TabId): Promise<VideoRecord[]>;
  getAllDownloadsSorted(): Promise<DownloadJobRecord[]>;
  setPageTitle(tabId: TabId, title: string): void;
  /**
   * The HLS frame-grab service (`hls-thumbnail-spec.md` §5), built once by
   * `background.ts`. Passed whole rather than its three functions, because they share the
   * budget counters and the frame cache — two callers sharing the object is what keeps one
   * budget.
   */
  thumbnailFrames: import("./thumbnail_frames.js").ThumbnailFrameService;

  // ── Download orchestration ──
  nativeRequest: NativeRequestFn;
  startNativeDownload(
    tabId: TabId,
    videoId: string,
    formatId?: string,
    variantId?: string,
    backend?: string,
  ): Promise<DownloadStartResult>;
  startNativeDownloadForUrl(tabId: TabId, input: VideoInput): Promise<DownloadStartResult>;
  getBestDownloadableVideo(tabId: TabId): Promise<VideoRecord>;
  startBestNativeDownload(tabId: TabId, formatId?: string, variantId?: string): Promise<DownloadStartResult>;
  downloadMany(tabId: TabId, videoIds: string[], formatId?: string): Promise<{ jobIds: string[] }>;
  controlActiveDownload(jobId: string, nativeType: string): { jobId: string };
  resumeDownload(tabId: TabId, jobId: string): Promise<DownloadStartResult>;
  cancelDownload(tabId: TabId, jobId: string): Promise<{ jobId: string }>;
  retryDownload(tabId: TabId, jobId: string): Promise<DownloadStartResult>;
  openDownloadedPath(jobId: string, nativeType: NativeFileCommand): Promise<{ jobId: string }>;
  chooseDownloadFolder(): Promise<FolderChoiceResult>;
  removeDownload(jobId: string): Promise<{ jobId: string }>;
  clearDownloads(): Promise<{ jobIds: string[]; downloads: DownloadJobRecord[] }>;

  // ── Injected modules ──
  downloadSync: typeof import("../shared/download_sync.js");
  tabState: typeof import("./tab_state.js");
  browserApi: typeof browserApi;
  /**
   * Narrowed to what the handlers actually read, not the whole namespace:
   * `message-handlers/download.ts` takes variant grouping off it and nothing else.
   * A `Pick` so a rename upstream is still a compile error here, and a new export in
   * `download_helpers.ts` does not silently widen what every handler can reach.
   */
  downloadHelpers: Pick<typeof import("./download_helpers.js"), "variantsForVideo" | "findGroupedVideoForVariant">;
  /** Same story: `getVideoFormats` / `getFormatsForUrl` / `getBestVideoFormats` are the only readers. */
  formatHelpers: Pick<typeof import("./format_helpers.js"), "getNativeFormatsForVideo">;

  // ── Helper ping ──
  // No `cachedHelperStatus`: it is a mutable `let` in `background_helper_ping.ts`, and
  // a context field can only ever hold one snapshot of it. Handlers that need the live
  // value import the binding. See native-helper-status-spec.md §2.5.
  HELPER_PING_INTERVAL_MS: number;
  refreshCachedHelperStatus(notifyPopup: NotifyPopup, hostName: string): Promise<void>;
  pingNativeHost(hostName: string): Promise<PingResult>;

  // ── Shared constants ──
  HOST_NAME: string;
}
