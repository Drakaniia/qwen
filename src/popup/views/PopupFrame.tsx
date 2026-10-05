import { useEffect, useRef } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { Icon, StatusDot, type IconName } from "../../ui/Icon.js";
import { Logo } from "../../ui/Logo.js";
import { Segmented } from "../../ui/components/Segmented.js";
import { Toolbar } from "../../ui/components/Toolbar.js";
import { useResize } from "../../ui/useResize.js";
import * as PopupApi from "../../shared/popup_api.js";
import { DependencyBanner } from "../components/DependencyBanner.js";
import {
  activeTabId,
  clearSelection,
  helperStatus,
  popupWidth,
  qualityDialog,
  rescanBusy,
  selectedCount,
  setNotice,
  setTheme,
  setViewMode,
  theme,
  viewMode,
} from "../state/app.js";
import { orderedSelection } from "../../ui/useStickySelection.js";
import { activeDownloads } from "../state/downloads.js";
import { mediaStatus, mediaStatusLabel } from "../state/videos.js";
import { clearActiveTabVideos, rescanActiveTab } from "../popup_helpers.js";
import { DownloadsView } from "./DownloadsView.js";
import { MediaView } from "./MediaView.js";
import { SelectionBar } from "./SelectionBar.js";

const THEME_SEGMENTS = [
  { value: "system" as const, label: "System" },
  { value: "light" as const, label: "Light" },
  { value: "dark" as const, label: "Dark" },
];

const VIEW_SEGMENTS = [
  { value: "media" as const, label: "Media" },
  { value: "downloads" as const, label: "Downloads" },
];

/**
 * The popup frame (spec §6.1, §6.2, §6.4, D5, D6, D7).
 *
 * One tree, and it is the root that owns `useResize`: the hook writes
 * `document.body.style.width` directly (spec §4.5 — a resize is direct manipulation,
 * 1:1 with the pointer, zero easing), so two instances of it would fight over the same
 * property. The selection bar and the quality dialog are separate roots for that reason.
 */
export function PopupFrame() {
  const { width, gripProps } = useResize();
  const searchRef = useRef<HTMLInputElement | null>(null);

  // The committed width as a signal so chrome that has to react to it can subscribe.
  // `useResize` applies it to the document and is the only writer; this is a mirror, not
  // a second source of truth.
  useEffect(() => {
    popupWidth.value = width;
  }, [width]);

  // `/` and `Esc` (spec §10). Document-level rather than per-list because they have to
  // work from anywhere in the popup, including from the paste box you would want `/` to
  // get you out of. The listbox's own keys are `useListKeys`, which MediaView marks as a
  // hand-off to B2.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && !isTextEntry(event.target)) {
        event.preventDefault();
        const search = searchRef.current;
        if (search) {
          search.focus();
          // "and selects its contents" — so the next keystroke replaces the query rather
          // than appending to it.
          search.select();
        }
        return;
      }
      if (event.key !== "Escape") {
        return;
      }
      // The sheet binds its own *capture*-phase listener, so it has already closed by
      // the time this runs — and clearing the selection behind a dialog that is closing
      // is a state change the user did not ask for.
      if (qualityDialog.value.open) {
        return;
      }
      // §10: "close the sheet / clear selection / blur search", in that order of
      // visibility. Inside the list, `useListKeys` also owns Escape; its `clear()` is
      // guarded, so the two reaching it is a no-op rather than a double-render.
      if (selectedCount.value > 0) {
        clearSelection();
        return;
      }
      if (searchRef.current && document.activeElement === searchRef.current) {
        searchRef.current.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // §6.4's two destinations. A Downloads badge only while something is running: a
  // permanent "0" is a number nobody needs, and a permanent "3" from an hour ago is a
  // lie. `undefined` is the Segmented signal for "no badge at all".
  const viewSegments = VIEW_SEGMENTS.map((segment) =>
    segment.value === "downloads" ? { ...segment, badge: activeDownloads.value.length || undefined } : segment,
  );

  return (
    <div class="flex min-h-screen flex-col">
      <PopupHeader />

      <DependencyBanner />

      <div class="material-chrome px-4 py-2">
        <Segmented ariaLabel="Popup view" segments={viewSegments} value={viewMode.value} onChange={setViewMode} />
      </div>

      {/* Content surfaces are opaque on purpose (spec §4.1): rows are the densest thing
          in the app and a blurred row behind other blurred rows is unreadable. The
          `<body>` underneath stays transparent so the chrome's blur reads as depth
          against the desktop (D10). */}
      <main class="material-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        {viewMode.value === "downloads" ? <DownloadsView /> : <MediaView searchRef={searchRef} />}
      </main>

      <PopupFooter />

      {/* Fixed, not in the flow: the grip tracks the pointer over the whole popup,
          including the scroll area, and must not take a row's height. `gripProps`
          carries all four pointer handlers — `setPointerCapture` retargets
          move/up at the grip, so spreading only `onPointerDown` dead-drags it. */}
      <div {...gripProps} class="ring-focus fixed right-0 top-0 z-20 h-full w-2 cursor-col-resize touch-none" />
    </div>
  );
}

/**
 * The selection bar's root (spec §6.9, D21).
 *
 * Its own mount point because it is a fixed layer with no parent in the flow to inherit
 * a positioning context from, and because it reads the module-level selection signal —
 * so it needs no props from the frame and no shared hook with it.
 *
 * B2 owns the component; the popup owns only the layer it lives in and the executor.
 * §6.9 requires the bar to be scrim-free and parallel: `pointer-events: none` on the
 * root so the content underneath stays usable, restored on the bar itself.
 */
export function PopupSelectionLayer() {
  return (
    <div class="pointer-events-none fixed inset-x-0 bottom-0 z-20">
      <div class="pointer-events-auto">
        <SelectionBar
          onDownloadAll={() =>
            void batchDownloadSelection(activeTabIdOrZero(), orderedSelection.value, "best").catch((error) =>
              setNotice(error instanceof Error ? error.message : String(error), true),
            )
          }
        />
      </div>
    </div>
  );
}

/** `0` stands in for "no tab", which reads as falsy and falls back to the sender's own. */
function activeTabIdOrZero(): number {
  return activeTabId.value ?? 0;
}

/**
 * §6.9 batch executor: hand the ordered selection to `downloadMany`, which runs three at
 * a time in the background, then clear the selection and switch to Downloads so the tray
 * is what the user is looking at next.
 *
 * Throws rather than writing the notice itself — it is called from a click handler with no
 * return value to write to, so the caller catches and reports. `orderedSelection` is passed
 * in rather than read here because the signal is a module singleton and the executor is the
 * one thing worth testing without mounting the frame.
 */
export async function batchDownloadSelection(tabId: number, ids: string[], formatId = "best") {
  const reply = (await PopupApi.downloadMany(tabId, ids, formatId)) as {
    ok?: boolean;
    jobIds?: string[];
    error?: string;
  } | null;
  if (!reply || !reply.ok) {
    throw new Error(reply?.error || "Batch download failed to start.");
  }
  clearSelection();
  setViewMode("downloads");
  return reply;
}

/**
 * Whether focus is in something the user types into, where `/` is a character and not a
 * shortcut. Without this, `/` inside the paste box would steal the keystroke and move
 * focus out of the field the user was in.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

// ─── Header (spec §6.2) ─────────────────────────────────────────────────────

function IconControl({
  icon,
  label,
  href,
  busy = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  href?: string;
  busy?: boolean;
  onClick?: () => void;
}) {
  const classes = `pressable ring-focus grid size-7 shrink-0 place-items-center rounded-row text-text-muted transition-colors hover:bg-raised hover:text-text ${
    busy ? "opacity-50" : ""
  }`;
  // `title` on the Icon is correct here and only here: this glyph is the sole content
  // of its control, so it is what gives the control its accessible name.
  const glyph = <Icon name={icon} size={16} title={label} />;

  // An anchor, not a button: Settings navigates to `options.html`. The 28px icon-button
  // look is identical either way, and a button that opens a page lies to a screen
  // reader and to anyone reading the markup.
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} class={classes}>
        {glyph}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={busy} aria-busy={busy} aria-label={label} class={classes}>
      {glyph}
    </button>
  );
}

function PopupHeader() {
  const status = helperStatus.value;

  // §6.2's caption. When the helper is absent this is the only place that says so,
  // which is why it is a caption line and not a tooltip.
  let caption = "Checking the native helper...";
  if (status.connected === false) {
    caption = "Native helper not connected";
  } else if (status.connected) {
    caption = status.version ? `Connected · helper ${status.version}` : "Connected";
  }

  return (
    <Toolbar
      leading={
        <div class="flex shrink-0 items-center gap-2">
          <Logo />
          <StatusDot state={mediaStatus.value} label={mediaStatusLabel.value} />
        </div>
      }
      title="Qwin"
      caption={caption}
      actions={
        <>
          <Segmented ariaLabel="Theme" size="sm" segments={THEME_SEGMENTS} value={theme.value} onChange={setTheme} />
          <IconControl
            icon="arrow.clockwise"
            label={rescanBusy.value ? "Refreshing" : "Rescan"}
            busy={rescanBusy.value}
            onClick={() => void rescanActiveTab()}
          />
          <IconControl icon="gearshape" label="Settings" href="./options.html" />
        </>
      }
    />
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function PopupFooter() {
  return (
    <footer class="material-chrome flex items-center justify-between gap-2 px-4 py-2">
      <a
        href="./downloads.html"
        target="_blank"
        rel="noreferrer"
        class="text-caption text-text-muted transition-colors hover:text-text"
      >
        All downloads
      </a>
      <div class="flex items-center gap-2">
        {/* Visible only while something is selected: a "Clear" that appears alongside
            the selection bar's own Clear is the same gesture offered twice. */}
        {selectedCount.value > 0 ? (
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            Clear selection
          </Button>
        ) : null}
        {/* Destructive, so it tints `critical` on hover — but it gets no confirmation
            dialog: a rescan rebuilds the list in one click, and Apple treats a confirm as
            something to spend sparingly, not on every recoverable clear. */}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void clearActiveTabVideos()}
          class="hover:bg-critical/10 hover:text-critical"
        >
          Clear page
        </Button>
      </div>
    </footer>
  );
}
