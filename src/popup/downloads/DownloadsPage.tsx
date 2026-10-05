/**
 * `downloads.html` - the full searchable history (spec §7, D15).
 *
 * Kept as its own page because the popup cannot be: the popup is a 600px live tray
 * (D15), this is the whole record, unconstrained by height and free to search, group
 * and bulk-act.
 *
 * What changed from the previous version of this file, and why:
 *
 *   - **Grouped by day** (Today / Yesterday / This week / Earlier) instead of the flat
 *     "Active jobs / Completed history" split, which put a running job and a
 *     two-year-old sync entry under two ALL-CAPS headers with nothing between them to
 *     say which was which.
 *   - **Per-row Open / Reveal**, keyed on the row's own `jobId`. The old code reached
 *     only the newest saved file (`openNewestSaved` / `revealNewestSaved`); the wire
 *     messages have always been per-job, so this is the same call with a different id.
 *   - **Facet filters are popovers** with a real "All formats" row, not a `<select>`
 *     whose first option doubles as the control's label.
 *   - **A theme control in the toolbar** (§6.2's `Segmented`). This is a separate
 *     document from the popup, so it needs `data-theme` applied at boot or it renders
 *     light next to a dark popup. The durable preference is still Options' (§8); this
 *     is the same one setting, edited where it is being looked at.
 *   - **No ALL-CAPS section headers.** `text-section` + `.section-label` is the 11px /
 *     +0.06em role, and a day group is a real heading; a row's own metadata is not a
 *     heading, so it gets nothing.
 *
 * ponytail: scroll-and-filter, no pagination, unchanged. The synced half is hard-capped
 * at 200 entries (`MAX_SYNCED_ENTRIES`, `shared/download_sync.ts`) and the job half is
 * whatever has not been cleared. Virtualization stays out - spec §13.
 */
import type { HTMLAttributes } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { Icon } from "../../ui/Icon.js";
import { Button } from "../../ui/components/Button.js";
import { EmptyState } from "../../ui/components/EmptyState.js";
import { Segmented } from "../../ui/components/Segmented.js";
import { Toolbar } from "../../ui/components/Toolbar.js";
import { SORT_KEYS, SORT_LABELS, patchFilter, type SortKey } from "../../ui/filter.js";
import { useListKeys } from "../../ui/useListKeys.js";
import { clear, isSelected, selectedCount, toggle } from "../../ui/useStickySelection.js";
import { downloadActions } from "../download_status.js";
import { FacetPopover } from "./FacetPopover.js";
import { HistoryRow } from "./HistoryRow.js";
import {
  clearAll,
  facets,
  failedJobs,
  filter,
  groups,
  loadAll,
  loadTheme,
  loaded,
  newestSaved,
  notice,
  noticeIsError,
  openRecord,
  records,
  revealNewestSaved,
  revealRecord,
  retryAllFailed,
  runJobAction,
  setTheme,
  syncEnabled,
  theme,
  watchTheme,
  watchUpdates,
  type DownloadRecord,
} from "./state.js";

const THEME_SEGMENTS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** Boot the page: theme first (so the first paint is already the right scheme), then data. */
export function startDownloadsPage(): () => void {
  void loadTheme();
  void loadAll();
  const stopUpdates = watchUpdates();
  const stopTheme = watchTheme();
  return () => {
    stopUpdates();
    stopTheme();
  };
}

/** `Enter` on the active row: open the file, else run the row's primary action (§10). */
function activate(record: DownloadRecord | undefined): void {
  const job = record && record.job;
  if (!job) {
    return;
  }
  if (job.filepath) {
    void openRecord(record);
    return;
  }
  const primary = downloadActions(job).find((action) => action.primary);
  if (primary) {
    void runJobAction(primary.action, job);
  }
}

/** The three facet popovers over the unfiltered set (§7). */
function Facets() {
  const state = filter.value;
  const options = facets.value;
  return (
    <>
      <FacetPopover
        label="Status"
        allLabel="All statuses"
        value={state.status}
        options={options.status}
        onChange={(next) => (filter.value = patchFilter(state, { status: next }))}
      />
      <FacetPopover
        label="Format"
        allLabel="All formats"
        value={state.format}
        options={options.format}
        onChange={(next) => (filter.value = patchFilter(state, { format: next }))}
      />
      <FacetPopover
        label="Source"
        allLabel="All sources"
        value={state.source}
        options={options.source}
        onChange={(next) => (filter.value = patchFilter(state, { source: next }))}
      />
    </>
  );
}

/** The search box's ref, typed structurally so it does not depend on Preact's `Ref` alias. */
type SearchRef = { current: HTMLInputElement | null };

/**
 * The listbox. `role`, the single tab stop, `aria-activedescendant` and all seven keys
 * come from `ui/useListKeys` (spec §10, D14) - one key model for both surfaces, so the
 * popup and this page cannot drift. A day group is `role="group"` naming its own
 * heading, which is what makes "Today, 4 downloads" announced instead of four
 * unlabelled options.
 */
function HistoryList({ searchRef }: { searchRef: SearchRef }) {
  const rows = groups.value.flatMap((group) => group.records);
  const keys = useListKeys({
    count: rows.length,
    idFor: (index) => `row-${rows[index] ? rows[index].key : index}`,
    onDownload: (index) => activate(rows[index]),
    onToggleSelect: (index) => {
      const key = rows[index] && rows[index].key;
      if (key) {
        toggle(key);
      }
    },
  });
  const active = rows[keys.activeIndex];
  const indexByKey = new Map(rows.map((record, index) => [record.key, index]));

  // `containerProps` is typed against `HTMLElement` and this is a div; the two attribute
  // types differ only in the event target, so the double cast is the whole cost of
  // reusing the hook's role / tabIndex / aria-activedescendant / onKeyDown bundle rather
  // than restating its four attributes here.
  const containerProps = keys.containerProps as unknown as HTMLAttributes<HTMLDivElement>;

  // `/` focuses and selects the search box from anywhere on the page (§10). Document
  // level, because the listbox only sees keys typed while it holds focus; the hook owns
  // the seven list keys and this owns the two page-level ones.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"));

      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === "Escape" && typing && target) {
        // Clearing the selection is the hook's job (`useStickySelection.clear`), which
        // only runs with focus in the list. Escape here means "let go of the search box".
        target.blur();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [searchRef]);

  return (
    <div
      {...containerProps}
      aria-label="Download history. Arrow keys move, Space selects, Enter opens."
      class="flex flex-col gap-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {groups.value.map((group) => (
        <div key={group.key} role="group" aria-labelledby={`group-${group.key}`} class="flex flex-col gap-2">
          <div class="flex items-baseline gap-2 px-1">
            {/* §7: the 11px / +0.06em role, not an ALL-CAPS header invented at a
                different size. `vibrancy-tertiary` because the bar behind it is glass. */}
            <h2 id={`group-${group.key}`} class="section-label text-section text-text-tertiary vibrancy-tertiary">
              {group.label}
            </h2>
            <span class="nums text-caption text-text-tertiary">{group.records.length}</span>
          </div>
          {group.records.map((record) => (
            <HistoryRow
              key={record.key}
              record={record}
              id={keys.rowId(indexByKey.get(record.key) ?? 0)}
              selected={isSelected(record.key)}
              active={Boolean(active && active.key === record.key)}
              onSelect={toggle}
              onOpen={(item) => void openRecord(item)}
              onReveal={(item) => void revealRecord(item)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function openOptions(): void {
  const runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (runtime && runtime.getURL) {
    globalThis.open(runtime.getURL("options.html"), "_blank");
  }
}

function clearFilters(): void {
  filter.value = patchFilter(filter.value, { query: "", status: "", format: "", source: "" });
}

/** The two designed empty states. Neither ships as a bare centered sentence (§6.10, D13). */
function EmptyList() {
  if (!records.value.length) {
    return (
      <EmptyState
        icon="download.circle"
        headline="No downloads yet"
        body="Files show up here as soon as the helper saves one. History sync keeps them across restarts."
        action={{ label: "Open Options", onClick: openOptions }}
      />
    );
  }

  return (
    <EmptyState
      icon="magnifyingglass"
      headline="No downloads match these filters"
      body={`${records.value.length} downloads are here. None of them pass the search and the three facets.`}
      action={{ label: "Clear filters", onClick: clearFilters }}
    />
  );
}

/**
 * The bulk bar (spec §7). Same `.material-chrome` treatment as the popup's selection
 * bar, which is B2's component - this is a sibling, not a shared one, because the two
 * bars carry different actions and the popup's springs from its own bottom edge.
 */
function BulkBar() {
  const failed = failedJobs.value.length;

  return (
    <div class="material-chrome sticky bottom-0 z-10 flex flex-wrap items-center gap-2 px-4 py-2">
      {selectedCount.value > 0 ? (
        <>
          <span class="nums text-body text-text">{selectedCount.value} selected</span>
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear selection
          </Button>
        </>
      ) : null}

      <span class="flex-1" />

      <Button size="sm" disabled={!failed} onClick={() => void retryAllFailed()}>
        <Icon name="arrow.clockwise" size={14} />
        Retry failed{failed ? ` (${failed})` : ""}
      </Button>
      <Button size="sm" onClick={() => void clearAll()}>
        <Icon name="trash" size={14} />
        Clear all
      </Button>
      {/* No "open folder": the native host has no such verb - see `revealNewestSaved`. */}
      <Button size="sm" disabled={!newestSaved.value} onClick={() => void revealNewestSaved()}>
        <Icon name="folder" size={14} />
        Reveal newest
      </Button>
    </div>
  );
}

export function DownloadsPage() {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const state = filter.value;
  const total = records.value.length;
  const visible = groups.value.reduce((count, group) => count + group.records.length, 0);

  return (
    <div class="flex min-h-screen flex-col bg-surface text-text">
      {/* -- Sticky translucent toolbar (spec §7) */}
      <div class="sticky top-0 z-20 flex flex-col">
        <Toolbar
          title="Downloads"
          caption={
            loaded.value
              ? `${visible} of ${total} shown${syncEnabled.value ? "" : " · history sync is off"}`
              : "Loading..."
          }
          actions={
            <Segmented
              ariaLabel="Theme"
              size="sm"
              segments={THEME_SEGMENTS}
              value={theme.value}
              onChange={(next) => void setTheme(next)}
            />
          }
        />
        <Toolbar class="flex-wrap">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search download titles. Press slash to focus."
            placeholder="Search downloads"
            value={state.query}
            onInput={(event) => (filter.value = patchFilter(state, { query: event.currentTarget.value }))}
            class="h-8 min-w-40 flex-1 rounded-input border border-border bg-surface px-2 text-body text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <select
            aria-label="Sort by"
            value={state.sort}
            onChange={(event) => (filter.value = patchFilter(state, { sort: event.currentTarget.value as SortKey }))}
            class="h-8 rounded-input border border-border bg-surface px-2 text-body text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
          <Facets />
        </Toolbar>
        {/* The blur edge: content scrolling under the glass fades out rather than
            meeting a 1px rule (§7). */}
        <div aria-hidden="true" class="pointer-events-none h-4 bg-gradient-to-b from-chrome to-transparent" />
      </div>

      <main class="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-4">
        <p
          role="status"
          aria-live="polite"
          class={`min-h-4 text-caption ${noticeIsError.value ? "text-critical" : "text-text-muted"}`}
        >
          {notice.value}
        </p>

        {!syncEnabled.value && total > 0 ? (
          <p class="rounded-card bg-caution/10 px-3 py-2 text-body text-caution">
            History sync is off. Downloads still save, but finished files stop reappearing here after a restart.
          </p>
        ) : null}

        {total > 0 && visible > 0 ? <HistoryList searchRef={searchRef} /> : <EmptyList />}
      </main>

      <div class="mx-auto w-full max-w-5xl px-6 pb-4">
        <BulkBar />
      </div>
    </div>
  );
}
