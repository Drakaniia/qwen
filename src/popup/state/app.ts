/**
 * App-level UI state (spec §5.1, §5 Phase 5, §3.3).
 *
 * This module now also holds everything `popup.html` used to own as markup (spec
 * §5.1: "`state/app.ts` gains the signals the static markup used to own — `viewMode`,
 * `dependencyBanner`, `helperStatus`, `selection`, `popupWidth` — so a re-render is the
 * only way state changes"). The `apply*`/`set*` split `popup_helpers.ts` used to have
 * is gone with the DOM it wrote to: there is one signal and every reader re-renders.
 *
 * Field names and value domains stay identical to the pre-migration store wherever a
 * message handler or test still keys off them.
 */
import { computed, signal } from "@preact/signals";

import type { HelperDependency } from "../../shared/helper_dependencies.js";
import type { ThemeMode } from "../../shared/contracts.js";
import * as PopupApi from "../../shared/popup_api.js";
import { POPUP_DEFAULT_WIDTH } from "../../ui/motion.js";
import type { PopupSettingsForm } from "../popup_state.js";

/**
 * D7: two destinations. "Music" was never one — `visibleVideos` filtered the *same*
 * candidate array by `format === "AUDIO"`, so the third tab advertised a peer that did
 * not exist. Audio candidates now live in Media with a badge.
 */
export const VIEW_MODES = ["media", "downloads"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** Last-resort text for the quality dialog's loading row. */
export const QUALITY_LOADING_TEXT = "Checking available video versions...";

export const viewMode = signal<ViewMode>("media");

/**
 * Audio *output*, not a view (spec D20). `background/download/native.ts:319` forwards
 * this flag to the native helper as `extractAudio`, so the setting survives the Music
 * tab's deletion even though nothing in the popup switches views on it any more. See
 * the "who writes musicMode" note in the hand-off report.
 */
export const musicMode = signal(false);

// ─── Signals the static markup used to own (spec §5.1) ─────────────────────

/** D6. Absent `data-theme` means System, which `theme.css` handles on its own. */
export const theme = signal<ThemeMode>("system");

/** D5. Mirrors `useResize`'s committed width so chrome can react to a resize. */
export const popupWidth = signal<number>(POPUP_DEFAULT_WIDTH);

export interface HelperStatusState {
  /** `null` until `getHelperStatus` answers, which the header renders differently. */
  connected: boolean | null;
  /** The helper's own version string. Not yt-dlp's — see the hand-off report. */
  version: string;
  /** Required tools that are absent. Non-empty is what the banner is for. */
  missing: readonly HelperDependency[];
}

export const helperStatus = signal<HelperStatusState>({ connected: null, version: "", missing: [] });

/**
 * Derived, not a second signal: the banner exists exactly when a required tool is
 * missing (spec §6.3), so a writer that could disagree with `helperStatus` would be a
 * bug waiting to happen. `null` means "no banner".
 */
export const dependencyBanner = computed<HelperStatusState | null>(() => {
  const status = helperStatus.value;
  return status.connected && status.missing.length ? status : null;
});

/** A transient one-line note under the paste box. `isError` only changes the tint. */
export interface Notice {
  text: string;
  isError: boolean;
}

export const notice = signal<Notice>({ text: "", isError: false });

export function setNotice(text: string, isError = false): void {
  notice.value = { text: String(text || ""), isError };
}

/** Whether a rescan is in flight. The header's rescan button renders from this. */
export const rescanBusy = signal(false);

/**
 * The batch selection (spec §6.9, D21).
 *
 * Re-exported rather than re-declared: the set is module-level on purpose (its own
 * docblock explains why), and one import path into it is worth more here than matching
 * the spec's sentence literally. `useStickySelection.ts` is still the only definition.
 */
export { clear as clearSelection, isSelected, selection, selectedCount, toggle } from "../../ui/useStickySelection.js";

/**
 * The settings the popup reads but no longer owns a control for (spec §12).
 *
 * `applySettingsToForm` used to mirror these onto hidden DOM controls; the popup now
 * holds them as one object and the options page owns every editor. `audioFormat` in
 * particular is read here instead of off a `<select>` (spec §5.1, D20).
 */
export const settings = signal<PopupSettingsForm>({});

/** Persist `Settings.theme` and apply it to the document in one step. */
export function setTheme(mode: ThemeMode): void {
  theme.value = mode;
  // Absent for System: `theme.css` resolves that through `prefers-color-scheme`, so
  // pinning `data-theme="system"` would defeat the whole point of the three-way control.
  if (mode === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }
  void PopupApi.saveSettings({ theme: mode });
}

/**
 * `null` until the first scan resolves. Components read it as "no scan yet" and
 * render nothing rather than an empty state.
 */
export const activeTabId = signal<number | null>(null);
export const activeTabUrl = signal("");

/**
 * Bumped on every quality request and on cancel. Callers hold a token and drop
 * their response if it no longer matches, which is what makes a slow `getVideoFormats`
 * safe to abandon.
 */
export const qualityRequestSerial = signal(0);

export interface QualityDialogState {
  open: boolean;
  view: "loading" | "videos" | "formats";
  title: string;
  statusText: string;
  nativeError: string;
  hasBack: boolean;
  formats: unknown[];
}

export const qualityDialog = signal<QualityDialogState>({
  open: false,
  view: "loading",
  title: "",
  statusText: QUALITY_LOADING_TEXT,
  nativeError: "",
  hasBack: false,
  formats: [],
});

/** Apply a view mode, rejecting anything the two-segment switch cannot show. */
export function setViewMode(mode: string): ViewMode {
  const next = (VIEW_MODES as readonly string[]).includes(mode) ? (mode as ViewMode) : "media";
  viewMode.value = next;
  return next;
}

export function setMusicMode(enabled: unknown): boolean {
  const next = Boolean(enabled);
  musicMode.value = next;
  return next;
}

// ─── Quality dialog bridge ──────────────────────────────────────────────────
//
// The dialog is a component, but the flow around it is promise-shaped: open, wait,
// resolve with a pick or null. The resolver is the one piece of its state a
// component cannot own, so it lives here with the dialog rather than in a module
// the components would have to import sideways.

type FormatChoice = { formatId: string; variantId: string; backend: string } | null;
type ChoiceResolver = (choice: FormatChoice) => void;

let pendingChoice: ChoiceResolver | null = null;

function settleChoice(choice: FormatChoice) {
  const resolve = pendingChoice;
  pendingChoice = null;
  if (resolve) {
    resolve(choice);
  }
}

function setDialog(patch: Partial<QualityDialogState>) {
  qualityDialog.value = { ...qualityDialog.value, ...patch };
}

/**
 * Close the dialog, resolving any outstanding choice as cancelled first.
 *
 * The old imperative chooser dropped the resolver instead, so opening Settings while
 * the format table was up left the video's download button stuck on "Loading..."
 * for the rest of the popup's life.
 */
export function hideQualityDialog() {
  settleChoice(null);
  setDialog({ open: false });
}

/**
 * Open the dialog on its loading row and invalidate any request already in flight.
 * @returns a token for {@link isCurrentQualityRequest}
 */
export function showQualityLoading(title = "Loading versions..."): number {
  const token = qualityRequestSerial.value + 1;
  qualityRequestSerial.value = token;
  // Matches the old chooser: a load abandons any outstanding choice without
  // resolving it. A choice is only ever outstanding in the formats view.
  pendingChoice = null;
  setDialog({
    open: true,
    view: "loading",
    title,
    statusText: QUALITY_LOADING_TEXT,
    nativeError: "",
    hasBack: false,
    formats: [],
  });
  return token;
}

/** Whether a format request is still the current one. */
export function isCurrentQualityRequest(token: number): boolean {
  return token === qualityRequestSerial.value;
}

/** Replace the loading row's text, as the native host reports back. */
export function updateQualityLoadingStatus(text: string) {
  if (qualityDialog.value.view !== "loading" || !qualityDialog.value.open) {
    return;
  }
  setDialog({ statusText: text });
}

/** Show the format table and resolve with the user's pick, or `null` if they cancel. */
export function chooseQuality({
  title,
  formats,
  nativeError,
  hasSubtitles,
}: {
  title?: string;
  formats?: unknown[];
  nativeError?: string;
  hasSubtitles?: boolean;
}): Promise<FormatChoice> {
  const suffix = hasSubtitles ? " — CC" : "";
  setDialog({
    open: true,
    view: "formats",
    title: title ? `Compare versions: ${title}${suffix}` : "Compare versions",
    nativeError: nativeError || "",
    formats: formats || [],
  });
  return new Promise<FormatChoice>((resolve) => {
    pendingChoice = resolve;
  });
}

export function onQualityFormatSelected(format: {
  formatId?: string;
  id?: string;
  variantId?: string;
  backend?: string;
}) {
  settleChoice({
    formatId: format.formatId || format.id || "best",
    variantId: format.variantId || "",
    backend: format.backend || "auto",
  });
  setDialog({ open: false });
}

export function onQualityDialogBack() {
  settleChoice(null);
  setDialog({ open: false });
}

export function onQualityDialogCancel() {
  if (qualityDialog.value.view === "formats") {
    settleChoice(null);
  } else {
    // Cancelling a load invalidates the in-flight request, so its late response
    // cannot open the table behind the user's back.
    qualityRequestSerial.value += 1;
  }
  setDialog({ open: false });
}
