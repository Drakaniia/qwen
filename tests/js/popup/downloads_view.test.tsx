/**
 * The tray's bulk verb over the active list: one **Pause all** while something is
 * moving, one **Resume all** once nothing is, and nothing at all when neither applies.
 *
 * There is no `pauseAll` background message. The button is a loop over
 * `runDownloadAction("pause", jobId)` — the same per-job verb the rows already dispatch —
 * so these tests pin the *set* it loops over and that it loops once per member.
 */
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DownloadsView } from "../../../src/popup/views/DownloadsView.js";
import { helperStatus } from "../../../src/popup/state/app.js";
import { currentDownloads, type DownloadJob } from "../../../src/popup/state/downloads.js";

vi.mock("../../../src/popup/popup_actions.js", () => ({
  runDownloadAction: vi.fn(async () => ""),
  startVideoDownload: vi.fn(async () => {}),
}));

const { runDownloadAction } = await import("../../../src/popup/popup_actions.js");

const job = (id: string, status: string, extra: Partial<DownloadJob> = {}) =>
  ({ id, status, title: id, percent: 40, ...extra }) as DownloadJob;

function tray(): HTMLElement {
  return render(<DownloadsView />).container as HTMLElement;
}

/** The bulk control only. Per-row Pause/Resume say neither word. */
function bulk(host: Element): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => / all$/.test((b.textContent || "").trim())) as
    | HTMLButtonElement
    | undefined;
}

/**
 * One more microtask turn. The control releases its lock in the continuation *after* the
 * awaited calls resolve, and `act` returns one flush earlier than that in happy-dom.
 */
const settle = () => act(async () => Promise.resolve());

beforeEach(() => {
  // A disconnected helper short-circuits the whole tray into an EmptyState, which would
  // make every assertion below pass for the wrong reason.
  helperStatus.value = { connected: true, version: "1.0", missing: [] };
  currentDownloads.value = [];
  vi.mocked(runDownloadAction).mockClear();
  vi.mocked(runDownloadAction).mockResolvedValue("");
});

afterEach(() => cleanup());

describe("the tray's groups", () => {
  /** Each rendered group's heading and the job ids under it, in order. */
  const groups = (host: Element) =>
    [...host.querySelectorAll("section")].map((section) => ({
      heading: section.querySelector("h2")?.textContent,
      // A row's text carries its title, which is the id, twice; the lookahead stops at the
      // next field so `j-q1` is not read as `j-q1j-q140`.
      ids: [...section.querySelectorAll("li")].map((li) => li.textContent?.match(/j-[a-z0-9]+?(?=j-|$)/)?.[0]),
    }));

  it("splits moving, waiting, failed and done jobs, and counts the queue", () => {
    currentDownloads.value = [
      job("j-done", "done", { updatedAt: 5 }),
      job("j-q2", "queued", { createdAt: 2 }),
      job("j-running", "running"),
      job("j-error", "error"),
      job("j-q1", "queued", { createdAt: 1 }),
      job("j-paused", "paused"),
      job("j-canceled", "canceled", { updatedAt: 9 }),
    ];
    expect(groups(tray())).toEqual([
      { heading: "Active", ids: ["j-running", "j-paused"] },
      { heading: "Queued · 2", ids: ["j-q1", "j-q2"] },
      { heading: "Failed", ids: ["j-error"] },
      { heading: "Finished", ids: ["j-canceled", "j-done"] },
    ]);
  });

  it("renders no heading for an empty group", () => {
    currentDownloads.value = [job("j-done", "done")];
    const host = tray();
    expect(groups(host).map((group) => group.heading)).toEqual(["Finished"]);
    expect(host.textContent).toContain("Nothing is downloading right now.");
  });

  it("offers Clear finished when only failures are left — it forgets those records too", () => {
    currentDownloads.value = [job("j-error", "error")];
    const host = tray();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Clear finished"))).toBe(true);
  });

  it("caps the finished group at 20 and says how many it left out", () => {
    currentDownloads.value = Array.from({ length: 23 }, (_, index) => job(`j-${index}`, "done"));
    const host = tray();
    expect(host.querySelectorAll("li")).toHaveLength(20);
    expect(host.textContent).toContain("3 more in All downloads");
  });
});

describe("the tray's bulk verb", () => {
  it("is absent when nothing is running", () => {
    // A queued job and a finished one are the two states that must not summon it. The
    // row assertions are here so "absent" cannot pass by rendering the EmptyState
    // instead of the tray.
    currentDownloads.value = [job("j-queued", "queued"), job("j-done", "done")];
    const host = tray();
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(bulk(host)).toBeUndefined();
  });

  it("is absent when there are no jobs at all", () => {
    expect(bulk(tray())).toBeUndefined();
  });

  it("offers Pause all while a download is moving", () => {
    currentDownloads.value = [job("j-running", "running")];
    expect(bulk(tray())?.textContent).toContain("Pause all");
  });

  it("offers Resume all once everything it would have paused is paused", () => {
    currentDownloads.value = [job("j-paused", "paused"), job("j-queued", "queued")];
    expect(bulk(tray())?.textContent).toContain("Resume all");
  });

  it("pauses exactly the moving jobs — the queue keeps its place", async () => {
    currentDownloads.value = [
      job("j-running", "running"),
      job("j-connecting", "connecting"),
      job("j-queued", "queued"),
      job("j-done", "done"),
    ];
    const button = bulk(tray());
    await act(async () => button?.click());
    expect(vi.mocked(runDownloadAction).mock.calls).toEqual([
      ["pause", "j-running"],
      ["pause", "j-connecting"],
    ]);
  });

  it("resumes each paused job", async () => {
    currentDownloads.value = [job("j-a", "paused"), job("j-b", "paused")];
    const button = bulk(tray());
    await act(async () => button?.click());
    expect(vi.mocked(runDownloadAction).mock.calls).toEqual([
      ["resume", "j-a"],
      ["resume", "j-b"],
    ]);
  });

  it("locks itself for the round trip, so one click cannot queue two batches", async () => {
    let release: (value: string) => void = () => {};
    vi.mocked(runDownloadAction).mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    currentDownloads.value = [job("j-running", "running")];
    // Re-queried each time rather than held: the point is the rendered state, and a
    // held node would go stale the moment the control re-renders.
    const host = tray();
    const disabled = () => (bulk(host) as HTMLButtonElement).disabled;
    expect(disabled()).toBe(false);
    await act(async () => {
      (bulk(host) as HTMLButtonElement).click();
    });
    expect(disabled()).toBe(true);
    await act(async () => {
      release("");
    });
    await settle();
    expect(disabled()).toBe(false);
  });

  it("re-enables after a failed job — the notice is `runDownloadAction`'s, not this button's", async () => {
    vi.mocked(runDownloadAction).mockResolvedValue("helper said no");
    currentDownloads.value = [job("j-running", "running")];
    const host = tray();
    await act(async () => (bulk(host) as HTMLButtonElement).click());
    await settle();
    expect((bulk(host) as HTMLButtonElement).disabled).toBe(false);
  });
});
