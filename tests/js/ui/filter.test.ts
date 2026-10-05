/**
 * The filter + sort rules shared by the downloads page and the popup's video lists.
 *
 * Pure, so no DOM and no signals - the pages own the state, this owns the rules. The
 * cases pinned here are the ones that were easy to get wrong: an empty filter slot
 * meaning "any" rather than "matches the empty string", the host fallback chain, and
 * tie-breaking that cannot reshuffle rows under the cursor.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTER,
  facetValues,
  filterAndSort,
  patchFilter,
  sourceHostOf,
  type FilterState,
  type FilterableItem,
} from "../../../src/ui/filter.js";

/** Rows keep their own fields; the rules only ever read `FilterableItem`. */
type Row = FilterableItem & { id: string };

const JOB: Row[] = [
  {
    id: "a",
    title: "Zebra clip",
    url: "https://cdn.example.com/a.mp4",
    format: "MP4",
    status: "done",
    updatedAt: 300,
    sizeBytes: 10,
  },
  {
    id: "b",
    title: "apple song",
    url: "https://media.youtube.com/b.m4a",
    format: "AUDIO",
    status: "error",
    updatedAt: 200,
    sizeBytes: 30,
  },
  {
    id: "c",
    title: "Mango show",
    url: "not a url",
    source: "manual-url",
    format: "MP4",
    status: "running",
    updatedAt: 100,
    sizeBytes: 20,
  },
];

const withFilter = (patch: Partial<FilterState>): FilterState => patchFilter(DEFAULT_FILTER, patch);

describe("sourceHostOf", () => {
  it("prefers an explicit host, the way download_sync writes one", () => {
    expect(sourceHostOf({ sourceHost: "example.org", url: "https://other.test/x" })).toBe("example.org");
  });

  it("falls back to the URL hostname", () => {
    expect(sourceHostOf({ url: "https://media.example.com:8443/a/b.mp4" })).toBe("media.example.com");
  });

  it("falls back to the source label when the URL will not parse", () => {
    expect(sourceHostOf({ url: "not a url", source: "manual-url" })).toBe("manual-url");
  });

  it("is empty when it has nothing to go on", () => {
    expect(sourceHostOf({})).toBe("");
  });
});

describe("filterAndSort", () => {
  it("returns the newest first by default", () => {
    expect(filterAndSort(JOB, DEFAULT_FILTER).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("treats an empty filter slot as any, not as a match on the empty string", () => {
    expect(filterAndSort(JOB, withFilter({ format: "" }))).toHaveLength(3);
    expect(filterAndSort(JOB, withFilter({ status: "", source: "" }))).toHaveLength(3);
  });

  it("matches free text against the title regardless of case", () => {
    expect(filterAndSort(JOB, withFilter({ query: "APPLE" })).map((item) => item.id)).toEqual(["b"]);
  });

  it("also matches the URL, because a failed job has no title to search", () => {
    expect(filterAndSort(JOB, withFilter({ query: "media.youtube" })).map((item) => item.id)).toEqual(["b"]);
  });

  it("filters on status, format and source host together", () => {
    expect(filterAndSort(JOB, withFilter({ status: "done" })).map((item) => item.id)).toEqual(["a"]);
    expect(filterAndSort(JOB, withFilter({ format: "AUDIO" })).map((item) => item.id)).toEqual(["b"]);
    expect(filterAndSort(JOB, withFilter({ source: "cdn.example.com" })).map((item) => item.id)).toEqual(["a"]);
  });

  it("returns nothing when two filters exclude everything", () => {
    expect(filterAndSort(JOB, withFilter({ status: "done", format: "AUDIO" }))).toEqual([]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterAndSort(JOB, withFilter({ query: "  mango  " })).map((item) => item.id)).toEqual(["c"]);
  });

  it("sorts by title, size and status", () => {
    expect(filterAndSort(JOB, withFilter({ sort: "title" })).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(filterAndSort(JOB, withFilter({ sort: "size" })).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(filterAndSort(JOB, withFilter({ sort: "status" })).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks sort ties on recency, then on input order", () => {
    const tied: Row[] = [
      { id: "first", title: "same", updatedAt: 10 },
      { id: "second", title: "same", updatedAt: 10 },
      { id: "newest", title: "same", updatedAt: 99 },
    ];
    expect(filterAndSort(tied, withFilter({ sort: "title" })).map((item) => item.id)).toEqual([
      "newest",
      "first",
      "second",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [...JOB];
    filterAndSort(input, withFilter({ sort: "title" }));
    expect(input.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("survives a string completedAt, which the synced-history type allows", () => {
    const entries: Row[] = [
      { id: "str", title: "a", completedAt: "300" },
      { id: "num", title: "b", completedAt: 200 },
    ];
    expect(filterAndSort(entries, DEFAULT_FILTER).map((item) => item.id)).toEqual(["str", "num"]);
  });

  it("falls back to the recency comparator for an unknown sort key", () => {
    expect(filterAndSort(JOB, withFilter({ sort: "nonsense" as FilterState["sort"] })).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("facetValues", () => {
  it("lists distinct values in display order and drops blanks", () => {
    expect(facetValues(JOB, (item) => String(item.format || ""))).toEqual(["AUDIO", "MP4"]);
  });

  it("is empty for a list with nothing to offer", () => {
    expect(facetValues([], () => "")).toEqual([]);
  });
});
