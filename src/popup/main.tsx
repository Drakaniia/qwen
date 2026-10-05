/**
 * The popup's four Preact roots (spec §5.1, §5.2).
 *
 * `popup.html` is a shell; everything that used to be static chrome is a component
 * reading a signal from `src/popup/state/`. Three roots, one reason each — the reasons
 * are in `popup.html`'s comment, and the short version is that the frame owns
 * `document.body.style.width` through `useResize`, the selection bar is a fixed layer
 * with no parent in the flow, and the dialog is a shared component with its own portal.
 *
 * The imperative half still boots: the background's `runtime.onMessage` broadcasts
 * (`downloadUpdated`, `videoListUpdated`, `helperStatusChanged`) have no Preact owner.
 */
import { render } from "preact";

import "../ui/theme.css";
// The popup's quality dialog is the shared `ui/components/QualityDialog.tsx`, whose
// class names (`qwin-overlay-*`, `quality-*`) live in the overlay's stylesheet. The
// content script inlines the same file into its shadow root; this import is the popup's
// own copy of it, replacing the `@import` that `popup.css` used to carry.
import "../shared/qwin_overlay.css";

import { applyInitialWidth } from "../ui/useResize.js";
import { QualityDialogMount } from "./components/QualityDialogMount.js";
import { PopupFrame } from "./views/PopupFrame.js";
import { PopupSelectionLayer } from "./views/PopupFrame.js";
import { elements } from "./popup_elements.js";
import "./popup.js";

// Before the first render, not in an effect: `useResize`'s width lives in a layout
// effect in `PopupFrame`, and Preact runs those child-first, so the view switch's
// indicator measured an unsized popup on every open (a narrow, left-anchored pill). The
// popup is born at its default width; `useResize` adjusts it from there.
applyInitialWidth();

const ROOTS = [
  ["popupApp", <PopupFrame />],
  ["selectionBar", <PopupSelectionLayer />],
  ["qualityDialog", <QualityDialogMount />],
] as const;

for (const [id, tree] of ROOTS) {
  render(tree, elements[id]);
}
