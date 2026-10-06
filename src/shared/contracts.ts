/**
 * The extension's message contract — every `message.type` string that crosses a
 * `runtime.sendMessage` / `tabs.sendMessage` boundary, and the payload shape that
 * travels with it.
 *
 * Extracted by reading every `messageRouter.handle(...)` call and every `sendMessage({...})`
 * call site, not by designing an ideal protocol. If a type is here it is one the code
 * actually sends today.
 *
 * Three directions, three unions, because they are consumed by three different layers and
 * conflating them would let the popup send a `downloadUpdated`:
 *
 * - {@link BackgroundMessage} — requests into the service worker (`message_router.js`).
 *   This is the union that becomes the handler registry's dispatch type in Phase 3.
 * - {@link PopupEvent} — broadcasts the background pushes at open popup windows.
 * - {@link ContentCommand} — messages the background/options send *into* a tab's content
 *   script, which dispatches them in a three-way `if/else` (`content.js`).
 *
 * Responses are deliberately not enumerated here. `message_router.js:80` normalizes every
 * handler result to `result || { ok: true}` and catches into `{ ok: false, error }`, so the
 * only thing worth typing is {@link ResponseEnvelope} itself; per-message response types
 * get added by whichever phase first needs to consume one structurally.
 */

/**
 * The envelope `message_router.js` guarantees on every response: a falsy handler result
 * becomes `{ ok: true }`, a thrown error becomes `{ ok: false, error }`. Handlers widen it
 * by spreading extra keys alongside `ok: true` (`{ ok: true, jobId }`), so this is the
 * base of a response, never the whole of one.
 */
export type ResponseEnvelope = { ok: true } | { ok: false; error: string };

// ── Domain records carried over the wire ────────────────────────────────────────
//
// Declared here rather than imported from `popup/state/*.ts` because `shared/` must never
// import from `popup/` — that inversion is the layering violation R11 in
// `shared/download_statuses.js` calls out. Phase 5 reconciles the popup's structural
// duplicates (`VideoCandidate`, `DownloadJob`) against these.

/**
 * A detected video as it travels between layers. Superset of the record
 * `background.js:addDetectedVideo` writes and the fields `content.js` detects with;
 * the extra optional keys are the enrichment that only some layers know about.
 */
export interface DetectedVideo {
  id: string;
  url?: string;
  title?: string;
  /** `classifyMediaUrl` / `classifyVideoUrl` result — `MP4`, `M3U8`, `YOUTUBE`, … */
  format?: string;
  /** `dom` | `network` | `overlay` | `manual-url` | `youtube-page` | … */
  source?: string;
  pageUrl?: string;
  frameUrl?: string;
  contentType?: string;
  downloadable?: boolean;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  bitrate?: number | null;
  tbr?: number | null;
  sizeBytes?: number | null;
  size?: string;
  thumbnailUrl?: string;
  /**
   * The content script's ordered thumbnail ladder for this candidate
   * (`thumbnail-spec.md` §3). `thumbnailUrl` is entry 0; the row advances through the
   * rest on `onError`. Absent on network-detected candidates, which is why the popup
   * can also build one from `thumbnailUrl` + `pageUrl` alone.
   */
  thumbnailCandidates?: string[];
  hasSubtitles?: boolean;
  subtitleLanguages?: number;
  firstSeen?: number;
  lastSeen?: number;
  /**
   * The playlist/album this row was enumerated from. `playlistId` is the group key:
   * all rows of one `enumeratePlaylist` share it, and the popup folds consecutive runs
   * of the same id into one collapsible folder. Absent on every other candidate.
   *
   * Deliberately NOT `groupId`. That field is live download-path state —
   * `download/native.ts` sends `videoId: video.groupId || video.id` and
   * `variantId: video.groupId ? video.id : ""` — so it names the primary candidate a
   * *variant* belongs to, and stamping a playlist id there sends the wrong ids to the
   * helper for every row of a playlist.
   */
  playlistId?: string;
  playlistTitle?: string;
  /** The folder's cover. Absent when the host could not resolve one (yt-dlp usually can). */
  playlistThumbnailUrl?: string;
  /** Set by `shared/video_sorting.js:buildGroupedVideo`; the popup's recency key. */
  groupId?: string;
  groupVariants?: DetectedVideo[];
  /** Backend override for a variant (`auto` | `native` | `browser`). */
  backend?: string;
  fallbackReason?: string;
  error?: string;
}

/**
 * A download job as the background broadcasts it. Structurally the popup's
 * `DownloadJob` (`popup/state/downloads.ts`), which owns the render-side copy.
 */
export interface DownloadJob {
  id: string;
  videoId?: string;
  tabId?: number;
  status?: string;
  percent?: number;
  rawPercent?: number;
  stage?: string;
  message?: string;
  error?: string;
  url?: string;
  title?: string;
  format?: string;
  formatId?: string;
  variantId?: string;
  backend?: string;
  filepath?: string;
  artifactRoot?: string;
  pageUrl?: string;
  /** Copied from the candidate when the job was created (`thumbnail-spec.md` §7.1). */
  thumbnailUrl?: string;
  fragment?: string;
  speed?: string;
  eta?: string;
  totalSize?: string;
  downloadedSize?: string;
  connections?: number | string;
  /**
   * `true` means `percent` is an **estimate**, not a measurement — spec D2/D9
   * (`real-progress-spec.md` §4.1).
   *
   * Absent/false is exact. Segmented manifests usually carry no `Content-Length`,
   * so the backends that count fragments or extrapolate from a byte rate say so
   * here, and `ProgressBar` marks it (`~`, and in `aria-valuetext`). The UI cannot
   * infer honesty from the number alone — 42% from a fragment count and 42% from a
   * `Content-Length` are the same two digits and not the same claim.
   *
   * **The popup's copy in `popup/state/downloads.ts` must stay in sync with this
   * one.** They are structurally duplicated by design (see the note above) and a
   * field that exists in only one of them is a field the other layer silently drops.
   */
  percentApproximate?: boolean;
  rawProgressLine?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** `storage.local["qwinSettings"]` — see `background/tab_state.js` defaults. */
export interface Settings {
  downloadFolder: string;
  musicMode: boolean;
  audioFormat: string;
  downloadSyncEnabled: boolean;
  overlayEnabled: boolean;
  /**
   * Popup width in px, spec D5. Bounded 400–720 by `ui/motion.ts`'s
   * `POPUP_MIN_WIDTH`/`POPUP_MAX_WIDTH`; those constants are the contract, this field
   * only carries the committed value. It lives here rather than in its own storage key
   * because `background/tab_state.persistSettings` rewrites `qwinSettings` from the
   * worker's in-memory object — a direct `storage.local` write would be erased by the
   * next settings save from any surface.
   */
  popupWidth: number;
  /**
   * `system` | `light` | `dark`, spec D6. Drives `document.documentElement.dataset.theme`;
   * absent means System, which `theme.css`'s `prefers-color-scheme` block handles on its
   * own. Defaults to `system`.
   */
  theme: ThemeMode;
}

/** Spec D6. `system` is the default and is represented by *not* pinning the attribute. */
export type ThemeMode = "system" | "light" | "dark";

/** Cached native-helper probe result; see `background/background_helper_ping.ts`. */
export interface HelperStatus {
  /**
   * `null` until a probe has answered — **not** `false`.
   *
   * `false` means a probe ran and the helper was unreachable; `null` means no probe
   * has answered yet. `dependencies` is `{}` in *both* cases, and `isMissing()` reads
   * an absent key as missing, so rendering `null` as `false` reports every tool as
   * absent during the ~0.4-3.5s a cold native ping takes. The popup has always had
   * this third state (`popup/state/app.ts`); Options did not, and showed a confident
   * "Not connected / all five missing" while the probe was still in flight. See
   * `native-helper-status-spec.md` §2.1-2.2.
   */
  connected: boolean | null;
  version: string;
  dependencies: Record<string, unknown>;
  lastChecked: number;
  error: string;
}

/**
 * One row of the cross-browser download history in `storage.sync`
 * (`shared/download_sync.js:createSyncedEntry`). Deliberately compact — 200 rows have to
 * fit storage.sync's ~100KB quota.
 */
export interface SyncedDownloadEntry {
  id: string;
  url: string;
  title: string;
  format: string;
  status: string;
  filepath: string;
  totalSize: string;
  sourceHost: string;
  createdAt: number;
  completedAt: number;
}

// ── Requests into the service worker ───────────────────────────────────────────
//
// Every `messageRouter.handle()` registration. `tabId` is optional throughout because
// `senderTabId(message, sender)` prefers the sender's tab and falls back to the message's —
// the content script omits it (`content_overlay.js` sends bare `{ type, video }`) while
// the popup always sets it.

export interface ContentDetectedVideosMessage {
  tabId?: number;
  videos: DetectedVideo[];
}

export interface GetVideosMessage {
  tabId?: number;
}

export interface RescanTabMessage {
  tabId?: number;
}

export interface ClearVideosMessage {
  tabId?: number;
}

export interface DownloadVideoMessage {
  tabId?: number;
  videoId: string;
  formatId?: string;
  variantId?: string;
  backend?: string;
}

export interface DownloadUrlMessage {
  tabId?: number;
  video?: Partial<DetectedVideo>;
  formatId?: string;
  variantId?: string;
}

export interface DownloadBestVideoMessage {
  tabId?: number;
  formatId?: string;
  variantId?: string;
}

/** A control verb naming an existing job — pause / resume / cancel / retry / open / show / remove. */
export interface JobCommandMessage {
  tabId?: number;
  jobId: string;
}

export interface ClearDownloadsMessage {
  tabId?: number;
}

export interface GetVideoFormatsMessage {
  tabId?: number;
  videoId: string;
}

export interface GetFormatsForUrlMessage {
  video?: Partial<DetectedVideo>;
}

/**
 * A playlist (or album) URL to expand. The background asks the helper for its items and
 * turns each into a tab-scoped video row, so the popup needs nothing but the URL.
 */
export interface EnumeratePlaylistMessage {
  url?: string;
}

/**
 * A batch of already-enumerated rows. `videoIds` is an ordered selection; the background
 * throttles the batch to a few at a time rather than firing one message per row.
 */
export interface DownloadManyMessage {
  videoIds?: string[];
  formatId?: string;
}

export interface SaveSettingsMessage {
  settings: Partial<Settings>;
}

export interface SetDownloadSyncEnabledMessage {
  /** `!== false` semantics — omitting it enables sync. */
  enabled?: boolean;
}

/**
 * The content script's CORS escape hatch (`background.js:378`): the service worker has
 * no CORS restrictions, so the content script proxies blocked media requests through it.
 */
/**
 * Ask the helper for one decoded frame of a stream (`hls-thumbnail-spec.md` §4.1).
 *
 * Fire-and-forget from the popup: the row already shows the correct glyph while the
 * grab runs, and the answer arrives as a `videoListUpdated` broadcast.
 */
export interface GrabThumbnailFrameMessage {
  tabId?: number;
  videoId: string;
}

/** One message for a whole visible list — misses are simply absent from `frames`. */
export interface ThumbnailFramesMessage {
  urls: string[];
}

export interface ProxyFetchMessage {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  includeCredentials?: boolean;
}

/**
 * A request with no payload. Still declared as its own type so the `BackgroundMessage`
 * union below stays a discriminated union rather than degenerating into `object`.
 */
export type EmptyMessage = Record<string, never>;

/**
 * Every `message.type` the background handles, as one array so the literal list is the
 * single source of truth — adding a type means adding an entry here and a handler.
 */
export const BACKGROUND_MESSAGE_TYPES = [
  // message-handlers/tab.js
  "contentDetectedVideos",
  "getVideos",
  "rescanTab",
  "clearVideos",
  // message-handlers/download.js
  "downloadVideo",
  "downloadUrl",
  "downloadBestVideo",
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "retryDownload",
  "openDownloadedFile",
  "showDownloadedFile",
  "removeDownload",
  "clearDownloads",
  "getVideoFormats",
  "getFormatsForUrl",
  "enumeratePlaylist",
  "downloadMany",
  "getBestVideoFormats",
  "chooseDownloadFolder",
  "getDownloadSyncHistory",
  "setDownloadSyncEnabled",
  "clearDownloadSyncHistory",
  // message-handlers/settings.js
  "saveSettings",
  "getSettings",
  "openPopup",
  "pingNativeHost",
  "getHelperStatus",
  // message-handlers/thumbnailFrame.js
  "grabThumbnailFrame",
  // message-handlers/thumbnailFrames.js
  "thumbnailFrames",
  // background.js
  "proxyFetch",
] as const;

export type BackgroundMessageType = (typeof BACKGROUND_MESSAGE_TYPES)[number];

/** The request union. Phase 3 dispatches on `.type` and gets a narrowed payload. */
export type BackgroundMessage =
  | ({ type: "contentDetectedVideos" } & ContentDetectedVideosMessage)
  | ({ type: "getVideos" } & GetVideosMessage)
  | ({ type: "rescanTab" } & RescanTabMessage)
  | ({ type: "clearVideos" } & ClearVideosMessage)
  | ({ type: "downloadVideo" } & DownloadVideoMessage)
  | ({ type: "downloadUrl" } & DownloadUrlMessage)
  | ({ type: "downloadBestVideo" } & DownloadBestVideoMessage)
  | ({ type: "pauseDownload" } & JobCommandMessage)
  | ({ type: "resumeDownload" } & JobCommandMessage)
  | ({ type: "cancelDownload" } & JobCommandMessage)
  | ({ type: "retryDownload" } & JobCommandMessage)
  | ({ type: "openDownloadedFile" } & JobCommandMessage)
  | ({ type: "showDownloadedFile" } & JobCommandMessage)
  | ({ type: "removeDownload" } & JobCommandMessage)
  | ({ type: "clearDownloads" } & ClearDownloadsMessage)
  | ({ type: "getVideoFormats" } & GetVideoFormatsMessage)
  | ({ type: "getFormatsForUrl" } & GetFormatsForUrlMessage)
  | ({ type: "enumeratePlaylist" } & EnumeratePlaylistMessage)
  | ({ type: "downloadMany" } & DownloadManyMessage)
  | ({ type: "getBestVideoFormats" } & EmptyMessage)
  | ({ type: "chooseDownloadFolder" } & EmptyMessage)
  | ({ type: "getDownloadSyncHistory" } & EmptyMessage)
  | ({ type: "setDownloadSyncEnabled" } & SetDownloadSyncEnabledMessage)
  | ({ type: "clearDownloadSyncHistory" } & EmptyMessage)
  | ({ type: "saveSettings" } & SaveSettingsMessage)
  | ({ type: "getSettings" } & EmptyMessage)
  | ({ type: "openPopup" } & EmptyMessage)
  | ({ type: "pingNativeHost" } & EmptyMessage)
  | ({ type: "getHelperStatus" } & EmptyMessage)
  | ({ type: "grabThumbnailFrame" } & GrabThumbnailFrameMessage)
  | ({ type: "thumbnailFrames" } & ThumbnailFramesMessage)
  | ({ type: "proxyFetch" } & ProxyFetchMessage);

// ── Broadcasts from the background to popup windows ────────────────────────────
//
// `notifyPopup()` calls `runtime.sendMessage` with no target, so every open popup
// receives these. Unguarded by tab on purpose — see `popup_background_events.js` for why
// `downloadRemoved` needs no `tabId` check.

export interface VideoListUpdatedEvent {
  type: "videoListUpdated";
  tabId: number;
  videos: DetectedVideo[];
}

export interface DownloadUpdatedEvent {
  type: "downloadUpdated";
  job: DownloadJob;
}

export interface DownloadRemovedEvent {
  type: "downloadRemoved";
  jobId: string;
}

/** Carries the surviving jobs so the popup replaces its list in one write. */
export interface DownloadsClearedEvent {
  type: "downloadsCleared";
  jobIds: string[];
  downloads: DownloadJob[];
}

export interface HelperStatusChangedEvent {
  type: "helperStatusChanged";
  status: HelperStatus;
}

export interface UpdateQualityLoadingStatusEvent {
  type: "updateQualityLoadingStatus";
  text: string;
}

export type PopupEvent =
  | VideoListUpdatedEvent
  | DownloadUpdatedEvent
  | DownloadRemovedEvent
  | DownloadsClearedEvent
  | HelperStatusChangedEvent
  | UpdateQualityLoadingStatusEvent;

// ── Commands sent into a tab's content script ──────────────────────────────────
//
// Dispatched in `content.js`'s `runtime.onMessage` three-way `if/else`. `scanNow` is the
// only one that answers — it returns `{ ok: true, videos }` synchronously so the
// background's `rescanTab` handler can await `tabs.sendMessage` and get populated data.

export interface ScanNowCommand {
  type: "scanNow";
}

export interface UpdateLoadingStatusCommand {
  type: "updateLoadingStatus";
  text: string;
}

/** `!== false` semantics — omitting `enabled` turns the overlay on. */
export interface SetOverlayEnabledCommand {
  type: "setOverlayEnabled";
  enabled?: boolean;
}

/**
 * Re-attempt frame captures on every `<video>` that has a decoded frame now
 * (`hls-thumbnail-spec.md` §3.2, H11).
 *
 * Sent straight from the popup into the tab — no background hop, because the content
 * script is the only thing that can draw. The backstop for a player that buffered
 * without firing a media event, and the only path that helps a muted-autoplay player
 * the user never pressed play on.
 */
export interface RescanForFramesCommand {
  type: "rescanForFrames";
}

export type ContentCommand =
  | ScanNowCommand
  | UpdateLoadingStatusCommand
  | SetOverlayEnabledCommand
  | RescanForFramesCommand;
