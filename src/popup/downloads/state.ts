/**
 * `downloads.html` state - the full searchable history (spec §7, D15).
 *
 * Two storage sources, deliberately read the way each one is actually written:
 *
 *   - **Active jobs** come from `storage.local` under `qwinDownloadsById`, the key
 *     `background/tab_state.js:9` persists them to as an id-keyed object, and stay
 *     live through the `downloadUpdated` / `downloadRemoved` / `downloadsCleared`
 *     runtime broadcasts the background sends with `notifyPopup`
 *     (`background/background.js:87`).
 *   - **Completed history** comes from `storage.sync` under `qwinDownloadHistory`,
 *     reached through `getDownloadSyncHistory()` because that message also returns
 *     `syncInfo`, which the page needs to tell "paused" from "empty".
 *
 * Both keys were read off the code that writes them, not assumed - see the two
 * constants below and `tests/js/downloads/downloads_state.test.ts`, which asserts the
 * page asks for exactly these.
 *
 * ## Why one `DownloadRecord` type
 *
 * A job and a synced entry are two shapes with four fields in common, and every
 * consumer of this page (row, facet list, day grouping, keyboard navigation) wants
 * them as one list. The old page kept them as two parallel arrays and rendered two
 * different rows; §7 replaces that with one history grouped by day, so they are
 * normalised once, here, rather than in the component.
 */
import { computed, signal } from "@preact/signals";

import { browserApi } from "../../shared/browser_api.js";
import type { ThemeMode } from "../../shared/contracts.js";
import { isActiveDownload } from "../../shared/download_statuses.js";
import * as PopupApi from "../../shared/popup_api.js";
import {
  DEFAULT_FILTER,
  facetValues,
  filterAndSort,
  sourceHostOf,
  type FilterableItem,
  type FilterState,
} from "../../ui/filter.js";
import { displayFormat, formatSize, videoThumbnailUrl, videoTitle } from "../../ui/format.js";
import { deriveSiteThumbnail } from "../../ui/thumbnail_sources.js";
import { applyJobUpdate, type DownloadJob } from "../state/downloads.js";
import type { SyncEntry } from "../state/filters.js";

/** `storage.local` key for the id-keyed job map. Written by `background/tab_state.js`. */
export const DOWNLOADS_STORAGE_KEY = "qwinDownloadsById";

/** `storage.local` key the background persists settings to. Read for `theme` (spec D6). */
export const SETTINGS_STORAGE_KEY = "qwinSettings";

export const jobs = signal<DownloadJob[]>([]);
export const history = signal<SyncEntry[]>([]);
export const syncEnabled = signal(true);
export const filter = signal<FilterState>({ ...DEFAULT_FILTER });
export const loaded = signal(false);
/** Transient line under the toolbar: what a bulk action did, or why it did nothing. */
export const notice = signal("");
export const noticeIsError = signal(false);
/** The persisted theme choice (spec D6). Absent + `prefers-color-scheme` is System. */
export const theme = signal<ThemeMode>("system");

/**
 * The `qwinSettings` fields a row reads but this page owns no control for - the same
 * partial-form shape `popup/state/app.ts:settings` holds for the tray.
 *
 * `downloadFolder` is the whole reason: `downloadActions` offers a finished job a Folder
 * button with no `filepath` behind it *only* when it is handed a destination
 * (`download_status.ts:336`). This page called `downloadActions(job)` with one argument,
 * so that branch was unreachable here and a terminal row got Redownload + Remove and
 * nothing else - no Open, no Folder, whatever it was downloading.
 */
export const settings = signal<{ downloadFolder?: string }>({});

/**
 * Frames the helper already holds for these URLs (hls-thumbnail-spec.md §5.3).
 *
 * H7: service-worker memory only. Nothing here is ever written to `storage.sync` — a
 * base64 JPEG per row would blow the ~100 KB sync budget in a dozen entries — so these
 * are recomputed on demand and lost on eviction. `records` is a `computed`, so filling
 * this re-derives the rows for free.
 */
export const framesByUrl = signal<Record<string, string>>({});

/** The jobs surviving the filter, sorted. The bulk reveal picks its target from here. */
export const visibleJobs = computed<DownloadJob[]>(() => filterAndSort(jobs.value, filter.value));

/** Jobs whose status is terminal but not `done` - the "retry all failed" target set. */
export const failedJobs = computed<DownloadJob[]>(() => jobs.value.filter((job) => job.status === "error"));

/**
 * A job and a synced entry as one row.
 *
 * `FilterableItem` is extended rather than replaced so `filterAndSort` accepts the
 * result unchanged - the facet rules (`ui/filter.ts`) are the same rules for both
 * sources, and re-implementing them per source is the duplication §7 removes.
 */
export interface DownloadRecord extends FilterableItem {
  /** Stable within a render pass. A job's own id, or a synthetic key for a synced entry. */
  key: string;
  title: string;
  url: string;
  sourceHost: string;
  format: string;
  status: string;
  /** Pre-formatted size, or "" when neither source knows it. */
  size: string;
  /** Epoch ms used for both sorting and the day group. 0 = unknown. */
  updatedAt: number;
  thumbnailUrl: string;
  /** Present only for a live job. A synced entry has no file on record, so no Open/Reveal. */
  job?: DownloadJob;
  /** Still moving: renders the progress line and the lifecycle actions. */
  live: boolean;
}

/**
 * The row's art: a cached frame if the helper has one, else what the URL implies.
 *
 * A job's own `thumbnailUrl` still wins — it is real published art, where a frame is a
 * grab of the stream — so the frame only fills the gap the ladder cannot.
 */
function thumbnailFor(url: string): string {
  return framesByUrl.value[url] || deriveSiteThumbnail(url);
}

function fromJob(job: DownloadJob): DownloadRecord {
  return {
    key: job.id,
    title: videoTitle(job),
    url: job.url || "",
    sourceHost: sourceHostOf(job),
    format: displayFormat(job),
    status: job.status || "queued",
    size: formatSize(job.totalSize),
    updatedAt: Number(job.updatedAt) || 0,
    thumbnailUrl: videoThumbnailUrl(job) || thumbnailFor(job.url || ""),
    job,
    live: isActiveDownload(job),
  };
}

function fromSync(entry: SyncEntry, index: number): DownloadRecord {
  return {
    // ponytail: no id crosses storage.sync for a synced entry, so the key borrows the
    // array index. The synced list is append-and-clear, never reordered, so the index
    // is stable for as long as the row exists. A real id belongs in
    // `shared/download_sync.js`, which is out of this page's scope.
    key: `synced:${index}|${entry.url || ""}`,
    title: entry.title || "Unknown download",
    url: entry.url || "",
    sourceHost: sourceHostOf(entry),
    format: displayFormat(entry),
    status: entry.status || "done",
    size: formatSize(entry.totalSize),
    updatedAt: Number(entry.completedAt) || 0,
    // A synced entry persists `url` and nothing else (D6 — `storage.sync` is 100KB total,
    // and there is deliberately no schema change for this), so the only thumbnail context
    // left is what that one URL implies. A `youtube.com/watch?v=…` or `youtu.be/…` entry
    // gets its row's art. A direct `.mp4` / `.m3u8` entry has no page left to derive
    // from — that used to be the accepted cost of D6, and it was true by *derivation*
    // only. It is not true any more (hls-thumbnail-spec.md §1.3): the ladder is closed
    // by asking the helper for one frame of the stream, so `thumbnailFor` prefers a
    // cached frame and the row falls back to the glyph only on a miss.
    thumbnailUrl: thumbnailFor(entry.url || ""),
    live: false,
  };
}

/**
 * Both sources as one list, newest first.
 *
 * A synced entry whose URL matches a job is dropped: the job row already carries it
 * *and* can act on it, so keeping both showed the same file twice and made the
 * per-row actions (§7) look broken on one of the two copies. If the job is later
 * cleared, the entry comes back with it.
 */
export const records = computed<DownloadRecord[]>(() => {
  const live = jobs.value;
  const seen = new Set(live.map((job) => job.url).filter(Boolean));
  const synced = history.value.filter((entry) => !seen.has(entry.url || ""));

  return [...live.map(fromJob), ...synced.map(fromSync)].sort((a, b) => b.updatedAt - a.updatedAt);
});

export const visibleRecords = computed<DownloadRecord[]>(() => filterAndSort(records.value, filter.value));

/** Day buckets in display order. "This week" is the trailing seven days, not a calendar week. */
export type DayKey = "today" | "yesterday" | "week" | "earlier";

export const DAY_ORDER: readonly DayKey[] = ["today", "yesterday", "week", "earlier"];

export const DAY_LABELS: Record<DayKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

/**
 * Which day bucket a timestamp belongs to.
 *
 * Boundaries are local midnights, not rolling 24-hour windows: "Yesterday" means the
 * calendar day before this one, which is what a person reading a history means by it.
 * An undated entry (0) is `earlier` rather than today - it has no day to belong to.
 */
export function dayKeyOf(when: number): DayKey {
  const stamp = Number(when) || 0;
  if (stamp <= 0) {
    return "earlier";
  }
  const today = startOfToday();
  if (stamp >= today) {
    return "today";
  }
  if (stamp >= today - DAY_MS) {
    return "yesterday";
  }
  return stamp >= today - 7 * DAY_MS ? "week" : "earlier";
}

export interface DownloadGroup {
  key: DayKey;
  label: string;
  records: DownloadRecord[];
}

/** The filtered rows bucketed by day, in `DAY_ORDER`, empty buckets omitted. */
export const groups = computed<DownloadGroup[]>(() => {
  const buckets = new Map<DayKey, DownloadRecord[]>();
  for (const record of visibleRecords.value) {
    const key = dayKeyOf(record.updatedAt);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(record);
    } else {
      buckets.set(key, [record]);
    }
  }

  return DAY_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    label: DAY_LABELS[key],
    records: buckets.get(key) || [],
  }));
});

/** What the three facet popovers offer, from the unfiltered set (spec §7). */
export const facets = computed<{ status: string[]; format: string[]; source: string[] }>(() => ({
  status: facetValues(records.value, (record) => record.status || ""),
  format: facetValues(records.value, (record) => record.format || ""),
  source: facetValues(records.value, (record) => record.sourceHost || ""),
}));

/** A completed job that has a file on disk, newest first: what the bulk reveal acts on. */
export const newestSaved = computed<DownloadJob | null>(
  () => visibleJobs.value.find((job) => Boolean(job.filepath)) || null,
);

function report(text: string, isError = false) {
  notice.value = text;
  noticeIsError.value = isError;
}

function toJobs(stored: unknown): DownloadJob[] {
  if (!stored || typeof stored !== "object") {
    return [];
  }
  return Object.values(stored as Record<string, DownloadJob>).filter((job) => job && typeof job.id === "string");
}

/**
 * `popup_api.js` types every response as a bare `Object`, so the properties this page
 * reads are invisible to the checker. One cast, here, beats repeating it at every call
 * site.
 */
function asRecord(response: unknown): Record<string, any> {
  return (response || {}) as Record<string, any>;
}

/** Re-read `qwinDownloadsById`. Called on load and after any bulk action. */
export async function loadJobs(): Promise<void> {
  const stored = await browserApi.storage.get(DOWNLOADS_STORAGE_KEY);
  jobs.value = toJobs(stored ? stored[DOWNLOADS_STORAGE_KEY] : null);
}

/** Re-read synced history through the message that also returns `syncInfo`. */
export async function loadHistory(): Promise<void> {
  const response = asRecord(await PopupApi.getDownloadSyncHistory());
  if (!response.ok) {
    return;
  }
  history.value = Array.isArray(response.history) ? (response.history as SyncEntry[]) : [];
  syncEnabled.value = Boolean(asRecord(response.syncInfo).syncEnabled !== false);
}

/**
 * How many URLs one `thumbnailFrames` lookup may carry.
 *
 * ponytail: the background's by-URL map is trimmed to 64 entries anyway, so anything
 * past that could never come back — and the page can hold 200 rows, and a message per
 * row (or a 200-entry one) is the thing §5.3 explicitly rules out. A miss is not a
 * failure: the row keeps its glyph.
 */
const FRAME_LOOKUP_LIMIT = 64;

/**
 * One `thumbnailFrames` message for the whole list (§5.3).
 *
 * Only URLs whose derived art is empty are asked about — a YouTube row already has its
 * thumbnail and a frame would be a wasted ffmpeg spawn. Not awaited by anything that
 * paints: the rows render their glyphs immediately and the signal write re-derives them.
 */
async function loadFrames(): Promise<void> {
  const wanted = new Set<string>();
  for (const item of records.value) {
    const url = item.url || "";
    if (url && !item.thumbnailUrl) {
      wanted.add(url);
    }
    if (wanted.size >= FRAME_LOOKUP_LIMIT) {
      break;
    }
  }

  const urls = [...wanted];
  if (!urls.length) {
    return;
  }

  const response = asRecord(await PopupApi.thumbnailFrames(urls));
  const frames = asRecord(response.frames);
  if (!response.ok || !frames) {
    return;
  }
  // Merged, not replaced: the map outlives one load, and a later `loadJobs` must not
  // blank an earlier batch's frames.
  framesByUrl.value = { ...framesByUrl.value, ...frames };
}

export async function loadAll(): Promise<void> {
  await Promise.all([loadJobs(), loadHistory()]);
  // After the two loads, since it reads the derived rows to decide what to ask about.
  void loadFrames();
  loaded.value = true;
}

/**
 * Follow the background's broadcasts.
 *
 * `downloadUpdated` is merged in place for the same reason the popup's list is: a
 * progress tick must not reorder rows under the cursor. `downloadsCleared` carries
 * the whole surviving map, so it replaces rather than merges.
 *
 * @returns a disposer, so a test can unlisten.
 */
export function watchUpdates(): () => void {
  const handler = (message: { type?: string; job?: DownloadJob; jobId?: string; downloads?: DownloadJob[] }) => {
    if (!message) {
      return;
    }
    if (message.type === "downloadUpdated" && message.job) {
      jobs.value = applyJobUpdate(jobs.value, message.job);
      return;
    }
    if (message.type === "downloadRemoved" && message.jobId) {
      jobs.value = jobs.value.filter((job) => job.id !== message.jobId);
      return;
    }
    if (message.type === "downloadsCleared" && Array.isArray(message.downloads)) {
      jobs.value = message.downloads;
    }
  };

  browserApi.onMessage(handler);
  return () => {
    const api = browserApi.raw && browserApi.raw.runtime && browserApi.raw.runtime.onMessage;
    if (api && typeof api.removeListener === "function") {
      api.removeListener(handler);
    }
  };
}

// -- Theme (spec §7 / D6)

/**
 * `data-theme` is the whole mechanism (spec D6): absent means System, and
 * `theme.css`'s `prefers-color-scheme` block handles that case on its own. This page
 * needs the attribute set at boot because it is a separate document from the popup -
 * without it a Windows user's OS-dark popup renders next to an OS-light history page.
 */
function applyThemeToDocument(mode: ThemeMode): void {
  const root = globalThis.document && globalThis.document.documentElement;
  if (!root) {
    return;
  }
  if (mode === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = mode;
  }
}

function asThemeMode(value: unknown): ThemeMode {
  const text = String(value || "");
  return text === "light" || text === "dark" ? text : "system";
}

/** Read the persisted settings - the theme (spec D6) and the download folder - before the first paint settles. */
export async function loadTheme(): Promise<void> {
  const stored = await browserApi.storage.get(SETTINGS_STORAGE_KEY);
  const persisted = (stored ? stored[SETTINGS_STORAGE_KEY] : null) as {
    theme?: unknown;
    downloadFolder?: unknown;
  } | null;
  theme.value = asThemeMode(persisted && persisted.theme);
  settings.value = { downloadFolder: String((persisted && persisted.downloadFolder) || "") };
  applyThemeToDocument(theme.value);
}

/**
 * Apply and persist. Goes through `saveSettings` rather than a direct
 * `storage.local` write because `tab_state.persistSettings` rewrites `qwinSettings`
 * from the worker's in-memory object - a direct write is erased by the next settings
 * save from any surface (the same reason `Settings.popupWidth` lives there).
 */
export async function setTheme(mode: ThemeMode): Promise<void> {
  theme.value = mode;
  applyThemeToDocument(mode);
  const response = asRecord(await PopupApi.saveSettings({ theme: mode }));
  if (!response.ok) {
    report(response.error || "Could not save the theme.", true);
  }
}

/** Follow settings changes made in the popup or on the options page while this tab is open. */
export function watchTheme(): () => void {
  const onChanged = browserApi.raw && browserApi.raw.storage && browserApi.raw.storage.onChanged;
  if (!onChanged || typeof onChanged.addListener !== "function") {
    return () => {};
  }

  const handler = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
    if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
      return;
    }
    const next = changes[SETTINGS_STORAGE_KEY].newValue as { theme?: unknown; downloadFolder?: unknown } | undefined;
    theme.value = asThemeMode(next && next.theme);
    settings.value = { downloadFolder: String((next && next.downloadFolder) || "") };
    applyThemeToDocument(theme.value);
  };

  onChanged.addListener(handler);
  return () => onChanged.removeListener(handler);
}

// -- Row + bulk actions

/**
 * Run one row action.
 *
 * `resume` / `cancel` / `retry` resolve the tab through `senderTabId`
 * (`background/background.js:233`), which falls back to `sender.tab.id` - and an
 * extension page has no sender tab, so the job's own `tabId` must be passed or the
 * background gets `undefined`. The other five actions ignore the tab entirely.
 *
 * @returns "" on success, otherwise the message to show.
 */
export async function runJobAction(action: string, job: DownloadJob): Promise<string> {
  const tabId = typeof job.tabId === "number" ? job.tabId : -1;
  let response: Record<string, any> | null = null;

  switch (action) {
    case "pause":
      response = asRecord(await PopupApi.pauseDownload(tabId, job.id));
      break;
    case "resume":
      response = asRecord(await PopupApi.resumeDownload(tabId, job.id));
      break;
    case "cancel":
      response = asRecord(await PopupApi.cancelDownload(tabId, job.id));
      break;
    case "retry":
      response = asRecord(await PopupApi.retryDownload(tabId, job.id));
      break;
    case "open-file":
      response = asRecord(await PopupApi.openDownloadedFile(tabId, job.id));
      break;
    case "show-folder":
      response = asRecord(await PopupApi.showDownloadedFile(tabId, job.id));
      break;
    // The same native verb as `open-file`: `os.startfile` on a directory opens the
    // folder, which is the whole point of the no-`filepath` fallback.
    case "open-folder":
      response = asRecord(await PopupApi.openDownloadedFile(tabId, job.id));
      break;
    case "remove":
      response = asRecord(await PopupApi.removeDownload(tabId, job.id));
      break;
    default:
      return "";
  }

  if (!response.ok) {
    return response.error || "That action failed.";
  }
  await loadJobs();
  return "";
}

/** Retry every failed job, one message per job - the background has no bulk retry. */
export async function retryAllFailed(): Promise<void> {
  const targets = failedJobs.value;
  if (!targets.length) {
    report("No failed downloads.");
    return;
  }

  let failed = 0;
  for (const job of targets) {
    const message = await runJobAction("retry", job);
    if (message) {
      failed += 1;
    }
  }
  report(
    failed
      ? `${targets.length - failed} of ${targets.length} retried; ${failed} failed.`
      : `Retried ${targets.length}.`,
  );
}

/**
 * Drop everything this page can show: finished jobs *and* the synced history behind
 * them.
 *
 * `clearDownloads` alone is not enough. It deletes only non-active jobs and keeps the
 * running ones (`background/download_operations.ts:246`), while `records` re-adds every
 * synced entry whose URL the job list no longer carries - so clearing jobs on its own
 * empties the list for one tick and then the history comes back. The durable half lives
 * in `storage.sync` and is cleared by `clearDownloadSyncHistory`, the same message
 * Options' "Clear history" sends.
 */
export async function clearAll(): Promise<void> {
  // `-1` is a placeholder tab id: the `clearDownloads` handler takes no tab and
  // clears the whole map, so nothing reads it.
  const clearedJobs = asRecord(await PopupApi.clearDownloads(-1));
  if (!clearedJobs.ok) {
    report(clearedJobs.error || "Could not clear finished downloads.", true);
    return;
  }
  const clearedHistory = asRecord(await PopupApi.clearDownloadSyncHistory());
  if (!clearedHistory.ok) {
    report(clearedHistory.error || "Could not clear download history.", true);
    return;
  }
  await Promise.all([loadJobs(), loadHistory()]);
  report("Cleared downloads and history.");
}

/**
 * Open one row's saved file (`openFile`).
 *
 * §7's defect was never the wire message - `openDownloadedFile` has always taken a
 * `jobId`. Only the UI restricted it to the newest row; this is the same call with the
 * row's own id.
 */
export async function openRecord(record: DownloadRecord): Promise<void> {
  const job = record.job;
  if (!job) {
    report("That entry has no saved file on record.", true);
    return;
  }
  const message = await runJobAction("open-file", job);
  report(message || "Opened.", Boolean(message));
}

/** Reveal one row's saved file in Explorer - same target, the `showFile` native verb. */
export async function revealRecord(record: DownloadRecord): Promise<void> {
  const job = record.job;
  if (!job) {
    report("That entry has no saved file on record.", true);
    return;
  }
  const message = await runJobAction("show-folder", job);
  report(message || "Revealed in Explorer.", Boolean(message));
}

/**
 * The bulk bar's reveal: the newest saved file in the current filter.
 *
 * ponytail: there is no "open the download folder" message. The native host speaks
 * `openFile` / `showFile` / `chooseFolder` only, and `chooseFolder` is a picker, not an
 * "open" verb - so a bulk "Open folder" button would have been a second name for this
 * one. Add a real `openFolder` verb to the host if the distinction earns it.
 */
export async function revealNewestSaved(): Promise<void> {
  const job = newestSaved.value;
  if (!job) {
    report("No saved file in the current filter.", true);
    return;
  }
  const message = await runJobAction("show-folder", job);
  report(message || "Revealed in Explorer.", Boolean(message));
}
