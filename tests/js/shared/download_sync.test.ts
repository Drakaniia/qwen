import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addSyncedDownload,
  clearSyncedHistory,
  getSyncedHistory,
  getSyncInfo,
  isSyncEnabled,
  loadSyncHistory,
  persistSyncHistory,
  setSyncEnabled,
} from "../../../src/shared/download_sync.js";
import type { SyncedDownloadEntry } from "../../../src/shared/contracts.js";

/**
 * The rejection table below feeds `addSyncedDownload` jobs it is meant to refuse, so the
 * table is `[label, unknown]` and the cast is at the one call site that pins the refusal.
 */
type Job = Parameters<typeof addSyncedDownload>[0];

// The module keeps singleton state; reset both halves of it around every test.
beforeEach(() => {
  setSyncEnabled(true);
  clearSyncedHistory();
});

afterEach(() => {
  setSyncEnabled(true);
});

describe("addSyncedDownload", () => {
  it("accepts a final-state job and derives sourceHost", () => {
    expect(
      addSyncedDownload({
        id: "j1",
        url: "https://cdn.example.com/a.mp4",
        status: "done",
        updatedAt: 1000,
        createdAt: 500,
        filepath: "C:/out/a.mp4",
        totalSize: "10 MB",
        format: "MP4",
      }),
    ).toBe(true);

    expect(getSyncedHistory()).toEqual([
      {
        id: "j1",
        url: "https://cdn.example.com/a.mp4",
        title: "Unknown",
        format: "MP4",
        status: "done",
        filepath: "C:/out/a.mp4",
        totalSize: "10 MB",
        sourceHost: "cdn.example.com",
        createdAt: 500,
        completedAt: 1000,
      },
    ]);
  });

  it.each([
    ["null job", null],
    ["no id", { status: "done" }],
    ["running status", { id: "j", status: "running" }],
    ["queued status", { id: "j", status: "queued" }],
    ["paused status", { id: "j", status: "paused" }],
    ["no status", { id: "j" }],
  ])("rejects: %s", (_label, job) => {
    expect(addSyncedDownload(job as Job)).toBe(false);
    expect(getSyncedHistory()).toEqual([]);
  });

  it.each(["done", "error", "canceled"])("accepts status %s", (status) => {
    expect(addSyncedDownload({ id: "j", status })).toBe(true);
  });

  it("keeps one entry per id, replacing on repeat", () => {
    addSyncedDownload({ id: "j1", status: "done", updatedAt: 10 });
    addSyncedDownload({ id: "j1", status: "error", updatedAt: 20, filepath: "C:/x" });
    const history = getSyncedHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: "error", completedAt: 20, filepath: "C:/x" });
  });

  it("sorts newest-first by completedAt", () => {
    addSyncedDownload({ id: "a", status: "done", updatedAt: 1 });
    addSyncedDownload({ id: "b", status: "done", updatedAt: 3 });
    addSyncedDownload({ id: "c", status: "done", updatedAt: 2 });
    expect(getSyncedHistory().map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("falls back to Date.now() when updatedAt is missing", () => {
    const before = Date.now();
    addSyncedDownload({ id: "a", status: "done" });
    const [entry] = getSyncedHistory();
    expect(entry.completedAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("caps history at 200 entries", () => {
    for (let i = 0; i < 250; i += 1) {
      addSyncedDownload({ id: `j${i}`, status: "done", updatedAt: i });
    }
    const history = getSyncedHistory();
    expect(history).toHaveLength(200);
    expect(history[0].id).toBe("j249");
    expect(history.at(-1)?.id).toBe("j50");
  });

  it("returns false and stores nothing while sync is disabled", () => {
    setSyncEnabled(false);
    expect(addSyncedDownload({ id: "a", status: "done" })).toBe(false);
    expect(getSyncedHistory()).toEqual([]);
  });
});

describe("getSyncedHistory", () => {
  it("returns a copy, not the live array", () => {
    addSyncedDownload({ id: "a", status: "done" });
    const first = getSyncedHistory();
    first.push({ id: "injected" } as SyncedDownloadEntry);
    expect(getSyncedHistory()).toHaveLength(1);
  });

  it("is empty by default", () => {
    expect(getSyncedHistory()).toEqual([]);
  });
});

describe("clearSyncedHistory", () => {
  it("empties history and resets lastSyncTimestamp", () => {
    addSyncedDownload({ id: "a", status: "done" });
    expect(getSyncInfo().lastSyncTimestamp).not.toBeNull();
    clearSyncedHistory();
    expect(getSyncedHistory()).toEqual([]);
    expect(getSyncInfo().lastSyncTimestamp).toBeNull();
  });
});

describe("getSyncInfo", () => {
  it("reports counts, the enabled flag, and a permanently false isSyncing", () => {
    expect(getSyncInfo()).toEqual({
      totalCount: 0,
      lastSyncTimestamp: null,
      isSyncing: false,
      syncEnabled: true,
    });
  });

  it("tracks totalCount as entries are added", () => {
    addSyncedDownload({ id: "a", status: "done" });
    expect(getSyncInfo().totalCount).toBe(1);
  });
});

describe("loadSyncHistory / persistSyncHistory", () => {
  const entry = (id: string, completedAt: number) => ({ id, url: `https://x/${id}`, status: "done", completedAt });

  it.each([
    ["invalid json", "not json"],
    ["a json object", "{}"],
    ["null", "null"],
  ])("keeps existing state on %s", (_label, json) => {
    addSyncedDownload({ id: "kept", status: "done", updatedAt: 5 });
    loadSyncHistory(json);
    expect(getSyncedHistory().map((e) => e.id)).toEqual(["kept"]);
  });

  it("replaces state from an array", () => {
    loadSyncHistory(JSON.stringify([entry("a", 1), entry("b", 2)]));
    expect(getSyncedHistory().map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("drops entries with a non-string id, url or status", () => {
    loadSyncHistory(
      JSON.stringify([entry("a", 1), { id: 1, url: "u", status: "done" }, { id: "b", status: "done" }, null]),
    );
    expect(getSyncedHistory().map((e) => e.id)).toEqual(["a"]);
  });

  it("round-trips through persistSyncHistory", () => {
    addSyncedDownload({ id: "a", status: "done", updatedAt: 7, url: "https://x/a.mp4" });
    const json = persistSyncHistory();
    clearSyncedHistory();
    expect(getSyncedHistory()).toEqual([]);
    loadSyncHistory(json);
    expect(getSyncedHistory()[0]).toMatchObject({ id: "a", url: "https://x/a.mp4", completedAt: 7 });
  });

  it("persists an empty array when there is nothing to store", () => {
    expect(persistSyncHistory()).toBe("[]");
  });
});

describe("isSyncEnabled / setSyncEnabled", () => {
  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ["yes", true],
    [undefined, false],
  ])("setSyncEnabled(%j) -> isSyncEnabled() === %j", (value, expected) => {
    setSyncEnabled(value as boolean);
    expect(isSyncEnabled()).toBe(expected);
  });

  it("clears history on disable so it is not re-persisted later", () => {
    addSyncedDownload({ id: "a", status: "done" });
    setSyncEnabled(false);
    expect(getSyncedHistory()).toEqual([]);
    setSyncEnabled(true);
    expect(getSyncedHistory()).toEqual([]);
  });
});
