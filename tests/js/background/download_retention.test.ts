import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as tabState from "../../../src/background/tab_state.js";
import { nativeRequest } from "../../../src/background/native_requests.js";
import type { DownloadJobRecord } from "../../../src/background/types.js";

// Nothing in the retention path may reach the native host: per-row *Remove*
// (`download_operations.ts`) is the only thing allowed to delete a file, and it does it
// through `nativeRequest`. Mocking the module — the service worker's one channel to the
// host — turns "the prune never deletes a file" into an assertion instead of a promise.
vi.mock("../../../src/background/native_requests.js", () => ({
  nativeRequest: vi.fn(async () => ({ ok: true })),
}));

/**
 * `global-downloads-spec.md` §5.8 — the tray is global now, so the popup reads the whole
 * `qwinDownloadsById` map on every open, and the manifest asks for no `unlimitedStorage`.
 * Retention is the bound on both: the newest 200 *terminal* jobs survive, active jobs
 * survive regardless of age, and nothing on the path can delete a file.
 */
describe("tab_state download retention (§5.8)", () => {
  const LIMIT = tabState.MAX_STORED_TERMINAL_JOBS;

  /** `terminal-${i}` finished at `i`; `active-${i}` running since before every terminal. */
  function seed(terminalCount: number, activeCount: number): void {
    const jobs: Record<string, DownloadJobRecord> = {};
    for (let i = 0; i < terminalCount; i++) {
      jobs[`terminal-${i}`] = { id: `terminal-${i}`, status: "done", filepath: `C:/v/${i}.mp4`, updatedAt: i };
    }
    for (let i = 0; i < activeCount; i++) {
      jobs[`active-${i}`] = { id: `active-${i}`, status: "running", updatedAt: -1 };
    }
    tabState.setAllDownloads(jobs);
  }

  beforeEach(() => {
    tabState.setAllDownloads({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps the number at 200, mirroring MAX_SYNCED_ENTRIES", () => {
    expect(LIMIT).toBe(200);
  });

  it("keeps exactly the newest 200 terminal jobs", () => {
    seed(LIMIT + 35, 0);
    expect(tabState.pruneTerminalJobs()).toBe(true);

    const kept = Object.keys(tabState.getAllDownloads());
    expect(kept).toHaveLength(LIMIT);
    // Newest-first ordering: the 35 oldest are the ones gone.
    expect(kept).not.toContain("terminal-0");
    expect(kept).not.toContain("terminal-34");
    expect(kept).toContain(`terminal-${LIMIT + 34}`);
  });

  it("keeps every active job regardless of age", () => {
    seed(LIMIT + 35, 4);
    tabState.pruneTerminalJobs();

    for (let i = 0; i < 4; i++) {
      expect(tabState.getDownload(`active-${i}`)).toMatchObject({ status: "running" });
    }
  });

  it("keeps a malformed record (no status reads as queued) rather than dropping it", () => {
    tabState.setAllDownloads({ "no-status": { id: "no-status" } });
    tabState.pruneTerminalJobs();
    expect(tabState.getDownload("no-status")).not.toBeNull();
  });

  it("reports nothing to do when the store is already inside the cap", () => {
    seed(LIMIT - 1, 3);
    expect(tabState.pruneTerminalJobs()).toBe(false);
    expect(Object.keys(tabState.getAllDownloads())).toHaveLength(LIMIT + 2);
  });

  it("prunes on a terminal transition, not only on an explicit call", async () => {
    seed(LIMIT + 10, 1);
    await tabState.updateDownload("job-finishing", { status: "done" });
    expect(Object.keys(tabState.getAllDownloads())).toHaveLength(LIMIT + 1);
  });

  it("does not prune on a progress tick", async () => {
    seed(LIMIT + 10, 1);
    await tabState.updateDownload("active-0", { status: "running", percent: 50 });
    expect(Object.keys(tabState.getAllDownloads())).toHaveLength(LIMIT + 11);
  });

  it("never touches the filesystem — the native host is not called at all", async () => {
    seed(LIMIT + 10, 2);
    tabState.pruneTerminalJobs();
    await tabState.updateDownload("active-0", { status: "done" });

    expect(vi.mocked(nativeRequest)).not.toHaveBeenCalled();
  });

  it("persists only the downloads key when it prunes", () => {
    seed(LIMIT + 10, 0);
    tabState.pruneTerminalJobs();

    const set = vi.spyOn(chrome.storage.local, "set");
    tabState.persistDownloads();

    const written = set.mock.lastCall?.[0] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["qwinDownloadsById"]);
    expect(Object.keys(written.qwinDownloadsById as object)).toHaveLength(LIMIT);
  });
});
