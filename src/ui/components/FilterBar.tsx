import type { ComponentChildren, Ref } from "preact";

import { patchFilter, SORT_KEYS, SORT_LABELS, type FilterState, type SortKey } from "../filter.js";

export interface FilterBarProps {
  filter: FilterState;
  onChange(next: FilterState): void;
  /**
   * Extra dropdowns (status, format, source). Each page builds its own options from
   * `facetValues`, so this component stays ignorant of what is being filtered - it
   * only owns the free-text box and the sort order, which every page wants identically.
   */
  children?: ComponentChildren;
  /** Which text the free-text box filters, for its accessible name. */
  searchLabel?: string;
  /**
   * The search input's node, so the owning page can implement `/` (spec §10: "`/`
   * focuses search, and selects its contents"). Only the popup binds a view-level
   * shortcut to it; `downloads.html` has no `/` shortcut and leaves this off.
   */
  searchRef?: Ref<HTMLInputElement>;
}

/**
 * Free-text search plus sort order, shared by the downloads page and the popup's
 * video list.
 *
 * `onChange` receives the whole next state rather than a partial, so a caller cannot
 * apply a field without also re-sorting - the two were one control to the user and
 * should stay one state object here.
 */
export function FilterBar({ filter, onChange, children, searchLabel = "Search titles", searchRef }: FilterBarProps) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <input
        ref={searchRef}
        type="search"
        aria-label={searchLabel}
        placeholder="Search..."
        value={filter.query}
        onInput={(event) => onChange(patchFilter(filter, { query: event.currentTarget.value }))}
        class="ring-focus h-7 min-w-40 flex-1 rounded-row border border-border bg-surface px-2 text-caption text-text placeholder:text-text-muted"
      />
      <select
        aria-label="Sort by"
        value={filter.sort}
        onChange={(event) => onChange(patchFilter(filter, { sort: event.currentTarget.value as SortKey }))}
        class="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {SORT_KEYS.map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}
