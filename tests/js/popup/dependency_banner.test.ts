/**
 * The popup's dependency banner, pinned across the `connected: boolean | null` widening of
 * `HelperStatus` (native-helper-status-spec.md §5 Step 7.4).
 *
 * This behaviour was already correct and must not regress: `connected: null` means no
 * probe has answered, and `checkHelperStatus` derives `missing` from a dependency record
 * that is `{}` until then — so the gate has to hold on `connected` alone, or the banner
 * claims a required tool is absent for the length of a cold native ping.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dependencyBanner, helperStatus, type HelperStatusState } from "../../../src/popup/state/app.js";

/** One required tool recorded as missing, which is what the banner exists for. */
const MISSING: HelperStatusState["missing"] = [
  { key: "ytDlp", name: "yt-dlp", purpose: "", required: true, bannerLabel: "yt-dlp (video downloads)" },
];

beforeEach(() => {
  helperStatus.value = { connected: null, version: "", missing: [] };
});

afterEach(() => {
  helperStatus.value = { connected: null, version: "", missing: [] };
});

describe("dependencyBanner", () => {
  it("shows nothing while no probe has answered, even with a tool recorded missing", () => {
    helperStatus.value = { connected: null, version: "", missing: MISSING };
    expect(dependencyBanner.value).toBeNull();
  });

  it("shows nothing for a probe that ran and found the helper unreachable", () => {
    // `popup_helpers.checkHelperStatus` coerces the background's `null` to `false`, so this
    // is the state the popup actually holds during an unanswered or failed probe.
    helperStatus.value = { connected: false, version: "", missing: MISSING };
    expect(dependencyBanner.value).toBeNull();
  });

  it("shows the status once a connected helper is missing a required tool", () => {
    helperStatus.value = { connected: true, version: "1.0.0", missing: MISSING };
    expect(dependencyBanner.value).toBe(helperStatus.value);
  });

  it("shows nothing when a connected helper has every tool", () => {
    helperStatus.value = { connected: true, version: "1.0.0", missing: [] };
    expect(dependencyBanner.value).toBeNull();
  });
});
