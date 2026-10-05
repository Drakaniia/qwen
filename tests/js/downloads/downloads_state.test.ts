/**
 * The downloads page's two data sources and the views derived from them.
 *
 * The point of this file is the key names: `qwinDownloadsById` in `storage.local` and
 * `qwinDownloadHistory` in `storage.sync` were read off `background/tab_state.js` and
 * the background's message handlers, not assumed. If either key or either transport
 * moves, the first two assertions here fail instead of the page quietly showing an
 * empty list forever.
 *
 * The rest pins the behaviour that is easy to regress: merging a `downloadUpdated` tick
 * in place, passing the job's own `tabId` to the three actions that resolve a tab
 * through `senderTabId` (an extension page has no sender tab), and the §7 derivations —
 * one record list, day grouping, the facet lists, and per-row Open / Reveal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAY_LABELS,
  clearAll,
  DOWNLOADS_STORAGE_KEY,
  dayKeyOf,
  facets,
  failedJobs,
  filter,
  groups,
  history,
  jobs,
  loadAll,
  loadJobs,
  loadTheme,
  newestSaved,
  notice,
  openRecord,
  records,
  revealRecord,
  retryAllFailed,
  runJobAction,
  SETTINGS_STORAGE_KEY,
  syncEnabled,
  theme,
  visibleJobs,
  watchUpdates,
} from "../../../src/popup/downloads/state.js";

const JOB_A = { id: "a", title: "Alpha", tabId: 7, status: "error", updatedAt: 200, filepath: "C:/out/a.mp4" };
const JOB_B = { id: "b", title: "Beta", tabId: 9, status: "running", updatedAt: 300 };

let sent: Array<Record<string, unknown>> = [];
let storedDownloads: Record<string, unknown> = {};
let storedSettings: Record<string, unknown> = {};

/**
 * `browser_api` is callback-mode in these tests and calls `sendMessage(message, cb)`,
 * which the MV3 overload set in `@types/chrome` does not describe. One cast, here,
 * rather than seven.
 */
type Callback = (response: unknown) => void;
type SendMessage = (message: unknown, callback?: Callback) => void;

function mockSendMessage(handler: SendMessage): void {
  (chrome.runtime.sendMessage as unknown as { mockImplementation: (fn: SendMessage) => void }).mockImplementation(
    handler,
  );
}

/** The two-argument callback form, recording every message the page sends. */
function stubChrome(options: { history?: unknown; syncEnabled?: boolean } = {}) {
  sent = [];
  storedDownloads = { [DOWNLOADS_STORAGE_KEY]: { a: JOB_A, b: JOB_B } };
  storedSettings = {};

  mockSendMessage((message, callback) => {
    const request = message as Record<string, unknown>;
    sent.push(request);

    let response: unknown = { ok: true };
    if (request.type === "getDownloadSyncHistory") {
      response = {
        ok: true,
        history: options.history ?? [],
        syncInfo: { totalCount: 0, syncEnabled: options.syncEnabled !== false },
      };
    }
    callback?.(response);
  });

  vi.mocked(chrome.storage.local.get).mockImplementation((keys, callback) => {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted) {
      if (key === DOWNLOADS_STORAGE_KEY) {
        out[key] = storedDownloads[key];
      }
      if (key === SETTINGS_STORAGE_KEY) {
        out[key] = storedSettings[key];
      }
    }
    callback?.(structuredClone(out));
  });
}

beforeEach(() => {
  jobs.value = [];
  history.value = [];
  filter.value = { query: "", status: "", format: "", source: "", sort: "recency" };
  notice.value = "";
  syncEnabled.value = true;
  theme.value = "system";
  stubChrome();
});

afterEach(() => {
  jobs.value = [];
  history.value = [];
  document.documentElement.removeAttribute("data-theme");
});

describe("storage keys", () => {
  it("reads active jobs from the key the background writes in storage.local", async () => {
    expect(DOWNLOADS_STORAGE_KEY).toBe("qwinDownloadsById");

    await loadJobs();

    expect(vi.mocked(chrome.storage.local.get).mock.calls[0][0]).toBe("qwinDownloadsById");
    expect(jobs.value.map((job) => job.id)).toEqual(["a", "b"]);
  });

  it("reads completed history through the message that owns storage.sync", async () => {
    expect(SETTINGS_STORAGE_KEY).toBe("qwinSettings");

    stubChrome({ history: [{ title: "Old", status: "done", completedAt: 1 }], syncEnabled: false });
    await loadAll();

    expect(sent.some((message) => message.type === "getDownloadSyncHistory")).toBe(true);
    expect(history.value).toHaveLength(1);
    expect(syncEnabled.value).toBe(false);
  });

  it("leaves history alone when the message fails", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "no sync" }));
    await loadAll();
    expect(history.value).toEqual([]);
  });

  it("survives a storage.local miss instead of throwing", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys: unknown, callback?: (items: unknown) => void) =>
      callback?.({}),
    );
    await loadJobs();
    expect(jobs.value).toEqual([]);
  });
});

describe("watchUpdates", () => {
  it("merges a progress tick in place instead of reordering the list", () => {
    const stop = watchUpdates();
    jobs.value = [JOB_B, JOB_A];

    const tick = { ...JOB_B, percent: 42 };
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
      message: unknown,
    ) => void;
    listener({ type: "downloadUpdated", job: tick });

    expect(jobs.value.map((job) => job.id)).toEqual(["b", "a"]);
    expect(jobs.value[0].percent).toBe(42);
    stop();
  });

  it("prepends a job it has not seen", () => {
    const stop = watchUpdates();
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
      message: unknown,
    ) => void;
    listener({ type: "downloadUpdated", job: { id: "new", status: "queued" } });
    expect(jobs.value[0].id).toBe("new");
    stop();
  });

  it("drops a removed job and replaces the map on downloadsCleared", () => {
    const stop = watchUpdates();
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as (
      message: unknown,
    ) => void;

    jobs.value = [JOB_A, JOB_B];
    listener({ type: "downloadRemoved", jobId: "a" });
    expect(jobs.value.map((job) => job.id)).toEqual(["b"]);

    listener({ type: "downloadsCleared", downloads: [{ id: "b", status: "running" }] });
    expect(jobs.value).toHaveLength(1);
    stop();
  });
});

describe("runJobAction", () => {
  it("passes the job's own tabId, because an extension page has no sender tab", async () => {
    await runJobAction("retry", JOB_B);
    expect(sent).toContainEqual({ type: "retryDownload", tabId: 9, jobId: "b" });
  });

  it("routes every action to its existing popup_api export", async () => {
    for (const [action, type] of [
      ["pause", "pauseDownload"],
      ["resume", "resumeDownload"],
      ["cancel", "cancelDownload"],
      ["open-file", "openDownloadedFile"],
      ["show-folder", "showDownloadedFile"],
      ["remove", "removeDownload"],
    ] as const) {
      sent = [];
      await runJobAction(action, JOB_A);
      expect(sent[0]).toEqual({ type, tabId: JOB_A.tabId, jobId: "a" });
    }
  });

  it("returns the failure message instead of throwing", async () => {
    mockSendMessage((_message, callback) =>
      callback?.({ ok: false, error: "That download has no saved file path yet." }),
    );
    await expect(runJobAction("open-file", JOB_A)).resolves.toBe("That download has no saved file path yet.");
  });

  it("does nothing for the inert 'none' placeholder", async () => {
    await expect(runJobAction("none", JOB_B)).resolves.toBe("");
    expect(sent).toEqual([]);
  });
});

describe("per-row Open and Reveal (spec §7)", () => {
  it("opens the row's own file, not the newest one", async () => {
    jobs.value = [
      { ...JOB_A, filepath: "C:/out/a.mp4", updatedAt: 1 },
      { id: "b", title: "Beta", tabId: 9, status: "done", filepath: "C:/out/b.mp4", updatedAt: 999 },
    ];

    await openRecord(records.value.find((record) => record.key === "a")!);

    expect(sent[0]).toEqual({ type: "openDownloadedFile", tabId: JOB_A.tabId, jobId: "a" });
    expect(notice.value).toBe("Opened.");
  });

  it("reveals the row's own file in Explorer", async () => {
    jobs.value = [JOB_A];
    await revealRecord(records.value[0]);
    expect(sent[0]).toEqual({ type: "showDownloadedFile", tabId: JOB_A.tabId, jobId: "a" });
  });

  it("says so instead of pretending, for a synced entry with no file on record", async () => {
    history.value = [{ title: "Synced", url: "https://media.example.org/x.mp4", completedAt: Date.now() }];

    await openRecord(records.value[0]);

    expect(sent).toEqual([]);
    expect(notice.value).toBe("That entry has no saved file on record.");
  });

  it("surfaces the background's refusal rather than swallowing it", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "no path yet" }));
    jobs.value = [JOB_A];

    await revealRecord(records.value[0]);

    expect(notice.value).toBe("no path yet");
  });
});

describe("bulk actions", () => {
  it("retries every failed job and says how many", async () => {
    jobs.value = [JOB_A, JOB_B];
    await retryAllFailed();

    expect(sent.filter((message) => message.type === "retryDownload")).toHaveLength(1);
    expect(notice.value).toBe("Retried 1.");
  });

  it("says so when there is nothing failed to retry", async () => {
    jobs.value = [JOB_B];
    await retryAllFailed();
    expect(sent).toEqual([]);
    expect(notice.value).toBe("No failed downloads.");
  });

  it("clears jobs *and* synced history, so the history cannot reappear after the jobs are gone", async () => {
    jobs.value = [JOB_A, JOB_B];
    await clearAll();

    expect(sent[0].type).toBe("clearDownloads");
    expect(sent[1].type).toBe("clearDownloadSyncHistory");
    expect(failedJobs.value).toHaveLength(1);
  });

  it("reports a failure from clearAll instead of pretending it worked", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "busy" }));
    await clearAll();
    expect(notice.value).toBe("busy");
  });
});

describe("records", () => {
  it("puts both sources in one list, newest first", () => {
    jobs.value = [{ id: "j", title: "Live", status: "running", updatedAt: 100 }];
    history.value = [{ title: "Synced", status: "done", completedAt: 500 }];

    expect(records.value.map((record) => record.title)).toEqual(["Synced", "Live"]);
  });

  it("drops a synced entry the job list already carries, because the job row can open it", () => {
    jobs.value = [{ id: "j", title: "Live", status: "done", url: "https://cdn.example.com/a.mp4", updatedAt: 1 }];
    history.value = [
      { title: "Live", url: "https://cdn.example.com/a.mp4", completedAt: 2 },
      { title: "Other", url: "https://cdn.example.com/b.mp4", completedAt: 3 },
    ];

    expect(records.value.map((record) => record.title)).toEqual(["Other", "Live"]);
  });

  it("gives a synced entry no job, which is why it offers no Open", () => {
    history.value = [{ title: "Synced", status: "done", completedAt: 1 }];
    expect(records.value[0].job).toBeUndefined();
    expect(records.value[0].live).toBe(false);
  });

  it("formats the size with the shared formatter and omits an unknown one", () => {
    jobs.value = [
      { id: "a", title: "A", status: "done", totalSize: "128MiB", updatedAt: 2 },
      { id: "b", title: "B", status: "queued", updatedAt: 1 },
    ];
    expect(records.value.map((record) => record.size)).toEqual(["128.0 MB", ""]);
  });
});

describe("day grouping (spec §7)", () => {
  it("buckets by local calendar day, and an undated row is Earlier", () => {
    const at = (daysAgo: number, hour = 12) => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(hour, 0, 0, 0);
      return date.getTime();
    };

    expect(dayKeyOf(at(0))).toBe("today");
    expect(dayKeyOf(at(1))).toBe("yesterday");
    expect(dayKeyOf(at(4))).toBe("week");
    expect(dayKeyOf(at(40))).toBe("earlier");
    expect(dayKeyOf(0)).toBe("earlier");
  });

  it("puts a late-evening row in Today and a small-hours one in Yesterday", () => {
    const late = new Date();
    late.setHours(23, 30, 0, 0);
    const early = new Date();
    early.setDate(early.getDate() - 1);
    early.setHours(0, 30, 0, 0);

    expect(dayKeyOf(late.getTime())).toBe("today");
    expect(dayKeyOf(early.getTime())).toBe("yesterday");
  });

  it("names the four groups and omits the empty ones", () => {
    jobs.value = [
      { id: "today", title: "Now", status: "running", updatedAt: Date.now() },
      { id: "old", title: "Long ago", status: "done", updatedAt: Date.now() - 40 * 24 * 3600 * 1000 },
    ];

    expect(groups.value.map((group) => group.label)).toEqual([DAY_LABELS.today, DAY_LABELS.earlier]);
    expect(groups.value.map((group) => group.records.length)).toEqual([1, 1]);
  });
});

describe("facets", () => {
  it("offers values from both sources, sorted, blanks dropped", () => {
    jobs.value = [
      { id: "a", title: "A", status: "done", format: "MP4", url: "https://cdn.example.com/a.mp4", updatedAt: 2 },
      { id: "b", title: "B", status: "running", format: "MP4", url: "https://cdn.example.com/a.mp4", updatedAt: 1 },
    ];
    history.value = [
      {
        title: "C",
        status: "done",
        format: "webm",
        url: "https://media.example.org/c.m3u8",
        sourceHost: "media.example.org",
        completedAt: 3,
      },
    ];

    expect(facets.value).toEqual({
      status: ["done", "running"],
      format: ["MP4", "WEBM"],
      source: ["cdn.example.com", "media.example.org"],
    });
  });

  it("keeps offering a value the current filter excludes", () => {
    jobs.value = [
      { id: "a", title: "A", status: "done", updatedAt: 2 },
      { id: "b", title: "B", status: "running", updatedAt: 1 },
    ];
    filter.value = { ...filter.value, status: "running" };

    expect(facets.value.status).toEqual(["done", "running"]);
  });
});

describe("theme (spec §7 / D6)", () => {
  it("defaults to System, which pins nothing", async () => {
    await loadTheme();
    expect(theme.value).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("applies a persisted dark choice to the document before anything renders", async () => {
    storedSettings = { [SETTINGS_STORAGE_KEY]: { theme: "dark" } };

    await loadTheme();

    expect(theme.value).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("treats an unknown stored value as System rather than painting the page wrong", async () => {
    storedSettings = { [SETTINGS_STORAGE_KEY]: { theme: "neon" } };

    await loadTheme();

    expect(theme.value).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("derived views", () => {
  it("picks the newest job with a file for the bulk reveal", () => {
    jobs.value = [
      { ...JOB_A, updatedAt: 1 },
      { ...JOB_B, filepath: "C:/out/b.mp4", updatedAt: 999 },
    ];
    expect(newestSaved.value?.filepath).toBe("C:/out/b.mp4");
  });

  it("offers no target when nothing passing the filter has a file", () => {
    jobs.value = [JOB_B];
    expect(newestSaved.value).toBeNull();
  });

  it("filters the job list through the shared rules", () => {
    jobs.value = [JOB_A, JOB_B];
    filter.value = { ...filter.value, status: "running" };
    expect(visibleJobs.value.map((job) => job.id)).toEqual(["b"]);
  });
});
