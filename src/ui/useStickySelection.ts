/**
 * The multi-select set behind the sticky selection bar (spec §6.9, D21).
 *
 * ## This module does not download anything
 *
 * §6.9, verbatim: "**In Phase 1 the executor is a stub**: selecting works, counting
 * works, clearing works, and the primary button shows the honest disabled-with-reason
 * state. The sequential dispatcher is Phase 2 (A3.2)." So there is deliberately no
 * dispatch, no format resolution and no message to the background in this file. If
 * you are wiring a "Download all" button to something here, you have found the seam
 * that Phase 2 fills — the answer is not "call `popup_api.downloadVideo` from here",
 * it is "add the executor next to this state".
 *
 * ## Why module-level, not a hook
 *
 * The selection is read by at least three surfaces that do not nest: the rows
 * (checkboxes), the sticky bar (the count), and MediaView (the ordered list, when it
 * needs it). One exported signal means they all agree without prop-drilling through
 * every list, and it matches the existing pattern in `src/popup/state/*.ts`, where
 * `videos`, `downloads`, `filters` are all module-level signals rather than contexts.
 *
 * ## Every write is a new reference
 *
 * Signals diff by identity. Mutating a `Set` in place would change the contents while
 * leaving the reference — and therefore every reader — untouched. Each operation below
 * builds a fresh `Set`.
 */
import { computed, signal } from "@preact/signals";

/**
 * The selected candidate ids, in insertion order.
 *
 * Insertion order is the order the user selected in, which is the only stable order
 * available without threading a per-candidate index through the list. Toggling an id
 * off and back on appends it — so `orderedSelection` is stable within a selection but
 * not across a re-selection. Good enough for a count and a dispatch queue; if Phase 2
 * ever needs document order, that is when this becomes a real ordered structure.
 */
export const selection = signal<ReadonlySet<string>>(new Set());

/** What the sticky bar's label reads. */
export const selectedCount = computed<number>(() => selection.value.size);

/**
 * The selected ids as an array, for a caller that needs to walk them.
 *
 * `Set` iteration is insertion-ordered, so this is deterministic without any extra
 * bookkeeping.
 */
export const orderedSelection = computed<string[]>(() => [...selection.value]);

/**
 * The first selected id, or `null` when nothing is selected.
 *
 * Exists for the Phase 2 executor's single-item case ("download this one") so that
 * branch does not have to reach into the set and unwrap an `undefined`.
 */
export const firstSelectedId = computed<string | null>(() => orderedSelection.value[0] ?? null);

/** Whether one candidate is selected. Read `selection.value` so readers subscribe. */
export function isSelected(id: string): boolean {
  return selection.value.has(id);
}

/** Add or remove one id. */
export function toggle(id: string): void {
  const next = new Set(selection.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selection.value = next;
}

/** Add ids, keeping whatever is already selected. Duplicates collapse — `Set` semantics. */
export function select(ids: Iterable<string>): void {
  const next = new Set(selection.value);
  for (const id of ids) {
    next.add(id);
  }
  selection.value = next;
}

/** Replace the selection outright. Duplicates collapse. */
export function set(ids: Iterable<string>): void {
  selection.value = new Set(ids);
}

/**
 * Drop everything.
 *
 * Guarded so that clearing an already-empty selection does not hand every subscriber a
 * fresh `Set` and re-render the whole page — the bar's Clear button is reachable
 * right up until the count reads zero.
 */
export function clear(): void {
  if (selection.value.size > 0) {
    selection.value = new Set();
  }
}
