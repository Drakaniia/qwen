/**
 * Mount smoke test for the options page.
 *
 * `options.html` is a separate Vite entry with nothing else importing it, so nothing
 * else in the suite would notice a component that throws on its first render or a
 * field that is missing its accessible name. This is the check that the surface exists
 * at all — not a visual one.
 *
 * The assertions describe the page spec §8 defines: five sections grouped by **task**
 * rather than by data source. The earlier version pinned five headings that §8 replaces
 * ("On-page overlay" and "Download history sync" are two settings sharing one
 * "Page integration" section) and exactly four controls, which is fewer than §8's
 * section table requires. The `downloads.html` half of this file moved to
 * `tests/js/downloads/downloads_page.test.tsx` for the same reason.
 */
import { cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HELPER_DEPENDENCIES } from "../../../src/shared/helper_dependencies.js";
import { OptionsPage } from "../../../src/popup/options/OptionsPage.js";
import { filterLists, helper, historyCount, settings } from "../../../src/popup/options/state.js";

beforeEach(() => {
  settings.value = {
    downloadFolder: "",
    audioFormat: "mp3",
    overlayEnabled: true,
    downloadSyncEnabled: true,
    minSizeBytes: null,
    downloadSubtitles: true,
    maxConcurrentDownloads: 3,
    preferredMaxHeight: 0,
  };
  helper.value = { connected: false, version: "", error: "", lastChecked: 0, dependencies: {} };
  filterLists.value = [];
  historyCount.value = 0;
});

afterEach(() => {
  cleanup();
});

describe("OptionsPage", () => {
  it("groups its controls into §8's five task sections", () => {
    const { container } = render(<OptionsPage />);

    expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
      "Downloads",
      "Appearance",
      "Page integration",
      "Native helper",
      "Advanced",
    ]);
  });

  it("has a real form control per setting, each with a label", () => {
    const { container } = render(<OptionsPage />);
    const controls = [...container.querySelectorAll("input,select")];

    // §8's section table: folder, audio format, subtitles, overlay, sync — plus the
    // search field. Assert the per-setting controls exist by accessible name rather
    // than by a frozen list of tag+type strings, which broke the moment a second text
    // input (the search box) appeared.
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const node of controls) {
      // An accessible name, not specifically a `<label for>`: the search box is named
      // with `aria-label` because a visible label for a search field is noise, and
      // `label[for=""]` — what the old assertion degenerated into — matches nothing.
      const named =
        container.querySelector(`label[for="${node.id}"]`) ||
        node.closest("label") ||
        node.getAttribute("aria-label") ||
        container.querySelector(`[aria-labelledby="${node.getAttribute("aria-labelledby")}"]`);
      expect(
        named,
        `control ${node.id || node.getAttribute("aria-label") || node.tagName} has no accessible name`,
      ).not.toBeNull();
    }
  });

  it("offers the three-way theme control §6.2 specifies, defaulting to System", () => {
    const { container } = render(<OptionsPage />);

    // Named, not the first one: the min-size `Meter` is also a `Segmented`, so a
    // positional grab picks the wrong radiogroup.
    const group = container.querySelector('[role="radiogroup"][aria-label="Theme"]');
    expect(group, "no Theme radiogroup").not.toBeNull();
    expect([...group!.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(group!.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("System");
  });

  it("offers no toggle for the two settings the background no longer reads", () => {
    const { container } = render(<OptionsPage />);
    expect(container.innerHTML).not.toMatch(/autoDownload|maxConcurrentDownloads|max concurrent/i);
  });

  it("shows the audio formats as options on the select", () => {
    const { container } = render(<OptionsPage />);
    // Scoped to the audio select: Preferred quality is a select on the same page.
    const audio = container.querySelector("select") as HTMLSelectElement;
    const values = [...audio.querySelectorAll("option")].map((node) => node.getAttribute("value"));
    expect(values).toEqual(["mp3", "m4a", "flac", "opus", "wav", "aac", "ogg"]);
  });

  it("reports the helper as not connected rather than claiming success", () => {
    const { container } = render(<OptionsPage />);
    expect(container.textContent).toContain("Not connected");
    // Every tool in the shared table is listed, marked required or optional.
    for (const dep of HELPER_DEPENDENCIES) {
      expect(container.textContent).toContain(dep.name);
    }
    // §8 replaced the `✓`/`✗` text characters with chips carrying a state dot; a bare
    // check/cross is the thing being asserted away.
    expect(container.textContent).not.toMatch(/[✓✗]/);
  });
});
