/**
 * List filter + sort, shared by the downloads page and the video lists (spec A4.5,
 * A4.2). One pure module, no signals and no DOM: the pages own the state, this owns
 * the rules, so the same behaviour is testable without mounting anything.
 *
 * Written as one pass over the items rather than a pipeline of `.filter().sort()`
 * calls because every page needs the same three questions answered together - which
 * rows survive, how they are ordered, and what the filter dropdowns should offer -
 * and the facet list has to be computed from the *unfiltered* set or a selected
 * format would make its own dropdown empty.
 */

/** The fields the rules read. Every page's row shape is a superset of this. */
export interface FilterableItem {
  title?: string;
  url?: string;
  format?: string;
  source?: string;
  /** Pre-extracted host on synced history entries; falls back to parsing `url`. */
  sourceHost?: string;
  /** The page the download started from. Preferred over `url` for the source facet. */
  pageUrl?: string;
  status?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  updatedAt?: number;
  /** Widened to `string` because the synced-history entry type allows both. */
  completedAt?: number | string;
}

export const SORT_KEYS = ["recency", "title", "size", "status", "source", "duration"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  recency: "Newest first",
  title: "Title A–Z",
  size: "Largest first",
  status: "Status",
  source: "Source",
  duration: "Longest first",
};

export interface FilterState {
  /** Free text over the title (and the URL, which is the only thing a failed job has). */
  query: string;
  /** `""` means "any". */
  status: string;
  format: string;
  /** A host for downloads, a source label for videos; both come from `sourceHostOf`. */
  source: string;
  sort: SortKey;
}

export const DEFAULT_FILTER: FilterState = { query: "", status: "", format: "", source: "", sort: "recency" };

/** `""` in a filter slot means "any", so an empty dropdown is the unfiltered state. */
const ANY = "";

/**
 * The value the `source` filter compares against: `pageUrl`'s host first, then the
 * synced-history host, then the media URL's hostname, then the raw source label
 * (`manual-url`).
 *
 * `pageUrl` leads because the media `url` is usually a CDN — a different
 * `googlevideo.com` host per video, which is useless as a filter and contradicts the
 * popup tray's site chip one click away. Same precedence `download_sync.js` uses when it
 * writes `sourceHost`, so the facet list and the stored data agree.
 *
 * Entries synced before the precedence changed carry a CDN `sourceHost` and no
 * `pageUrl`, and keep it until they are rewritten — self-healing, and still better than
 * the CDN host alone.
 */
export function sourceHostOf(item: FilterableItem): string {
  if (item.pageUrl) {
    try {
      const host = new URL(item.pageUrl).hostname;
      if (host) {
        return host;
      }
    } catch (_error) {
      // Not a URL — fall through.
    }
  }
  if (item.sourceHost) {
    return item.sourceHost;
  }
  if (item.url) {
    try {
      const host = new URL(item.url).hostname;
      if (host) {
        return host;
      }
    } catch (_error) {
      // Not a URL — fall through to the source label.
    }
  }
  return String(item.source || "");
}

function textOf(item: FilterableItem): string {
  return `${item.title || ""} ${item.url || ""}`.toLowerCase();
}

function recencyOf(item: FilterableItem): number {
  const value = Number(item.completedAt ?? item.updatedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}
function sizeOf(item: FilterableItem): number {
  const value = Number(item.sizeBytes ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function durationOf(item: FilterableItem): number {
  const value = Number(item.durationSeconds ?? 0);
  return Number.isFinite(value) ? value : 0;
}

const COMPARATORS: Record<SortKey, (a: FilterableItem, b: FilterableItem) => number> = {
  recency: (a, b) => recencyOf(b) - recencyOf(a),
  title: (a, b) => String(a.title || "").localeCompare(String(b.title || "")),
  size: (a, b) => sizeOf(b) - sizeOf(a),
  status: (a, b) => String(a.status || "").localeCompare(String(b.status || "")),
  source: (a, b) => sourceHostOf(a).localeCompare(sourceHostOf(b)),
  duration: (a, b) => durationOf(b) - durationOf(a),
};

function matches(item: FilterableItem, filter: FilterState): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query && !textOf(item).includes(query)) {
    return false;
  }
  if (filter.status !== ANY && String(item.status || "") !== filter.status) {
    return false;
  }
  if (filter.format !== ANY && String(item.format || "") !== filter.format) {
    return false;
  }
  if (filter.source !== ANY && sourceHostOf(item) !== filter.source) {
    return false;
  }
  return true;
}

/**
 * Apply one filter state to a list.
 *
 * Sort ties break on recency and then on the input order, so re-sorting a list that
 * has no distinguishing key cannot shuffle rows the user is looking at — the same
 * reason the download list merges a progress tick in place instead of reordering.
 */
export function filterAndSort<T extends FilterableItem>(items: readonly T[], filter: FilterState): T[] {
  const compare = COMPARATORS[filter.sort] || COMPARATORS.recency;
  const indexed = items.map((item, index) => ({ item, index }));
  const kept = indexed.filter((entry) => matches(entry.item, filter));

  kept.sort((a, b) => compare(a.item, b.item) || recencyOf(b.item) - recencyOf(a.item) || a.index - b.index);
  return kept.map((entry) => entry.item);
}

/**
 * The distinct values a dropdown should offer, in display order.
 *
 * Computed from the unfiltered list by the caller, deliberately: offering only the
 * values that survive the current filter means selecting one value empties the
 * dropdown it came from.
 */
export function facetValues(items: readonly FilterableItem[], pick: (item: FilterableItem) => string): string[] {
  const values = new Set<string>();
  for (const item of items) {
    const value = pick(item).trim();
    if (value) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Merge one field into a filter state, for `onChange` handlers. */
export function patchFilter(filter: FilterState, patch: Partial<FilterState>): FilterState {
  return { ...filter, ...patch };
}
