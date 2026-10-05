import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as tabState from "../../../src/background/tab_state.js";
import {
  cleanProgressText,
  downloadProgressMessage,
  normalizeDownloadProgress,
  progressDetailPatchFromMessage,
  resetDownloadProgressDetails,
} from "../../../src/background/download_state.js";
import { normalizeDownloadProgress as normalizeJobProgress } from "../../../src/background/download_helpers.js";

/**
 * D7 / `real-progress-spec.md` §4.2 — "a percent never decreases *within* a stage;
 * when `stage` changes, the baseline resets".
 *
 * `normalizeDownloadProgress` here is the pure form (existing percent, incoming
 * percent, did-the-stage-change). The stage *comparison* lives one layer up, in
 * `download_helpers.ts`'s job-aware wrapper, covered below.
 *
 * What this replaces: `Math.max(previous, next)` monotonic **forever**, plus a
 * `useToolPercent` bypass that skipped the clamp entirely for segmented jobs and is
 * why a segmented bar walked backwards. The bypass is gone, so there is no longer a
 * second code path that could disagree about which way a bar moves.
 */
describe("normalizeDownloadProgress — D7 monotonic within a stage", () => {
  it("passes a rising percent straight through", () => {
    expect(normalizeDownloadProgress(10, 42.4)).toBe(42.4);
    expect(normalizeDownloadProgress(0, 0)).toBe(0);
  });

  it("clamps a decrease within the same stage", () => {
    expect(normalizeDownloadProgress(60, 55)).toBe(60);
    expect(normalizeDownloadProgress(60, 0)).toBe(60);
  });

  it("does NOT clamp the same decrease after the stage advances", () => {
    // download 60% → postprocess 4%: the bar restarts, and clamping it to 60% would
    // be the lie D7 exists to remove.
    expect(normalizeDownloadProgress(60, 4, true)).toBe(4);
    expect(normalizeDownloadProgress(60, 0, true)).toBe(0);
  });

  it("treats a missing previous percent as 0", () => {
    expect(normalizeDownloadProgress(undefined, 12)).toBe(12);
    expect(normalizeDownloadProgress(null, 12)).toBe(12);
    expect(normalizeDownloadProgress("nonsense", 12)).toBe(12);
    expect(normalizeDownloadProgress(Number.NaN, 12)).toBe(12);
  });

  it("is null when the incoming percent is unusable", () => {
    // The trust boundary: an untrusted host value that is not a finite number yields
    // null so the caller can leave the job's percent alone. A *numeric string* is not
    // in that set — `progressPercentOrNull` runs `Number()` on it, which is
    // pre-existing behaviour this change does not touch.
    expect(normalizeDownloadProgress(50, Number.NaN)).toBe(null);
    expect(normalizeDownloadProgress(50, undefined)).toBe(null);
    expect(normalizeDownloadProgress(50, Infinity)).toBe(null);
  });

  it("clamps 100 to 99 while the download is live", () => {
    // Unchanged by D7 and deliberately so: a full bar before `done` arrives is a lie
    // about a file that is still being written.
    expect(normalizeDownloadProgress(50, 100)).toBe(99);
    expect(normalizeDownloadProgress(50, 140)).toBe(99);
    // And it survives a stage change — 100 is not a special case there either.
    expect(normalizeDownloadProgress(50, 100, true)).toBe(99);
  });

  it("never exceeds 100 for an out-of-range low value", () => {
    expect(normalizeDownloadProgress(undefined, -20)).toBe(0);
    expect(normalizeDownloadProgress(undefined, -20, true)).toBe(0);
  });

  it("defaults to the within-stage branch when the caller passes no stage signal", () => {
    // The browser-download path (`download/browser.ts`) omits it: `stage` is set once
    // and never changes mid-transfer, so there is nothing to reset against.
    expect(normalizeDownloadProgress(60, 55)).toBe(normalizeDownloadProgress(60, 55, false));
  });
});

describe("downloadProgressMessage", () => {
  it.each([
    [0, "0% downloaded"],
    [42.4, "42% downloaded"],
    [99.6, "100% downloaded"],
    [null, "0% downloaded"],
    [undefined, "0% downloaded"],
  ])("formats %j as %j", (percent, expected) => {
    expect(downloadProgressMessage(percent)).toBe(expected);
  });
});

describe("cleanProgressText", () => {
  it("collapses whitespace and caps the length", () => {
    expect(cleanProgressText("  a   b \n c ")).toBe("a b c");
    expect(String(cleanProgressText("x".repeat(600)))).toHaveLength(500);
    expect(cleanProgressText(undefined)).toBe("");
  });
});

/** Spec D9: the honesty flag has to survive the hop from the host message to the job. */
describe("progressDetailPatchFromMessage — percentApproximate (D9)", () => {
  it("carries an estimate through", () => {
    const patch = progressDetailPatchFromMessage({ percent: 21.7, percentApproximate: true });
    expect(patch.percentApproximate).toBe(true);
  });

  it("omits the key when the host says nothing, so the last honest answer stands", () => {
    // A `stage: "log"` line between two progress frames carries no flag. Writing
    // `false` here would silently promote an estimate to an exact figure.
    expect("percentApproximate" in progressDetailPatchFromMessage({ percent: 21.7 })).toBe(false);
    expect("percentApproximate" in progressDetailPatchFromMessage({ percent: 21.7, percentApproximate: false })).toBe(
      false,
    );
  });

  it("still reports the parsed raw percent and the text fields", () => {
    const patch = progressDetailPatchFromMessage({
      percent: 140,
      speed: "  1.2 MB/s ",
      eta: "00:12",
      fragment: "12/40",
      connections: 4,
      line: "some   line",
    });
    expect(patch.rawPercent).toBe(100);
    expect(patch.speed).toBe("1.2 MB/s");
    expect(patch.eta).toBe("00:12");
    expect(patch.fragment).toBe("12/40");
    expect(patch.connections).toBe(4);
    expect(patch.rawProgressLine).toBe("some line");
  });
});

/**
 * `resetDownloadProgressDetails` runs on every new and resumed download, so it is the
 * one place a stale `percentApproximate` could outlive the percent it described.
 */
describe("resetDownloadProgressDetails", () => {
  it("clears the honesty flag with the percent it belongs to", () => {
    expect(resetDownloadProgressDetails().percentApproximate).toBe(false);
  });

  it("clears the other detail fields it always did", () => {
    expect(resetDownloadProgressDetails()).toMatchObject({
      rawPercent: null,
      downloadedSize: "",
      totalSize: "",
      speed: "",
      eta: "",
      connections: null,
      fragment: "",
      rawProgressLine: "",
    });
  });
});

/**
 * The job-aware wrapper in `download_helpers.ts` is where D7's reset *key* is decided —
 * the stored job's `stage` versus the stage the incoming message claims. This is the
 * half that replaced `isSegmentedDownloadJob`, which segmented jobs used to route
 * around the clamp entirely (spec §4.2).
 */
describe("download_helpers.normalizeDownloadProgress — D7 per-stage baseline", () => {
  const JOB = "job_d7";

  beforeEach(() => {
    tabState.setAllDownloads({});
  });

  it("clamps a decrease when the incoming message stays in the same stage", () => {
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "download" } });
    expect(normalizeJobProgress(JOB, 55, "download")).toBe(60);
  });

  it("lets the bar restart when the incoming message advances the stage", () => {
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "download" } });
    expect(normalizeJobProgress(JOB, 4, "postprocess")).toBe(4);
  });

  it("treats an omitted stage as no information, so it never resets", () => {
    // `download/browser.ts` calls it with two arguments: `stage` is set once at the
    // start of a browser download and never changes, so there is nothing to reset
    // against and the bar stays monotone.
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "downloading" } });
    expect(normalizeJobProgress(JOB, 55)).toBe(60);
  });

  it("resets on the first frame of a stage, when the job had none", () => {
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 40, stage: "" } });
    expect(normalizeJobProgress(JOB, 2, "extract")).toBe(2);
  });

  it("does not reset for a segmented job, which used to bypass the clamp entirely", () => {
    // The regression guard for the retired `useToolPercent` path: `M3U8`/`MPD`/
    // HLS_RE/DASH_RE no longer get the tool's raw percent. One rule for every job.
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "download", format: "M3U8" } });
    expect(normalizeJobProgress(JOB, 55, "download")).toBe(60);

    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "download", url: "https://x/y.m3u8" } });
    expect(normalizeJobProgress(JOB, 55, "download")).toBe(60);
  });

  it("keeps the 100 to 99 clamp on the job path too", () => {
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 99, stage: "download" } });
    expect(normalizeJobProgress(JOB, 100, "download")).toBe(99);
  });

  it("is null when the host sends an unusable percent, leaving the job's own alone", () => {
    tabState.setAllDownloads({ [JOB]: { id: JOB, percent: 60, stage: "download" } });
    expect(normalizeJobProgress(JOB, Number.NaN, "download")).toBe(null);
  });

  it("works for a job that is not in the map at all", () => {
    expect(normalizeJobProgress("missing", 12, "extract")).toBe(12);
  });
});

/**
 * §5.2 / D3 — the write coalescing `tab_state.updateDownload` now does. This is the
 * high-severity risk in the spec: an MV3 service worker can be evicted between ticks,
 * so terminal states must never wait for a timer.
 */
describe("tab_state.updateDownload — coalesced persistence (§5.2)", () => {
  /**
   * `setAllDownloads` persists, and `vi.spyOn` hands back the *same* mock that
   * `vitest-chrome-mv3` installed — so it already carries the `beforeEach` reset's
   * call. Clear it rather than counting the setup as a coalesced write.
   */
  function spyOnStorage() {
    const set = vi.spyOn(chrome.storage.local, "set");
    set.mockClear();
    return set;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tabState.setAllDownloads({});
  });

  afterEach(async () => {
    // Drain before restoring real timers: `tab_state` holds the pending write in a
    // module-level handle, so a timer thrown away by `useRealTimers()` would leave
    // that handle set and stall the *next* test's coalescer.
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not write storage on a running patch, but keeps the job readable", async () => {
    const set = spyOnStorage();
    await tabState.updateDownload("job_c", { status: "running", percent: 5 });
    expect(set).not.toHaveBeenCalled();
    // The read-back `download_helpers.updateDownload` relies on is synchronous and
    // unaffected — that is what keeps the bar smooth while the write coalesces.
    expect(tabState.getDownload("job_c")).toMatchObject({ status: "running", percent: 5 });
  });

  it("coalesces a burst of patches into one write", async () => {
    const set = spyOnStorage();
    for (const percent of [1, 2, 3, 4, 5]) {
      await tabState.updateDownload("job_c", { status: "running", percent });
    }
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "error", "canceled", "paused"])("flushes %s immediately", async (status) => {
    const set = spyOnStorage();
    await tabState.updateDownload("job_c", { status, percent: 100 });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending write when a terminal patch lands", async () => {
    const set = spyOnStorage();
    await tabState.updateDownload("job_c", { status: "running", percent: 5 });
    await tabState.updateDownload("job_c", { status: "done", percent: 100 });
    expect(set).toHaveBeenCalledTimes(1);

    // The coalescer is not left holding a timer that would re-write the same map.
    await vi.advanceTimersByTimeAsync(2000);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
