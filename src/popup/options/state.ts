/**
 * Options page state (spec §8).
 *
 * Everything here persists through `saveSettings`, which the background merges onto
 * its in-memory settings and writes to `storage.local` under `qwinSettings`
 * (`background/tab_state.js:8,67`). That was read off the code rather than assumed -
 * the key is *local*, not `sync`, so Options is per-browser and not carried to a
 * signed-in profile.
 *
 * That merge is also why nothing here writes `storage.local` directly:
 * `tab_state.persistSettings` rewrites `qwinSettings` from the worker's in-memory
 * object, so a hand-rolled write is erased by the next settings save from any surface
 * - including the popup's own theme control.
 *
 * Two settings the spec flagged are deliberately absent: `autoDownload` and
 * `maxConcurrentDownloads`. They were deleted from `tab_state.js` in Phase 1 and
 * `rg` over the tree now matches nothing but the spec text, so there is nothing for a
 * toggle to write. A control that changes nothing is worse than no control, so they
 * stay gone.
 *
 * `getSettings` has no wrapper in `popup_api.js` and adding one would change the
 * frozen 24-export contract, so it goes through the module's existing generic
 * `runtimeMessage()`. The handler already exists - no new message type.
 */
import { signal } from "@preact/signals";

import { browserApi } from "../../shared/browser_api.js";
import type { HelperStatus, Settings as ContractSettings, ThemeMode } from "../../shared/contracts.js";
import { CACHE_KEY_PREFIX, FILTER_LISTS } from "../../shared/filter_list_config.js";
import * as PopupApi from "../../shared/popup_api.js";

/** `storage.local` key the background persists settings to. */
export const SETTINGS_STORAGE_KEY = "qwinSettings";

/** Audio container values `host.py` and the native helper both accept. */
export const AUDIO_FORMATS = ["mp3", "m4a", "flac", "opus", "wav", "aac", "ogg"] as const;

/** The tools the native helper reports on. Shared with the popup's banner. */
export { HELPER_DEPENDENCIES, isMissing } from "../../shared/helper_dependencies.js";

export const INSTALL_COMMAND = "scripts/install.sh";

/** How long a confirmation stays fully opaque before its crossfade (spec §8). */
const NOTE_FADE_MS = 2000;

export type { HelperStatus, ThemeMode };

/**
 * `contracts.ts`'s `Settings`, restricted to the keys this page reads and writes.
 *
 * `musicMode` is excluded on purpose: the popup's Media toggle owns that flag, Options
 * neither shows nor writes it, and `options_state.test.ts` pins the shape. A blanket
 * re-export would make every reader carry a field it never uses.
 *
 * `theme` is optional here even though `contracts.ts` declares it required, because
 * the contract's own comment says an absent value means System - and `tab_state.ts`
 * supplies `"system"` as an in-memory default rather than as stored data, so a profile
 * that has never saved a theme has no `theme` key at all. Optional is what the storage
 * layer actually looks like; `loadSettings` fills it in and every read defaults it.
 */
export type Settings = Pick<
  ContractSettings,
  "downloadFolder" | "audioFormat" | "overlayEnabled" | "downloadSyncEnabled"
> & {
  /** Spec D6. Absent means System. */
  theme?: ThemeMode;
  /**
   * The popup's size threshold (spec §6.7), persisted so it is the *default* rather
   * than a per-visit value. `null` is "Any" - not "0 bytes" - so an unknown-size
   * candidate still passes, which is why the Meter has a null stop.
   *
   * Not in `contracts.ts`: `null` is not expressible as a stored number without
   * conflating "no filter" with "zero bytes", and the shared record may not be edited
   * in this phase. `saveSettings` merges arbitrary keys, so the value round-trips
   * through `qwinSettings` unchanged.
   */
  minSizeBytes?: number | null;
  /**
   * Subtitle default (spec §8). `!== false` semantics, matching
   * `background/types.ts:128`: the helper downloads subtitles unless told not to.
   * Optional for the same reason it is optional there - the key is absent until written.
   */
  downloadSubtitles?: boolean;
};

export interface FilterListRow {
  key: string;
  label: string;
  url: string;
  expectedSize: string;
  refreshDays: number;
  /** 0 when never fetched; otherwise the `fetchedAt` the cache recorded. */
  fetchedAt: number;
}

/** One `FILTER_LISTS` entry before the cache age is folded in. */
type FilterListEntry = Omit<FilterListRow, "fetchedAt">;

export const settings = signal<Settings>({
  downloadFolder: "",
  audioFormat: "mp3",
  overlayEnabled: true,
  downloadSyncEnabled: true,
});

export const helper = signal<HelperStatus>({
  // `null`, not `false` (spec D6). "No probe has answered yet" is a different fact from
  // "a probe ran and the helper was unreachable", and this default paints immediately:
  // `HelperSection` renders unconditionally, only the toolbar caption waits on `loaded`.
  // `false` here therefore showed a confident "Not connected" and five "missing" chips
  // for as long as the cold native ping took — 0.4s to 3.5s, spawning Python.
  // See native-helper-status-spec.md §2.1.
  connected: null,
  version: "",
  error: "",
  lastChecked: 0,
  dependencies: {},
});

export const filterLists = signal<FilterListRow[]>(
  FILTER_LISTS.map((list: FilterListEntry) => ({ ...list, fetchedAt: 0 })),
);

export const historyCount = signal(0);
export const loaded = signal(false);

/** The page search query. Read by every section, so it is state and not a prop. */
export const query = signal("");

/** One control's inline confirmation (spec §8). */
export interface SaveNote {
  /** The field it belongs beside - see the `field` passed to `report`. */
  field: string;
  text: string;
  error: boolean;
  /** False once the 2s window has elapsed and the 150ms crossfade has begun. */
  shown: boolean;
}

export const note = signal<SaveNote | null>(null);

let noteTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Report one control's outcome.
 *
 * This replaces the single page-level status line the page used to carry at its foot
 * (`OptionsPage.tsx:186-192` before the redesign): a confirmation the user has to look
 * away from the control they just changed in order to discover it worked is not a
 * confirmation. Keying by field is what puts the note next to the control.
 *
 * Errors deliberately do not fade. A message that vanishes before it has been read is
 * worse than no message, and this is the only signal in the module that a user has to
 * act on.
 */
function report(field: string, text: string, isError = false): void {
  note.value = { field, text, error: isError, shown: true };
  if (noteTimer !== undefined) {
    clearTimeout(noteTimer);
  }
  if (isError) {
    return;
  }
  noteTimer = setTimeout(() => {
    const current = note.value;
    if (current && current.field === field) {
      note.value = { ...current, shown: false };
    }
  }, NOTE_FADE_MS);
}

/**
 * `popup_api.js` types every response as a bare `Object`, so the properties this page
 * reads are invisible to the checker. One narrowing helper, here, beats repeating the
 * cast at every call site. The values stay `unknown` on purpose — every read below
 * wraps them in `String`/`Boolean`/`Number`, which is what the old untyped code did
 * implicitly.
 */
function asRecord(response: unknown): Record<string, unknown> {
  return response && typeof response === "object" ? (response as Record<string, unknown>) : {};
}

/** `errorText` keeps the "reply carried a message, otherwise say our own" shape. */
function errorText(response: Record<string, unknown>, fallback: string): string {
  return typeof response.error === "string" && response.error ? response.error : fallback;
}

/**
 * Point the page at one appearance.
 *
 * `"system"` is the *absence* of the attribute, never the string `"system"`: that is
 * the whole contract in `theme.css` (`spec D6`, `contracts.ts:136`). Writing
 * `data-theme="system"` would fall through neither selector and leave the page on the
 * `:root` light defaults with a dark OS, which is the bug the three-way control exists
 * to prevent.
 */
function applyTheme(mode: ThemeMode): void {
  if (mode === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }
}

/** Read the background's settings copy, which is the one that owns the defaults. */
export async function loadSettings(): Promise<void> {
  const stored = asRecord(asRecord(await PopupApi.runtimeMessage({ type: "getSettings" })).settings);
  const rawTheme = stored.theme;
  const mode: ThemeMode = rawTheme === "light" || rawTheme === "dark" ? rawTheme : "system";
  const size = stored.minSizeBytes;

  settings.value = {
    downloadFolder: String(stored.downloadFolder || ""),
    audioFormat: String(stored.audioFormat || "mp3"),
    overlayEnabled: stored.overlayEnabled !== false,
    downloadSyncEnabled: stored.downloadSyncEnabled !== false,
    theme: mode,
    minSizeBytes: typeof size === "number" ? size : null,
    downloadSubtitles: stored.downloadSubtitles !== false,
  };
  // Applied here rather than at the call site: `loadAll` is the only boot path, and a
  // second `applyTheme` in the page would be one more place the attribute can drift.
  applyTheme(mode);
}

export async function loadHelperStatus(): Promise<void> {
  const response = asRecord(await PopupApi.getHelperStatus());
  if (!response.ok) {
    helper.value = {
      connected: false,
      version: "",
      error: errorText(response, "The helper did not answer."),
      lastChecked: Date.now(),
      dependencies: {},
    };
    return;
  }
  helper.value = {
    // Read the field, do not coerce it: the background passes `connected: null` straight
    // through while no probe has answered (spec D6), and `Boolean(null)` would file that
    // as a checked failure — the same lie the default used to tell, one call later.
    connected: response.connected === null ? null : Boolean(response.connected),
    version: String(response.version || ""),
    error: String(response.error || ""),
    lastChecked: Number(response.lastChecked || Date.now()),
    dependencies: asRecord(response.dependencies),
  };
}

/**
 * When each filter list was last fetched.
 *
 * Read-only by design: `FILTER_LISTS` is a fixed six-entry table in
 * `shared/filter_list_config.js` with no enabled flag anywhere in the codebase and no
 * message handler that could set one, so there is nothing to toggle. Showing the
 * cache age is the honest version of a "sources" section.
 */
export async function loadFilterLists(): Promise<void> {
  const keys = FILTER_LISTS.map((list: FilterListEntry) => CACHE_KEY_PREFIX + list.key);
  const stored = await browserApi.storage.get(keys);

  filterLists.value = FILTER_LISTS.map((list: FilterListEntry) => {
    const entry = stored ? (stored as Record<string, { fetchedAt?: number }>)[CACHE_KEY_PREFIX + list.key] : null;
    return { ...list, fetchedAt: Number((entry && entry.fetchedAt) || 0) };
  });
}

export async function loadHistoryCount(): Promise<void> {
  const response = asRecord(await PopupApi.getDownloadSyncHistory());
  historyCount.value = response.ok ? Number(asRecord(response.syncInfo).totalCount || 0) : 0;
}

export async function loadAll(): Promise<void> {
  // `allSettled`, not `all`: one rejecting loader used to reject the whole array, so this
  // line never ran — the toolbar stayed on "Loading..." and every other signal stayed on
  // its pristine default, which is what put the reported panel on screen
  // (native-helper-status-spec.md §2.3).
  const loads: [label: string, run: () => Promise<void>][] = [
    ["settings", loadSettings],
    ["helper status", loadHelperStatus],
    ["filter lists", loadFilterLists],
    ["history count", loadHistoryCount],
  ];
  const results = await Promise.allSettled(loads.map(([, run]) => run()));
  loaded.value = true;
  results.forEach((result, index) => {
    if (result.status !== "rejected") {
      return;
    }
    const [label] = loads[index];
    console.warn(`[options] ${label} failed to load:`, result.reason);
    // `helper` is the one failure a note has an anchor for (`diagnostics.tsx:83`), and it
    // is the one the user can act on; the rest are developer-facing, hence the log.
    if (label === "helper status") {
      report("helper", "The helper did not answer.", true);
    }
  });
}

/**
 * Persist one setting.
 *
 * `saveSettings` merges rather than replaces (`tab_state.updateSettings`), so a single
 * field is a safe write and two pages cannot clobber each other's keys.
 */
export async function saveSetting(patch: Partial<Settings>): Promise<boolean> {
  const response = asRecord(await PopupApi.saveSettings(patch));
  if (!response.ok) {
    return false;
  }
  await loadSettings();
  return true;
}

/** Commit a field and put its confirmation beside it, or report why it did not save. */
async function commit(field: string, patch: Partial<Settings>, text: string): Promise<void> {
  const response = asRecord(await PopupApi.saveSettings(patch));
  if (!response.ok) {
    report(field, errorText(response, "Could not save that."), true);
    return;
  }
  await loadSettings();
  report(field, text);
}

/**
 * Set the appearance (spec D6).
 *
 * Applied to the live document *before* the write, so the page changes on the click
 * rather than after the round-trip — the same durable preference the popup's header
 * control writes, under the same `qwinSettings.theme` key, so the two agree after the
 * first save from either surface. On a failed write the attribute is put back, because
 * leaving the document in a state the stored settings do not describe is worse than a
 * failed save.
 */
export async function setTheme(mode: ThemeMode): Promise<void> {
  applyTheme(mode);
  if (!(await saveSetting({ theme: mode }))) {
    applyTheme(settings.value.theme ?? "system");
    report("theme", "Could not save the appearance.", true);
    return;
  }
  report("theme", mode === "system" ? "Following your system appearance." : `${mode} appearance.`);
}

/**
 * Toggle the in-page overlay.
 *
 * Saving is not enough: the overlay reads its flag when a page loads, so an open tab
 * would keep the old state until reload. The popup pushes `setOverlayEnabled` to the
 * active tab for the same reason - see `popup_url_events.js:33`.
 */
export async function setOverlayEnabled(enabled: boolean): Promise<void> {
  const response = asRecord(await PopupApi.saveSettings({ overlayEnabled: enabled }));
  if (!response.ok) {
    report("overlayEnabled", errorText(response, "Could not change the overlay."), true);
    return;
  }
  await loadSettings();
  report("overlayEnabled", enabled ? "Overlay enabled." : "Overlay hidden.");

  const tabs = await PopupApi.tabsQuery();
  const tabId = tabs && tabs[0] ? tabs[0].id : null;
  if (typeof tabId === "number") {
    await browserApi.tabs.sendMessage(tabId, { type: "setOverlayEnabled", enabled });
  }
}

/** Toggle cross-browser history sync. The handler persists the flag itself. */
export async function setSyncEnabled(enabled: boolean): Promise<void> {
  const response = asRecord(await PopupApi.setDownloadSyncEnabled(enabled));
  if (!response.ok) {
    report("downloadSyncEnabled", errorText(response, "Could not change sync."), true);
    return;
  }
  settings.value = { ...settings.value, downloadSyncEnabled: enabled };
  await loadHistoryCount();
  report("downloadSyncEnabled", enabled ? "History sync on." : "History sync paused.");
}

export async function clearHistory(): Promise<void> {
  const response = asRecord(await PopupApi.clearDownloadSyncHistory());
  if (!response.ok) {
    report("history", errorText(response, "Could not clear history."), true);
    return;
  }
  await loadHistoryCount();
  report("history", "Synced history cleared.");
}

/** Open the native folder picker. It persists `downloadFolder` on success itself. */
export async function chooseFolder(): Promise<void> {
  const response = asRecord(await PopupApi.chooseDownloadFolder());
  if (!response.ok) {
    report("downloadFolder", errorText(response, "Could not open the folder picker."), true);
    return;
  }
  if (response.canceled) {
    report("downloadFolder", "Folder selection canceled.");
    return;
  }
  await loadSettings();
  report("downloadFolder", "Download folder saved.");
}

/** Re-ping the native helper so the diagnostics reflect the current install. */
export async function recheckHelper(): Promise<void> {
  await loadHelperStatus();
  const connected = helper.value.connected;
  if (connected === null) {
    // A non-answer is not a failure, but it is not a success either, so it must not read
    // "Helper not connected." — the same claim the signal default used to make.
    report("helper", "The helper has not answered.", true);
    return;
  }
  report("helper", connected ? "Helper connected." : "Helper not connected.", !connected);
}

export async function copyInstallCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    report("install", "Copied. Run it from the Qwin project directory.");
  } catch (_error) {
    report("install", `Could not copy. Run ${INSTALL_COMMAND} from the Qwin project directory.`, true);
  }
}

export { commit };
