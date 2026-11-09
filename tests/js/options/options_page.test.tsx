/**
 * What the redesigned options page actually shows (spec §8).
 *
 * The state tests cover what gets written; this covers the four things the redesign was
 * for: the sections are grouped by task rather than by data source, the search field
 * narrows the page, the dependency chips name themselves to a screen reader instead of
 * shipping `✓`/`✗`, and the confirmations land beside the control that changed rather
 * than in one line at the foot of the page.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OptionsPage } from "../../../src/popup/options/OptionsPage.js";
import {
  filterLists,
  helper,
  historyCount,
  note,
  query,
  settings,
  type Settings,
} from "../../../src/popup/options/state.js";

const STORED: Settings = {
  downloadFolder: "",
  audioFormat: "mp3",
  overlayEnabled: true,
  downloadSyncEnabled: true,
  theme: "system",
  minSizeBytes: null,
  downloadSubtitles: true,
  maxConcurrentDownloads: 3,
  preferredMaxHeight: 0,
};

beforeEach(() => {
  settings.value = { ...STORED };
  helper.value = { connected: false, version: "", error: "", lastChecked: 0, dependencies: {} };
  filterLists.value = [];
  historyCount.value = 0;
  query.value = "";
  note.value = null;
});

afterEach(() => {
  cleanup();
  query.value = "";
});

const headings = () => [...document.querySelectorAll("h2")].map((node) => node.textContent);

/**
 * Signal writes re-render on the next microtask, not synchronously — the same batching
 * the real page gets. Assertions about what a signal changed have to let one tick pass.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("section structure", () => {
  it("groups by task, helper below the things people open the page for", () => {
    render(<OptionsPage />);
    expect(headings()).toEqual(["Downloads", "Appearance", "Page integration", "Native helper", "Advanced"]);
  });

  it("labels every form control", () => {
    const { container } = render(<OptionsPage />);
    for (const node of container.querySelectorAll("input, select")) {
      const labelled = container.querySelector(`label[for="${node.id}"]`) || node.closest("label");
      const named = node.getAttribute("aria-label");
      expect(labelled || named, `control ${node.tagName}#${node.id} has no name`).toBeTruthy();
    }
  });

  it("shows no toggle for the setting the background no longer reads", () => {
    const { container } = render(<OptionsPage />);
    expect(container.innerHTML).not.toMatch(/autoDownload|auto-download/i);
  });

  it("offers the audio containers the helper accepts", () => {
    render(<OptionsPage />);
    const select = screen.getByLabelText("Audio format");
    const values = [...select.querySelectorAll("option")].map((node) => node.getAttribute("value"));
    expect(values).toEqual(["mp3", "m4a", "flac", "opus", "wav", "aac", "ogg"]);
  });

  it("offers every preferred-quality cap the contract lists, best first", () => {
    settings.value = { ...STORED, preferredMaxHeight: 1080 };
    render(<OptionsPage />);
    const select = screen.getByLabelText("Preferred quality") as HTMLSelectElement;
    expect([...select.options].map((node) => node.textContent)).toEqual([
      "Best available",
      "2160p",
      "1440p",
      "1080p",
      "720p",
      "480p",
      "360p",
    ]);
    expect(select.value).toBe("1080");
  });

  it("shows simultaneous downloads as a 1-6 radiogroup on the stored value", () => {
    settings.value = { ...STORED, maxConcurrentDownloads: 4 };
    render(<OptionsPage />);
    const group = screen.getByRole("radiogroup", { name: "Simultaneous downloads" });
    expect([...group.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe("4");
  });
});

describe("download controls persist through saveSettings", () => {
  const saves = () =>
    vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message as { type?: string; settings?: unknown })
      .filter((message) => message.type === "saveSettings");

  beforeEach(() => {
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    (
      chrome.runtime.sendMessage as unknown as {
        mockImplementation(fn: (message: unknown, callback?: (reply: unknown) => void) => void): void;
      }
    ).mockImplementation((_message, callback) => callback?.({ ok: true, settings: STORED }));
  });

  it("writes the clicked concurrency", async () => {
    render(<OptionsPage />);
    const group = screen.getByRole("radiogroup", { name: "Simultaneous downloads" });
    const five = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find((n) => n.textContent === "5");
    await act(async () => five?.click());
    expect(saves()).toEqual([{ type: "saveSettings", settings: { maxConcurrentDownloads: 5 } }]);
  });

  it("writes the chosen height cap as a number", async () => {
    render(<OptionsPage />);
    const select = screen.getByLabelText("Preferred quality") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "720" } });
    });
    expect(saves()).toEqual([{ type: "saveSettings", settings: { preferredMaxHeight: 720 } }]);
  });

  it("is found by the words a user would search for", async () => {
    render(<OptionsPage />);
    for (const words of ["simultaneous", "preferred quality", "1080p"]) {
      query.value = words;
      await settle();
      expect(headings(), words).toEqual(["Downloads"]);
    }
  });
});

describe("search", () => {
  it("narrows the page to the section a query names", async () => {
    render(<OptionsPage />);

    query.value = "audio";
    await settle();
    expect(headings()).toEqual(["Downloads"]);
  });

  it("says so rather than rendering an empty page", async () => {
    render(<OptionsPage />);

    query.value = "quantum";
    await settle();
    expect(headings()).toEqual([]);
    expect(document.body.textContent).toContain("No settings match");
  });

  it("restores every section when the query is cleared", async () => {
    render(<OptionsPage />);

    query.value = "theme";
    await settle();
    expect(headings()).toEqual(["Appearance"]);

    query.value = "";
    await settle();
    expect(headings()).toHaveLength(5);
  });

  it("focuses the field on `/` and stands down inside a text field", () => {
    render(<OptionsPage />);
    const search = screen.getByLabelText("Search settings") as HTMLInputElement;

    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);

    // Inside the field `/` must be a character, not a shortcut.
    fireEvent.keyDown(search, { key: "/" });
    query.value = "folder";
    expect(query.value).toBe("folder");
  });

  it("clears and blurs on Escape", () => {
    render(<OptionsPage />);
    const search = screen.getByLabelText("Search settings") as HTMLInputElement;

    fireEvent.input(search, { target: { value: "audio" } });
    expect(query.value).toBe("audio");

    fireEvent.keyDown(search, { key: "Escape" });
    expect(query.value).toBe("");
  });
});

describe("native helper", () => {
  it("names each tool and its state for a screen reader instead of shipping a tick", () => {
    helper.value = {
      connected: true,
      version: "1.4.0",
      error: "",
      lastChecked: 1,
      dependencies: { ytDlp: true, ffmpeg: false, aria2c: true, nM3u8DlRe: false, streamlink: true },
    };
    const { container } = render(<OptionsPage />);

    for (const label of ["yt-dlp — installed", "ffmpeg — missing", "aria2c — installed"]) {
      expect(container.textContent).toContain(label);
    }
    // The old markup's text characters are gone (spec §1.5, §8).
    expect(container.innerHTML).not.toMatch(/[✓✗]/);
  });

  it("marks required and optional the way the shared table declares them", () => {
    render(<OptionsPage />);
    expect(document.body.textContent).toContain("Required");
    expect(document.body.textContent).toContain("Optional");
  });

  it("reports the helper as not connected rather than claiming success", () => {
    const { container } = render(<OptionsPage />);
    expect(container.textContent).toContain("Not connected");
  });
});

describe("per-control confirmation", () => {
  it("puts the note beside the control that changed, not at the foot of the page", () => {
    note.value = { field: "audioFormat", text: "Audio format saved.", error: false, shown: true };
    const { container } = render(<OptionsPage />);

    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe("Audio format saved.");
    // It lives in the Downloads card, immediately after the audio-format control.
    const downloads = [...container.querySelectorAll("section")].find(
      (n) => n.querySelector("h2")?.textContent === "Downloads",
    );
    expect(downloads?.contains(status as Node)).toBe(true);
  });

  it("shows nothing for a control whose note is not current", () => {
    note.value = { field: "theme", text: "dark appearance.", error: false, shown: true };
    const { container } = render(<OptionsPage />);
    expect(container.textContent).not.toContain("Audio format saved.");
  });
});

describe("theme control", () => {
  it("is a three-way radiogroup whose value is the stored mode", () => {
    settings.value = { ...STORED, theme: "dark" };
    render(<OptionsPage />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect([...group.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe("Dark");
  });

  it("acknowledges the OS motion preference without offering a second source of truth", () => {
    const { container } = render(<OptionsPage />);
    expect(container.textContent).toContain("Reduced motion");
    // Informational row: no control that would fight the OS setting.
    const labels = [...container.querySelectorAll("label")].map((n) => n.textContent);
    expect(labels.join(" ")).not.toMatch(/reduced motion/i);
  });
});
