/**
 * Popup data flows (spec §5.1).
 *
 * This module used to also be the popup's chrome: `apply*` functions wrote
 * `className`/`hidden`/`dataset` onto `popup.html`'s static markup. That markup is
 * gone, so there is no DOM left here — every one of those writes is a signal
 * assignment now, and every reader is a component. What remains is the half that was
 * never chrome: which tab, what it found, whether the helper is alive, and the three
 * button flows (rescan / clear / refresh).
 *
 * `apply*` was split from `set*` because a render used to call the setters, so a render
 * mutated the store it rendered from. There is no render here any more.
 */
import { HELPER_DEPENDENCIES, isMissing } from "../shared/helper_dependencies.js";
import * as PopupApi from "../shared/popup_api.js";
import {
  activeTabId,
  activeTabUrl,
  helperStatus,
  rescanBusy,
  setMusicMode,
  setNotice,
  settings,
  theme,
} from "./state/app.js";
import { currentDownloads } from "./state/downloads.js";
import { DEFAULT_SYNC_INFO, syncedHistory, syncInfo } from "./state/filters.js";
import { currentVideos, setScanStatus } from "./state/videos.js";
import type { GetVideosResponse, HelperStatusResponse, PopupResponse, SyncHistoryResponse } from "./popup_state.js";

// ─── The extension boundary ─────────────────────────────────────────────────
//
// The reply shapes are declared in `popup_state.ts`, which `popup_actions.ts` and
// `popup_url_events.ts` read too. One note belongs here though: `activeTabId.value as
// number` is the one assertion used more than once, and only where `hasActiveTab()` has
// already returned in the same function — the signal is `number | null` because that is
// its *declared* initial state, but the guard makes null unreachable past that point.

// ─── Tab context ────────────────────────────────────────────────────────────

export function hasActiveTab(): boolean {
  return activeTabId.value !== null && activeTabId.value !== undefined;
}

export async function updateActiveTabContext(): Promise<boolean> {
  const tabs = await PopupApi.tabsQuery();
  const activeTab = tabs && tabs[0] ? tabs[0] : null;
  // `?? null` rather than a bare `.id`: a tab without an id is "no active tab" as far
  // as `hasActiveTab()` is concerned, and null is what the signal is declared to hold.
  const nextTabId = activeTab ? (activeTab.id ?? null) : null;
  const nextTabUrl = activeTab && typeof activeTab.url === "string" ? activeTab.url : "";
  const changed = activeTabId.value !== nextTabId || activeTabUrl.value !== nextTabUrl;

  activeTabId.value = nextTabId;
  activeTabUrl.value = nextTabUrl;
  return changed;
}

// ─── Main flows ─────────────────────────────────────────────────────────────

export async function refresh(options: { syncActiveTab?: boolean } = {}): Promise<boolean> {
  if (options.syncActiveTab !== false) {
    await updateActiveTabContext();
  }

  // Downloads are global, so they are read above the `hasActiveTab()` guard — otherwise a
  // popup opened with no window to query says "No downloads yet" while the machine is
  // busy. `-1` is the established "no tab" sentinel on this wire (`downloads.html`'s
  // bulk bar already sends it); `getVideos` tolerates it — the video half reads
  // `videosByTab["-1"]`, which is simply empty.
  const response = (await PopupApi.getVideos((activeTabId.value ?? -1) as number)) as GetVideosResponse | null;
  if (response && response.ok) {
    currentDownloads.value = response.downloads || [];
  }

  if (!hasActiveTab()) {
    return false;
  }

  setScanStatus("scanning");
  if (!response || !response.ok) {
    // A scan that cannot read the background is the `failed` case §6.10 designs for,
    // not a transient message: "Couldn't read this page" / "Retry scan".
    setScanStatus("failed", response && response.error ? response.error : "Could not read extension state.");
    setNotice(response && response.error ? response.error : "Could not read extension state.", true);
    return false;
  }

  currentVideos.value = response.videos || [];
  setScanStatus("ready");
  const syncEnabled = applySettings(response.settings);

  // `popup_api.ts` answers `MessageResult` (`any`) for every call, so this cast is the
  // only place the reply gets a real shape. It is the extension boundary; narrowing it
  // here beats repeating `as SyncHistoryResponse` at every `.then`.
  PopupApi.getDownloadSyncHistory()
    .then((syncResponse: SyncHistoryResponse) => {
      if (syncResponse && syncResponse.ok) {
        syncedHistory.value = syncResponse.history || [];
        syncInfo.value = syncResponse.syncInfo || { ...DEFAULT_SYNC_INFO, syncEnabled };
      }
    })
    .catch(function () {});
  return true;
}

/**
 * Take the background's settings copy and hand it to the components (spec §12).
 *
 * This replaces `applySettingsToForm`, whose entire body wrote settings onto hidden DOM
 * controls. Nothing in the tree reads them any more — the popup keeps `audioFormat`,
 * `backend` and `downloadSubtitles` as one object because the paste box still needs
 * `audioFormat` (D20) and the options page owns every editor.
 *
 * §12's mitigation names a hidden form in the *options* page as the home for the
 * mirrors. That turned out to be unnecessary: `options/state.ts` already reads all four
 * durable keys straight out of `getSettings` through its own signal and writes them
 * through `saveSetting`, so the mirrors had no second reader to move. See the hand-off
 * report.
 *
 * @returns whether cross-browser history sync is on, which the sync panel still wants.
 */
function applySettings(next: GetVideosResponse["settings"]): boolean {
  settings.value = { ...next };
  // `next !== undefined` rather than `Boolean(next) &&`: the guard narrows the parameter
  // for the checker, and the two forms are otherwise the same expression.
  const syncEnabled = next !== undefined && next.downloadSyncEnabled !== false;
  setMusicMode(next && next.musicMode ? true : false);
  // Applied rather than written by `setTheme`, because this is a value that arrived
  // from storage — it must not be saved straight back out.
  theme.value = next?.theme || "system";
  if (theme.value === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme.value;
  }
  return syncEnabled;
}

export async function checkHelperStatus(): Promise<{
  connected: boolean;
  dependencies: Record<string, unknown>;
  hasMissingDeps: boolean;
}> {
  const response = (await PopupApi.getHelperStatus()) as HelperStatusResponse | null;
  const connected = Boolean(response && response.ok && response.connected);
  const dependencies = (response && response.dependencies) || {};
  const version = (response && response.version) || "";

  // A missing `required` tool means downloads fail outright, so the banner must say so.
  // Derived from the shared table so a newly-required tool cannot slip past.
  const missing = HELPER_DEPENDENCIES.filter((dep) => dep.required && isMissing(dependencies, dep.key));

  helperStatus.value = { connected, version, missing };
  return { connected, dependencies, hasMissingDeps: missing.length > 0 };
}

/**
 * Copy the install command to the clipboard.
 *
 * This used to take the button and rewrite its `innerHTML` with a "Copied!" string that
 * led with a text-character tick, which is how a character ended up serving as an icon
 * (spec §4.4). The caller owns the button's label now; this only reports whether it
 * worked.
 */
export async function copyInstallCommand(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    return true;
  } catch (_error) {
    return false;
  }
}

/** The one command the banner and the helper-missing empty state both offer. */
export const INSTALL_COMMAND = "scripts/install.sh";

export async function init(): Promise<void> {
  await updateActiveTabContext();

  // H11 part 2 (hls-thumbnail-spec.md §3.2): a player that buffered without firing a
  // media event has a frame the last scan could not have caught — an MSE/HLS element
  // autoplays muted and never reaches `playing`. Fire-and-forget on purpose: this must
  // not block first paint, and the recovered art arrives as the normal detection
  // broadcast, which is what re-renders the rows.
  if (hasActiveTab()) {
    void PopupApi.rescanForFrames(activeTabId.value as number);
  }

  // Before the no-tab bail: `refresh` reads the *global* download list on its way in, so
  // the tray is populated even when there is no tab to scan.
  await refresh({ syncActiveTab: false });
  await checkHelperStatus();

  if (!hasActiveTab()) {
    setScanStatus("failed", "No active tab found.");
    setNotice("No active tab found.", true);
  }
}

export async function rescanActiveTab(): Promise<void> {
  rescanBusy.value = true;
  setScanStatus("scanning");
  setNotice("");

  try {
    await updateActiveTabContext();

    if (!hasActiveTab()) {
      setScanStatus("failed", "No active tab found.");
      setNotice("No active tab found.", true);
      return;
    }

    const response = (await PopupApi.rescanTab(activeTabId.value as number)) as PopupResponse | null;
    if (!response || !response.ok) {
      setScanStatus("failed", response?.error || "Could not refresh this tab.");
      setNotice(response?.error || "Could not refresh this tab.", true);
      return;
    }

    await refresh({ syncActiveTab: false });
  } finally {
    rescanBusy.value = false;
  }
}

/**
 * "Clear page": forget this tab's detected videos and nothing else.
 *
 * It used to also call `clearDownloads`, which — now that the tray is global — would have
 * read as "clear *everything* on the machine" from a button labelled "Clear page". The
 * tray's own affordance for finished jobs is "Clear finished" in the Downloads view.
 */
export async function clearActiveTabVideos(): Promise<void> {
  await updateActiveTabContext();

  if (!hasActiveTab()) {
    setNotice("No active tab found.", true);
    return;
  }

  setScanStatus("scanning");
  setNotice("");
  try {
    const tabId = activeTabId.value as number;
    const response = (await PopupApi.clearVideos(tabId)) as PopupResponse | null;
    if (!response || !response.ok) {
      setNotice(response?.error || "Could not clear detected videos.", true);
      return;
    }

    currentVideos.value = [];
    await refresh();
  } finally {
    setScanStatus("ready");
  }
}
