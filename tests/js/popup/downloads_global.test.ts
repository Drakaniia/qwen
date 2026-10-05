import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PopupEvent } from "../../../src/shared/contracts.js";

// The listener is registered as a side effect of importing the module, so this harness
// captures whatever `popup_elements.ts` handed it — the real one, not a re-implementation.
vi.mock("../../../src/popup/popup_elements.js", () => ({ api: { runtime: { onMessage: { addListener: vi.fn() } } } }));
vi.mock("../../../src/popup/popup_helpers.js", () => ({ checkHelperStatus: vi.fn(async () => {}) }));

const { activeTabId } = await import("../../../src/popup/state/app.js");
const { currentDownloads } = await import("../../../src/popup/state/downloads.js");
const { currentVideos } = await import("../../../src/popup/state/videos.js");
const { api } = await import("../../../src/popup/popup_elements.js");
await import("../../../src/popup/popup_background_events.js");

const listener = vi.mocked(api.runtime.onMessage.addListener).mock.calls[0][0] as (message: PopupEvent) => void;

/**
 * `global-downloads-spec.md` §5.2 — the reported bug, one side of it.
 *
 * A download started in tab A and a popup opened on tab B used to be dropped by the
 * `job.tabId !== activeTabId.value` guard, so the tray read "No downloads yet" while the
 * job was running and the header badge was counting it. The list is global now, so a
 * foreign `tabId` is provenance, not a filter.
 */
describe("popup tray is global — downloadUpdated from a foreign tab", () => {
  beforeEach(() => {
    activeTabId.value = 2;
    currentDownloads.value = [];
  });

  it("applies a tick whose tabId is not the active tab", () => {
    listener({ type: "downloadUpdated", job: { id: "job-a", tabId: 7, status: "running", percent: 40 } });

    expect(currentDownloads.value).toHaveLength(1);
    expect(currentDownloads.value[0]).toMatchObject({ id: "job-a", tabId: 7, percent: 40 });
  });

  it("keeps tabId on the record — the row's site chip and resume read it", () => {
    listener({
      type: "downloadUpdated",
      job: { id: "job-a", tabId: 7, status: "running", pageUrl: "https://www.youtube.com/watch?v=x" },
    });

    expect(currentDownloads.value[0].tabId).toBe(7);
  });

  it("applies a job with no tabId at all (an older record)", () => {
    listener({ type: "downloadUpdated", job: { id: "job-legacy", status: "done" } });

    expect(currentDownloads.value.map((job) => job.id)).toEqual(["job-legacy"]);
  });

  it("merges a follow-up tick in place rather than duplicating", () => {
    listener({ type: "downloadUpdated", job: { id: "job-a", tabId: 7, status: "running", percent: 40 } });
    listener({ type: "downloadUpdated", job: { id: "job-a", tabId: 7, status: "done", percent: 100 } });

    expect(currentDownloads.value).toHaveLength(1);
    expect(currentDownloads.value[0]).toMatchObject({ status: "done", percent: 100 });
  });

  it("still leaves the *video* list tab-scoped", () => {
    // The bug was a scoping bug, and the fix is scoped too: `videoListUpdated` keeps its
    // `tabId` guard, so Media must not turn global by accident.
    currentVideos.value = [];
    listener({ type: "videoListUpdated", tabId: 7, videos: [{ id: "v1", url: "https://cdn/v.mp4", format: "mp4" }] });

    expect(currentVideos.value).toEqual([]);
  });
});
