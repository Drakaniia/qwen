// ─── Module references ──────────────────────────────────────────────────────

// The `browser`/`chrome` choice already lives in the shared shim, which is also where
// the `runtime.onMessage` fallback (`{ addListener: noop }`) comes from. Reusing it
// here instead of repeating `typeof browser !== "undefined" ? browser : chrome` keeps
// one decision about which namespace the popup gets.
import { api } from "../shared/browser_api.js";

// ─── API reference ──────────────────────────────────────────────────────────
export { api };

// ─── DOM elements ───────────────────────────────────────────────────────────
//
// Three ids, and that is the whole registry (spec §5.1: "`popup_elements.js`'s 34-id
// registry shrinks to what genuinely needs `getElementById` — the three mount roots.
// Everything else goes through signals").
//
// The previous 34 were all markers for chrome that used to be static markup:
// `helperStatus` existed because `setHelperStatus` assigned `className` wholesale,
// `viewToggle`/`showVideos`/`showMusic`/`showDownloads` because the view switch was
// three buttons with `aria-pressed` written on them, `message` because the status line
// was a `<div>`, and the five `hidden` mirrors (`audioFormat`, `overlayToggle`,
// `syncHistoryToggle`, `downloadFolder`, `saveSettings`) because
// `applySettingsToForm` needed somewhere to put settings it did not own. All of that is
// a component or a signal now, and none of it needs `getElementById`.
//
// Every id below is declared in `popup.html`, which is what lets the registry be
// non-nullable rather than `HTMLElement | null`. The declaration is asserted once, here;
// `tests/js/popup/popup_boot.test.ts` is the regression guard that every id still
// resolves and that the page no longer declares controls nothing reads.
interface PopupElements {
  /** The frame: header, banner, view switch, the active view, the footer, the grip. */
  popupApp: HTMLElement;
  /** The sticky selection bar (spec §6.9) — a fixed layer with no parent in the flow. */
  selectionBar: HTMLElement;
  /** The shared format chooser, mounted into the popup shell. */
  qualityDialog: HTMLElement;
}

export const elements = {
  popupApp: document.getElementById("popupApp"),
  selectionBar: document.getElementById("selectionBar"),
  qualityDialog: document.getElementById("qualityDialog"),
} as PopupElements;
