import { describe, expect, it } from "vitest";

import {
  downloadActions,
  downloadDetailEntries,
  downloadMessageText,
  downloadProgressButtonText,
  downloadProgressLabel,
  downloadProgressValue,
  hasDownloadPercent,
  isProcessingStage,
} from "../../../src/popup/download_status.js";
import type { DownloadJob } from "../../../src/popup/state/downloads.js";

/**
 * Almost every case below is a *partial* job — a string percent, a missing id, a null.
 * That is the behaviour under test, so the fixtures are cast rather than repaired; a
 * repair would be the thing being asserted.
 */
const job = (value: unknown) => value as DownloadJob;

/**
 * Characterisation of the status branching, lifted out of the old
 * `download_list.test.js` unchanged when that module became `download_status.ts`
 * plus `components/DownloadRow.tsx`.
 *
 * The DOM half of the old suite — `appendDownloadProgress` and `renderDownloads` —
 * did not survive as-is: both entry points are components now. It lives on, with the
 * same assertions, in `download_row.test.tsx`, which renders the real component.
 */
describe("hasDownloadPercent / isProcessingStage", () => {
  it.each([
    [{ percent: 0 }, true],
    [{ percent: 42.5 }, true],
    [{ percent: Number.NaN }, false],
    [{ percent: "50" }, false],
    [{ percent: null }, false],
    [{}, false],
    [null, false],
  ])("hasDownloadPercent(%j) === %j", (value, expected) => {
    expect(hasDownloadPercent(job(value))).toBe(expected);
  });

  it.each([
    // No percent yet ⇒ the bar has nothing honest to show, whatever the phase.
    [{ stage: "postprocess" }, true],
    [{ stage: "destination" }, true],
    [{ stage: "filepath" }, true],
    [{ stage: "  postprocess  " }, true],
    // D6 (§3.5): a postprocess frame that *does* report a percent is no longer
    // suppressed. This is the assertion the old docstring said could not exist.
    [{ stage: "postprocess", percent: 50 }, false],
    [{ stage: "postprocess", percent: "50" }, true],
    // Suppression is one rule — "is there a percent" — not a per-stage list, so
    // `destination`/`filepath` stop suppressing the moment one exists too. They never
    // carry one (§3.2/§3.3 of the parser), which is why they look unchanged.
    [{ stage: "destination", percent: 50 }, false],
    [{ stage: "filepath", percent: 50 }, false],
    [{ stage: "download" }, false],
    [{ stage: "download", percent: 50 }, false],
    [{ stage: "" }, false],
    [{}, false],
  ])("isProcessingStage(%j) === %j", (value, expected) => {
    expect(isProcessingStage(job(value))).toBe(expected);
  });
});

describe("downloadProgressValue", () => {
  it("passes a finite percent straight through", () => {
    expect(downloadProgressValue(job({ status: "running", percent: 42.4 }))).toBe(42.4);
    expect(downloadProgressValue(job({ status: "running", percent: 0 }))).toBe(0);
  });

  it("is null when there is no honest percentage", () => {
    expect(downloadProgressValue(job({ status: "queued" }))).toBe(null);
    expect(downloadProgressValue(job({ status: "running", percent: "50" }))).toBe(null);
    // A postprocess frame with nothing on the wire is still indeterminate.
    expect(downloadProgressValue(job({ status: "running", stage: "postprocess" }))).toBe(null);
  });

  it("shows a real postprocess percentage now that D6 supplies one (spec §3.5)", () => {
    // This used to assert `null`, and that assertion *was* the bug §1.3 describes:
    // the parser could report a postprocess percent and the bar would still render
    // indeterminate for the whole multi-minute merge.
    expect(downloadProgressValue(job({ status: "running", stage: "postprocess", percent: 50 }))).toBe(50);
    expect(downloadProgressValue(job({ status: "running", stage: "  postprocess  ", percent: 0 }))).toBe(0);
  });

  it("is null for an error job and a missing job", () => {
    expect(downloadProgressValue(job({ status: "error", percent: 50 }))).toBe(null);
    expect(downloadProgressValue(null)).toBe(null);
    expect(downloadProgressValue(undefined)).toBe(null);
  });
});

/** Percent-formatted labels are reachable only through these two helpers. */
describe("downloadProgressButtonText", () => {
  it.each([
    [{ percent: 0 }, "0%"],
    [{ percent: 100 }, "100%"],
    [{ percent: 150 }, "100%"],
    [{ percent: -5 }, "0%"],
    [{ percent: 33.4 }, "33%"],
    [{ percent: 33.5 }, "34%"],
    [{ percent: 66.666 }, "67%"],
  ])("clamps percent: %j => %j", (value, expected) => {
    expect(downloadProgressButtonText(job(value))).toBe(expected);
  });

  it.each([
    [{ percent: "50" }, "Queued"],
    [{ percent: null }, "Queued"],
    [{ percent: Number.NaN }, "Queued"],
  ])("ignores a non-numeric percent: %j => %j", (value, expected) => {
    expect(downloadProgressButtonText(job(value))).toBe(expected);
  });

  it.each([
    [{ stage: "postprocess" }, "Merging"],
    [{ stage: "postprocess", percent: 42 }, "Merging"],
    [{ stage: "destination" }, "Finalizing"],
    [{ stage: "filepath" }, "Finalizing"],
    [{ stage: "  postprocess  " }, "Merging"],
  ])("processing stage wins: %j => %j", (value, expected) => {
    expect(downloadProgressButtonText(job(value))).toBe(expected);
  });

  it.each([
    [{ status: "queued" }, "Queued"],
    [{ status: "connecting" }, "Connecting"],
    [{ status: "paused" }, "Paused"],
    [{ status: "pausing" }, "Pausing"],
    [{ status: "canceling" }, "Canceling"],
    [{ status: "running", fragment: "3/10" }, "Frag 3/10"],
    [{ status: "running", speed: "2 MB/s" }, "2 MB/s"],
    [{ status: "running", fragment: "3/10", speed: "2 MB/s" }, "Frag 3/10"],
    [{ status: "running", speed: "9 MB/s", stage: "download" }, "9 MB/s"],
    // A missing status defaults to "queued", so "Active"/"Preparing" are only
    // reachable from an unrecognised status string — the tail branch is nearly dead.
    [{ status: "weird", stage: "download" }, "Active"],
    [{ status: "weird", stage: "extract" }, "Preparing"],
    [{ status: "weird" }, "Starting"],
    [{}, "Queued"],
    [{ stage: "download" }, "Queued"],
    [{ stage: "extract" }, "Queued"],
    [null, "Queued"],
    [undefined, "Queued"],
  ])("fallbacks: %j => %j", (value, expected) => {
    expect(downloadProgressButtonText(job(value))).toBe(expected);
  });
});

describe("downloadProgressLabel", () => {
  it.each([
    [{ stage: "postprocess" }, "Merging downloaded segments..."],
    [{ stage: "destination" }, "Finalizing output..."],
    [{ stage: "filepath" }, "Finalizing output..."],
    [{ percent: 42 }, "42% downloaded"],
    [{ percent: 42, totalSize: "10 MB" }, "42% downloaded of 10 MB"],
    [{ percent: 42, stage: "postprocess" }, "Merging downloaded segments..."],
    [{ stage: "download" }, "Downloading video segments..."],
    [{ stage: "download", fragment: "2/5" }, "Downloading video segments... (2/5)"],
    [{ stage: "download", speed: "3 MB/s" }, "Downloading video segments at 3 MB/s"],
    [{ stage: "extract" }, "Preparing video..."],
    [{ stage: "extract", fragment: "1/3" }, "Preparing fragments 1/3"],
    [{ stage: "unknown-stage" }, "Queued"],
    [{ status: "queued" }, "Queued"],
    [{ status: "connecting" }, "Connecting to helper"],
    [{ status: "paused" }, "Paused"],
    [{ status: "pausing" }, "Pausing"],
    [{ status: "canceling" }, "Canceling"],
    [{ status: "running" }, "Download running"],
    // Same defaulting quirk as the button text: {} resolves to "queued".
    [{ status: "weird" }, "Starting"],
    [{}, "Queued"],
    [null, "Queued"],
    [undefined, "Queued"],
  ])("label: %j => %j", (value, expected) => {
    expect(downloadProgressLabel(job(value))).toBe(expected);
  });
});

describe("downloadMessageText", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [{}, ""],
    [{ error: "boom" }, "boom"],
    [{ percent: 10, error: "boom" }, "boom"],
    [{ percent: 10 }, ""],
    [{ status: "running", message: "Downloading..." }, ""],
    [{ status: "running", message: "Downloading to disk" }, ""],
    [{ status: "done", message: "Downloading..." }, ""],
    [{ status: "done", message: "Complete" }, "Complete"],
    [{ status: "done", message: "  Complete  " }, "Complete"],
    [{ status: "done" }, ""],
    // The `|| job.url` tail is dead: an absent/blank message already returned "".
    [{ status: "done", url: "https://x/a.mp4" }, ""],
    [{ status: "done", message: "   ", url: "https://x/a.mp4" }, ""],
    [{ status: "error", message: "Downloading..." }, ""],
    [{ status: "connecting", message: "hello" }, ""],
  ])("message text: %j => %j", (value, expected) => {
    expect(downloadMessageText(job(value))).toBe(expected);
  });

  it("keeps the isFakeDownloadMessage heuristic: a real message survives", () => {
    // The heuristic only matches "Downloading..." / "Downloading to ...",
    // so any other wording passes through even for a running job... unless
    // the status is active, which blanks everything anyway.
    expect(downloadMessageText(job({ status: "queued", message: "Downloading" }))).toBe("");
    expect(downloadMessageText(job({ status: "done", message: "Downloaded" }))).toBe("Downloaded");
  });

  it("lets the attempt label through on an active job, and only that (D14)", () => {
    // `background/download/native.ts` sets this from the host's `started` label, and
    // a download can fall through six or more backends before one sticks. The blanket
    // ACTIVE_DOWNLOAD_STATUSES suppression below would make that stall look like a
    // hang, so "Trying X…" is exempted — and nothing else is.
    expect(downloadMessageText(job({ status: "running", message: "Trying N_m3u8DL-RE…" }))).toBe("Trying N_m3u8DL-RE…");
    expect(downloadMessageText(job({ status: "connecting", message: "Trying yt-dlp…" }))).toBe("Trying yt-dlp…");
    // And the neighbouring active-status wording the suppression exists for is
    // untouched.
    expect(downloadMessageText(job({ status: "connecting", message: "Sent to native helper." }))).toBe("");
    expect(downloadMessageText(job({ status: "queued", message: "Trying" }))).toBe("");
  });

  it("still hides the attempt label once a percent exists — the bar says it all", () => {
    expect(downloadMessageText(job({ status: "running", percent: 10, message: "Trying N_m3u8DL-RE…" }))).toBe("");
  });
});

describe("downloadDetailEntries", () => {
  const valueOf = (value: unknown, label: string) =>
    downloadDetailEntries(job(value)).find((e) => e.label === label)?.value;

  it("returns [] for a missing job", () => {
    expect(downloadDetailEntries(null)).toEqual([]);
  });

  it("always reports a status, defaulting to queued", () => {
    expect(downloadDetailEntries(job({}))).toEqual([{ label: "Status", value: "queued" }]);
  });

  it.each([
    ["percent only", { percent: 50 }, "Progress", "50% of 100%"],
    ["percent over 100", { percent: 120 }, "Progress", "100% of 100%"],
    ["rawPercent", { rawPercent: 12.4 }, "Tool percent", "12%"],
  ])("reports %s", (_label, value, entry, expected) => {
    expect(valueOf(value, entry as string)).toBe(expected);
  });

  it("omits rawPercent when absent or non-numeric", () => {
    expect(valueOf({ percent: 10 }, "Tool percent")).toBeUndefined();
    expect(valueOf({ percent: 10, rawPercent: "12" }, "Tool percent")).toBeUndefined();
  });

  it("keeps the documented field order", () => {
    const labels = downloadDetailEntries(job({ percent: 5, speed: "1 MB/s", filepath: "C:/a.mp4" })).map(
      (e) => e.label,
    );
    expect(labels).toEqual(["Status", "Progress", "Speed", "Saved file"]);
  });

  it("drops empty and whitespace-only values", () => {
    const entries = downloadDetailEntries(job({ status: "done", speed: "   ", eta: 0, fragment: "" }));
    expect(entries).toEqual([{ label: "Status", value: "done" }]);
  });

  it.each(["postprocess", "destination", "filepath"])(
    "suppresses progress, speed and eta for %s while no percent is on the wire",
    (stage) => {
      const entries = downloadDetailEntries(job({ status: "running", stage, speed: "1 MB/s" }));
      expect(entries.map((e) => e.label)).toEqual(["Status", "Stage"]);
    },
  );

  it.each(["postprocess", "destination", "filepath", "download", "extract"])(
    "reports progress and speed for %s once a percent exists",
    (stage) => {
      const entries = downloadDetailEntries(job({ status: "running", stage, percent: 50, speed: "1 MB/s" }));
      // Suppression is driven by "is there a percent", not by the stage name (§3.5).
      expect(entries.map((e) => e.label)).toEqual(["Status", "Progress", "Speed", "Stage"]);
    },
  );

  it("renders Last update only for a positive timestamp", () => {
    expect(valueOf({ status: "done", updatedAt: 0 }, "Last update")).toBeUndefined();
    expect(valueOf({ status: "done", updatedAt: -1 }, "Last update")).toBeUndefined();
    expect(valueOf({ status: "done", updatedAt: 1700000000000 }, "Last update")).toContain("2023");
  });
});

describe("downloadActions", () => {
  const labelsOf = (value: DownloadJob) => downloadActions(value).map((a) => a.label);

  it.each([
    ["running", ["Pause", "Cancel"]],
    ["queued", ["Pause", "Cancel"]],
    ["connecting", ["Pause", "Cancel"]],
    ["pausing", ["Cancel"]],
    ["canceling", ["Cancel"]],
    ["paused", ["Resume", "Cancel"]],
    ["done", ["Redownload", "Remove"]],
    ["error", ["Retry", "Remove"]],
    ["canceled", ["Retry", "Remove"]],
  ])("offers the right actions for %s", (status, expected) => {
    expect(labelsOf({ id: "a", status })).toEqual(expected);
  });

  it("defaults a missing status to the queued action set", () => {
    expect(labelsOf({ id: "a" })).toEqual(["Pause", "Cancel"]);
  });

  it("adds Open/Folder when a filepath is known", () => {
    expect(labelsOf({ id: "a", status: "done", filepath: "C:/out/a.mp4" })).toEqual([
      "Redownload",
      "Open",
      "Folder",
      "Remove",
    ]);
  });

  it("falls back to a single Folder when no filepath was recorded", () => {
    // Every download from before the native host started stamping a path, plus the
    // browser-download backend, finishes with `filepath: ""`. A dead row is the one
    // outcome worse than an imprecise one: the folder is where the file is.
    const actions = downloadActions({ id: "a", status: "done" }, "C:/out");
    expect(actions).toMatchObject([
      { label: "Redownload", action: "retry" },
      { label: "Folder", action: "open-folder" },
      { label: "Remove", action: "remove" },
    ]);
  });

  it("never offers the folder fallback for an active job", () => {
    // An in-flight job has nowhere finished to send you, so the button is noise — and
    // `active` is the same gate the Cancel/Remove branches use.
    expect(downloadActions({ id: "a", status: "running" }, "C:/out").map((a) => a.action)).not.toContain("open-folder");
  });

  it("keeps a known filepath ahead of the folder fallback", () => {
    // `open-folder` is a fallback, not a third file action: with a path in hand the row
    // offers Open + Folder(show-folder) and nothing else.
    const actions = downloadActions({ id: "a", status: "done", filepath: "C:/out/a.mp4" }, "C:/out");
    expect(actions.filter((a) => a.action.endsWith("folder"))).toMatchObject([{ action: "show-folder" }]);
  });

  it("renders a disabled placeholder action while processing", () => {
    const actions = downloadActions({ id: "a", status: "running", stage: "postprocess" });
    expect(actions[0]).toMatchObject({ label: "Converting...", action: "none", disabled: true });
    // Cancel comes from its own branch, so it survives the processing branch.
    expect(labelsOf({ id: "a", status: "running", stage: "postprocess" })).toEqual(["Converting...", "Cancel"]);
  });

  it("says Finalizing... for other processing stages", () => {
    expect(downloadActions({ id: "a", status: "running", stage: "filepath" })[0].label).toBe("Finalizing...");
  });

  it("keeps the disabled placeholder on a postprocess job that reports a percent", () => {
    // Deliberately stage-driven, not `isProcessingStage`: the placeholder answers "what
    // is this job doing", and no backend can suspend a merge — a Pause button here
    // would be a control that does nothing. D6's percent goes on the bar instead.
    const actions = downloadActions({ id: "a", status: "running", stage: "postprocess", percent: 50 });
    expect(actions[0]).toMatchObject({ label: "Converting...", action: "none", disabled: true });
    expect(labelsOf({ id: "a", status: "running", stage: "postprocess", percent: 50 })).toEqual([
      "Converting...",
      "Cancel",
    ]);
  });

  it("never offers Pause for a job that is already pausing or canceling", () => {
    // The one place a narrower set than ACTIVE_DOWNLOAD_STATUSES is correct:
    // PAUSABLE_DOWNLOAD_STATUSES, in shared/download_statuses.js.
    expect(labelsOf({ id: "a", status: "pausing" })).not.toContain("Pause");
    expect(labelsOf({ id: "a", status: "canceling" })).not.toContain("Pause");
    expect(labelsOf({ id: "a", status: "paused" })).not.toContain("Pause");
  });

  it("marks the one emphasised action per state", () => {
    expect(downloadActions({ id: "a", status: "paused" }).filter((a) => a.primary)).toMatchObject([
      { label: "Resume" },
    ]);
    expect(downloadActions({ id: "a", status: "error" }).filter((a) => a.primary)).toMatchObject([{ label: "Retry" }]);
    expect(downloadActions({ id: "a", status: "running" }).filter((a) => a.primary)).toEqual([]);
  });

  it("stamps every action with a dispatcher key", () => {
    const actions = downloadActions({ id: "a", status: "done", filepath: "C:/a.mp4" });
    expect(actions.map((a) => a.action)).toEqual(["retry", "open-file", "show-folder", "remove"]);
  });
});
