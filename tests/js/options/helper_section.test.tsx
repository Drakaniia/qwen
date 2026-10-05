/**
 * Options → Native helper has three states, not two (native-helper-status-spec.md §5
 * Step 4). The third one is the reported bug: `dependencies` is `{}` both before a probe
 * answers and when the helper is unreachable, so a two-state panel reports all five
 * installed tools as missing during the 0.4-3.5s a cold native ping takes.
 *
 * The no-argument case deliberately renders the `helper` signal's *own* default instead
 * of a value this file assigns, so the assertion is about what a user saw on first paint
 * — hence the per-test `vi.resetModules()` rather than a suite-level fixture, which would
 * have replaced the default with the value under test.
 */
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HelperStatus } from "../../../src/shared/contracts.js";
import { HELPER_DEPENDENCIES } from "../../../src/shared/helper_dependencies.js";

const ALL_INSTALLED = { ytDlp: true, ffmpeg: true, aria2c: true, nM3u8DlRe: true, streamlink: true };

/** Mount `HelperSection` on a pristine copy of the options state, then apply `patch`. */
async function renderSection(patch?: Partial<HelperStatus>): Promise<Element> {
  vi.resetModules();
  const state = await import("../../../src/popup/options/state.js");
  const { HelperSection } = await import("../../../src/popup/options/diagnostics.js");
  if (patch) {
    state.helper.value = { ...state.helper.value, ...patch };
  }
  return render(<HelperSection />).container;
}

/** The screen-reader label each chip publishes, which is the only place its state is named. */
const chipLabels = (container: Element) =>
  [...container.querySelectorAll('[role="status"] .sr-only')].map((node) => node.textContent);

/**
 * The resolved colour token of each dot. Read from the class rather than from the dot's
 * shape because the states deliberately share one glyph (spec §4.4).
 */
const chipDotColors = (container: Element) =>
  [...container.querySelectorAll('[role="status"]')].map(
    (node) => /text-(success|critical|caution|text-tertiary)/.exec(node.getAttribute("class") || "")?.[1] || "",
  );

const everyDot = (color: string) => HELPER_DEPENDENCIES.map(() => color);
const everyLabel = (label: string) => HELPER_DEPENDENCIES.map((dep) => `${dep.name} — ${label}`);

afterEach(() => {
  cleanup();
});

describe("no probe has answered", () => {
  it("says the helper is unknown and claims no tool is missing", async () => {
    const container = await renderSection();

    expect(container.textContent).toContain("Unknown — helper not reachable yet.");
    // One word, and it is the whole bug: it must not reach the page through the chip
    // labels or the install hint either, or a screen-reader user hears the old lie.
    expect(container.textContent).not.toContain("missing");
    expect(container.textContent).not.toContain("scripts/install.sh");
    expect(chipLabels(container)).toEqual(everyLabel("not checked yet"));
    expect(chipDotColors(container)).toEqual(everyDot("text-tertiary"));
  });
});

describe("a probe answered and the host was unreachable", () => {
  it("reports the failure, its error, and the install hint", async () => {
    const container = await renderSection({
      connected: false,
      error: "Specified native messaging host not found.",
      lastChecked: 1,
    });

    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).toContain("Specified native messaging host not found.");
    expect(container.textContent).toContain("scripts/install.sh");
    expect(chipLabels(container)).toEqual(everyLabel("missing"));
    expect(chipDotColors(container)).toEqual(everyDot("critical"));
  });
});

describe("a probe answered and the host is up", () => {
  it("reports the version, five installed tools, and nothing to install", async () => {
    const container = await renderSection({
      connected: true,
      version: "1.0.0",
      lastChecked: 1,
      dependencies: ALL_INSTALLED,
    });

    expect(container.textContent).toContain("Connected · helper 1.0.0");
    expect(container.textContent).not.toContain("scripts/install.sh");
    expect(chipLabels(container)).toEqual(everyLabel("installed"));
    expect(chipDotColors(container)).toEqual(everyDot("success"));
  });
});
