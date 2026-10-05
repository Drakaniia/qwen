import { describe, expect, it } from "vitest";

import { ACTIVE_DOWNLOAD_STATUSES, isUnknownMessageTypeError } from "../../../src/popup/popup_state.js";
import { applyJobUpdate, currentDownloads, type DownloadJob } from "../../../src/popup/state/downloads.js";

describe("ACTIVE_DOWNLOAD_STATUSES", () => {
  it("holds exactly the six in-progress statuses", () => {
    expect([...ACTIVE_DOWNLOAD_STATUSES].sort()).toEqual(
      ["canceling", "connecting", "paused", "pausing", "queued", "running"].sort(),
    );
  });
});

describe("isUnknownMessageTypeError", () => {
  it.each([
    [{ error: "Unknown message type: foo" }, true],
    [{ error: "unknown MESSAGE TYPE" }, true],
    [{ error: "prefix UNKNOWN MESSAGE TYPE suffix" }, true],
    [{ error: "something else" }, false],
    [{ error: "" }, false],
    [{}, false],
    [null, false],
    [undefined, false],
    ["Unknown message type", false],
  ])("isUnknownMessageTypeError(%j) === %j", (response, expected) => {
    expect(isUnknownMessageTypeError(response)).toBe(expected);
  });
});

/**
 * Spec D9 / §4.1: `percentApproximate` has to survive the `downloadUpdated` hop.
 *
 * `popup_background_events.ts` and `downloads/state.ts` both route a broadcast job
 * through `applyJobUpdate` before it reaches a row, so a field the merge drops is a
 * field the bar never marks — the popup's copy of `DownloadJob` is the render-side
 * half of a pair that has to stay in sync with `shared/contracts.ts`.
 */
describe("applyJobUpdate — downloadUpdated round-trip", () => {
  const job = (value: Partial<DownloadJob>): DownloadJob => value as DownloadJob;

  it("keeps percentApproximate on an in-place update", () => {
    const merged = applyJobUpdate(
      [job({ id: "1", status: "running", percent: 10, percentApproximate: true })],
      job({ id: "1", status: "running", percent: 40, percentApproximate: true }),
    );
    expect(merged[0].percentApproximate).toBe(true);
    expect(merged[0].percent).toBe(40);
  });

  it("keeps it on insert, so the very first frame of a segmented job is marked", () => {
    const merged = applyJobUpdate([], job({ id: "1", percentApproximate: true, percent: 2 }));
    expect(merged[0].percentApproximate).toBe(true);
  });

  it("does not invent it, so an exact percent stays exact", () => {
    const merged = applyJobUpdate([], job({ id: "1", percent: 2 }));
    expect("percentApproximate" in merged[0]).toBe(false);
  });

  it("replaces rather than merges, so a cleared flag is not resurrected", () => {
    // The background sends the whole merged job on every broadcast, so a host that
    // stops marking an estimate has to be able to stop the `~` showing.
    const merged = applyJobUpdate(
      [job({ id: "1", percentApproximate: true })],
      job({ id: "1", percentApproximate: false }),
    );
    expect(merged[0].percentApproximate).toBe(false);
  });

  it("survives the signal write the background event handler performs", () => {
    // The one line of `popup_background_events.ts`, exercised for real: assign into
    // `currentDownloads`, read the job back.
    const incoming = job({ id: "9", status: "running", percent: 21.7, percentApproximate: true });
    currentDownloads.value = applyJobUpdate(currentDownloads.value, incoming);
    expect(currentDownloads.value[0].percentApproximate).toBe(true);
    currentDownloads.value = [];
  });
});
