/**
 * The facet filter, as a popover rather than a `<select>` (spec §7).
 *
 * The old control was a bare `<select>` whose first option was the label itself —
 * "All formats" was both the control's name and one of its values. That is the weak
 * mapping §7 calls out: if a label is needed to explain a control, the control is
 * wrong. Here the trigger shows the *chosen value* ("MP4", or "All formats" when
 * nothing is chosen) and "All formats" is a real, selectable row inside the panel with
 * a checkmark when it is the current choice — not a disabled-looking placeholder.
 *
 * `role="menu"` with `menuitemradio` rather than `listbox`/`option` on purpose: the
 * rows are buttons, so Enter and Space activate them natively and the roving-tabindex
 * and `aria-activedescendant` bookkeeping a listbox needs would buy nothing. The
 * arrow-key model in spec §10 is about the download list, not this menu.
 */
import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../ui/Icon.js";

export interface FacetPopoverProps {
  /** Control name, also the panel's accessible name: "Format". */
  label: string;
  /**
   * The "no filter" row's own text, passed rather than derived: "All format" is not
   * English, and this is the one string in the control the user reads as prose.
   */
  allLabel: string;
  /** The chosen value, or "" for "all". */
  value: string;
  /** The values on offer, already sorted. */
  options: string[];
  onChange(next: string): void;
}

export function FacetPopover({ label, allLabel, value, options, onChange }: FacetPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Outside click closes; Escape closes and returns focus to the trigger so the
    // keyboard user is not dropped at the top of the document.
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const row = (optionValue: string, optionLabel: string, separated: boolean) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={value === optionValue}
      onClick={() => choose(optionValue)}
      class={`pressable flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-left text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        separated ? "mt-1 border-t border-separator pt-2" : ""
      } ${value === optionValue ? "text-text" : "text-text-muted hover:bg-raised hover:text-text"}`}
    >
      {/* The checkmark occupies its cell whether or not it is drawn, so the rows do
          not shift sideways as the selection moves. */}
      <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        {value === optionValue ? <Icon name="checkmark" size={14} /> : null}
      </span>
      <span class="truncate">{optionLabel}</span>
    </button>
  );

  return (
    <div ref={rootRef} class="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${value || allLabel}`}
        onClick={() => setOpen((was) => !was)}
        class={`pressable flex h-8 items-center gap-1 rounded-input border px-2 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          value ? "border-accent text-text" : "border-border text-text-muted"
        }`}
      >
        <span class="max-w-32 truncate">{value || allLabel}</span>
        <Icon name={open ? "chevron.up" : "chevron.down"} size={14} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={label}
          class="material-sheet absolute left-0 top-full z-30 mt-2 min-w-44 max-h-72 overflow-y-auto rounded-card p-1"
        >
          {/* The action row, above a hairline: "no filter" is a choice like any other. */}
          {row("", allLabel, false)}
          {options.length ? (
            options.map((option) => row(option, option, true))
          ) : (
            <p class="px-2 py-1.5 text-caption text-text-tertiary">Nothing to filter by yet.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
