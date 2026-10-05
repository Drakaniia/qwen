/**
 * The roving-tabindex keyboard model for the popup's row lists (spec §10, D14).
 *
 * ## What this hook is, and is not
 *
 * It is pure state plus one keydown handler. It does **not** render the list, does not
 * know what a video or a job is, and does not dispatch anything: `onDownload` and
 * `onToggleSelect` are the caller's closures over whatever its rows are. That is why
 * `MediaView` and `DownloadsView` can both mount it — it has no opinion about either.
 *
 * ## Why `role="listbox"` is load-bearing
 *
 * §10: *"this is a genuine multi-select list, so that is the correct role, and it is
 * what makes `aria-activedescendant` navigation legal."* `aria-activedescendant` is
 * only meaningful on the element that owns the composite role and holds DOM focus, so
 * `containerProps` puts both on the same node: the container is focusable
 * (`tabIndex: 0`) and names the active row, and the rows themselves stay out of the
 * tab order. `rowTabIndex()` is still exposed because a caller that prefers real
 * per-row focus (a pointer user tabbing forward) can use it — see the note on
 * `rowTabIndex` below.
 *
 * ## No vim-style keys (D14)
 *
 * Seven keys, all of them in §10's table. There is deliberately no `j`/`k`, no `g`/`G`,
 * no `x`, no leading-`d`. A keybinding a user has to learn is a keybinding they will
 * not find, and §10's list is the whole vocabulary.
 */
// Not from the `JSX` namespace: `JSX` is preact's `JSXInternal`, which holds the
// intrinsic-element table but not the attribute and event types. Those live in
// `preact/src/dom` and are re-exported from the package root.
import type { KeyboardEventHandler, TargetedKeyboardEvent } from "preact";
import { useState } from "preact/hooks";

import { clear } from "./useStickySelection.js";

export interface ListKeysOptions {
  /** How many rows the list currently has. Drives every bound. */
  count: number;
  /**
   * `Enter` — download the active row.
   *
   * Typed as taking the index even though B1's first draft wrote `() => void`: a
   * zero-argument function is assignable to a one-argument signature, so this widens
   * what a caller may pass without breaking anything that already compiles.
   */
  onDownload(index: number): void;
  /** `Space` — toggle selection on the active row. */
  onToggleSelect(index: number): void;
  /** `/` — the caller focuses and selects its search field. */
  onSlash?(): void;
  /** Stable row id. Defaults to `qwin-list-row-<index>`; override when the caller must match ids it renders itself. */
  idFor?(index: number): string;
}

/**
 * Exactly what `containerProps` contains — and no more, deliberately.
 *
 * It is *not* typed as preact's `HTMLAttributes<HTMLElement>`: that carries `ref` and
 * `key`, whose types are bound to one concrete element, so spreading it onto a `<ul>`
 * or a `<div>` is a type error even though every attribute in it is element-agnostic.
 * Declaring the five members the hook actually sets keeps `{...containerProps}` legal on
 * whatever element the caller chose, which is the whole point of a prop bag.
 */
export interface ListBoxProps {
  role: "listbox";
  tabIndex: 0;
  "aria-multiselectable": true;
  /** Undefined on an empty list — naming a row that is not in the DOM is worse than naming none. */
  "aria-activedescendant"?: string;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
}

export interface ListKeys {
  /** Clamped to `0 … count-1`, or `-1` when the list is empty. */
  activeIndex: number;
  setActiveIndex(index: number): void;
  /** Spread onto the listbox element. Carries the role, the focusability and the key handler. */
  containerProps: ListBoxProps;
  /** The same handler, exposed separately for a caller that wraps the list in a scroll container. */
  onKeyDown(event: TargetedKeyboardEvent<HTMLElement>): void;
  /** The `id` for row `index`, matching what `containerProps` puts in `aria-activedescendant`. */
  rowId(index: number): string;
  /** `0` for the active row, `-1` for the rest — the roving half of the tabindex. */
  rowTabIndex(index: number): 0 | -1;
}

/**
 * Keys typed into a text field must reach the field, not the list. The handler is
 * mounted on the listbox so this is mostly belt-and-braces, but a caller that also
 * binds it at the document level (to catch `/` from anywhere) needs it.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) {
    return false;
  }
  return (
    element.isContentEditable ||
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  );
}

/**
 * The keyboard model for one row list.
 *
 * `activeIndex` is clamped during render rather than corrected in an effect: when the
 * list shrinks under the cursor, the reported index drops to the new last row on the
 * same render, so there is no frame where `aria-activedescendant` names a row that is
 * no longer in the DOM. An effect would be a frame late and would flash.
 *
 * ponytail: no scroll-into-view. The popup body scrolls, so an off-screen active row is
 * technically reachable only by scrolling, but the whole list is at most a few hundred
 * pixels and the browser's own focus scroll covers the common case. Add
 * `scrollIntoView({ block: "nearest" })` on `activeIndex` if a real page ever needs it.
 */
export function useListKeys(options: ListKeysOptions): ListKeys {
  const { count, onDownload, onToggleSelect, onSlash, idFor } = options;
  const [requested, setRequested] = useState(0);

  const empty = count <= 0;
  const activeIndex = empty ? -1 : Math.min(Math.max(requested, 0), count - 1);

  function setActiveIndex(index: number): void {
    setRequested(count <= 0 ? 0 : Math.min(Math.max(index, 0), count - 1));
  }

  function rowId(index: number): string {
    return idFor ? idFor(index) : `qwin-list-row-${index}`;
  }

  function move(next: number): void {
    setActiveIndex(next);
  }

  function onKeyDown(event: TargetedKeyboardEvent<HTMLElement>): void {
    // A modified keystroke belongs to the browser (⌘R, ⌃F, Alt+Home), not to §10.
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(activeIndex + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(activeIndex - 1);
        return;
      case "Home":
        event.preventDefault();
        move(0);
        return;
      case "End":
        event.preventDefault();
        move(count - 1);
        return;
      case "Enter":
        event.preventDefault();
        if (!empty) {
          onDownload(activeIndex);
        }
        return;
      case " ":
        // Space would scroll the popup. Claim it before the browser does.
        event.preventDefault();
        if (!empty) {
          onToggleSelect(activeIndex);
        }
        return;
      case "Escape":
        // §10: "close the sheet / clear selection / blur search". The sheet owns its own
        // Escape; inside the list, clearing the selection is the list's business, and it
        // needs no callback because `useStickySelection` is module state.
        event.preventDefault();
        clear();
        return;
      case "/":
        event.preventDefault();
        onSlash?.();
        return;
      default:
    }
  }

  const containerProps: ListBoxProps = {
    role: "listbox",
    tabIndex: 0,
    "aria-multiselectable": true,
    "aria-activedescendant": empty ? undefined : rowId(activeIndex),
    onKeyDown,
  };

  return {
    activeIndex,
    setActiveIndex,
    containerProps,
    onKeyDown,
    rowId,
    rowTabIndex: (index: number) => (index === activeIndex ? 0 : -1),
  };
}
