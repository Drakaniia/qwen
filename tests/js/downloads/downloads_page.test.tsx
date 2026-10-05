/**
 * Mount tests for `downloads.html` (spec §7, D13, §10).
 *
 * These moved out of `tests/js/ui/pages_render.test.tsx`, which asserted the *old*
 * page's two ALL-CAPS sections and four-button bulk bar — both of which §7 replaces.
 * The Options half of that file is B4's and untouched.
 *
 * The assertions here are the ones that would fail if the redesign silently regressed
 * to what it replaced: no ALL-CAPS section headers, Open / Reveal on *every* row with a
 * file (§1.3), the facet popover with a real "All formats" row, the theme control, and
 * the keyboard model.
 */
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { set as resetSelection } from "../../../src/ui/useStickySelection.js";
import { DownloadsPage } from "../../../src/popup/downloads/DownloadsPage.js";
import {
  DOWNLOADS_STORAGE_KEY,
  filter,
  history,
  jobs,
  loaded,
  notice,
  syncEnabled,
  theme,
} from "../../../src/popup/downloads/state.js";

type Callback = (response: unknown) => void;

const NOW = Date.now();
const DONE_OLD = {
  id: "old",
  title: "Older clip",
  tabId: 3,
  status: "done",
  format: "MP4",
  url: "https://cdn.example.com/old.mp4",
  filepath: "C:/out/old.mp4",
  totalSize: "128MiB",
  updatedAt: NOW - 2 * 24 * 3600 * 1000,
};
const DONE_NEW = {
  id: "new",
  title: "Newer clip",
  tabId: 4,
  status: "done",
  format: "MP4",
  url: "https://cdn.example.com/new.mp4",
  filepath: "C:/out/new.mp4",
  updatedAt: NOW - 60 * 60 * 1000,
};

let sent: Array<Record<string, unknown>> = [];

function stubChrome() {
  sent = [];
  (chrome.runtime.sendMessage as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(
    (message: unknown, callback?: Callback) => {
      sent.push(message as Record<string, unknown>);
      callback?.({ ok: true });
    },
  );
  vi.mocked(chrome.storage.local.get).mockImplementation((_keys, callback) =>
    callback?.({ [DOWNLOADS_STORAGE_KEY]: {} }),
  );
}

beforeEach(() => {
  jobs.value = [];
  history.value = [];
  filter.value = { query: "", status: "", format: "", source: "", sort: "recency" };
  loaded.value = true;
  notice.value = "";
  syncEnabled.value = true;
  theme.value = "system";
  resetSelection([]);
  document.documentElement.removeAttribute("data-theme");
  stubChrome();
});

afterEach(() => {
  cleanup();
  resetSelection([]);
  document.documentElement.removeAttribute("data-theme");
});

/** `render()` hands back an `Element`, not an `HTMLElement`; the helper only queries. */
function buttons(container: Element, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((node) => (node.textContent || "").trim().startsWith(label));
}

describe("structure", () => {
  it("has no ALL-CAPS section headers left, and no bare select for a facet", () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    expect(container.innerHTML).not.toMatch(/uppercase/);
    // One `<select>` survives: sort order. The three facets are popovers now.
    expect(container.querySelectorAll("select")).toHaveLength(1);
  });

  it("groups by day with a count instead of two fixed sections", () => {
    jobs.value = [DONE_NEW, DONE_OLD];
    const { container } = render(<DownloadsPage />);

    expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["Today", "This week"]);
    expect(container.textContent).toContain("Older clip");
    expect(container.textContent).toContain("Newer clip");
  });

  it("puts the toolbar and the bulk bar on the same material", () => {
    const { container } = render(<DownloadsPage />);
    expect(container.querySelectorAll(".material-chrome").length).toBeGreaterThanOrEqual(3);
  });
});

describe("row actions (spec §1.3, §7)", () => {
  it("offers Open and Reveal on every row that has a file, not only the newest", () => {
    jobs.value = [DONE_NEW, DONE_OLD];
    const { container } = render(<DownloadsPage />);

    expect(container.querySelectorAll('button[aria-label^="Open "]')).toHaveLength(2);
    expect(container.querySelectorAll('button[aria-label^="Reveal "]')).toHaveLength(2);
  });

  it("sends the clicked row's own jobId", async () => {
    jobs.value = [DONE_NEW, DONE_OLD];
    const { container } = render(<DownloadsPage />);

    const older = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Open Older clip"]')][0];
    older.click();
    await Promise.resolve();

    expect(sent[0]).toEqual({ type: "openDownloadedFile", tabId: 3, jobId: "old" });
  });

  it("reveals through the showFile verb", async () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    container.querySelector<HTMLButtonElement>('button[aria-label="Reveal Newer clip"]')!.click();
    await Promise.resolve();

    expect(sent[0]).toEqual({ type: "showDownloadedFile", tabId: 4, jobId: "new" });
  });

  it("offers neither on a synced entry, which has no file on record", () => {
    history.value = [{ title: "Synced only", status: "done", url: "https://cdn.example.com/s.mp4", completedAt: NOW }];
    const { container } = render(<DownloadsPage />);

    expect(container.textContent).toContain("Synced only");
    expect(container.querySelectorAll('button[aria-label^="Open "]')).toHaveLength(0);
  });

  it("renders the job's speed, bytes and stage on a running row", () => {
    jobs.value = [
      {
        id: "run",
        title: "Running clip",
        status: "running",
        stage: "download",
        percent: 42,
        speed: "4.1MiB/s",
        eta: "00:18",
        downloadedSize: "79MiB",
        totalSize: "128MiB",
        connections: 8,
        updatedAt: NOW,
      },
    ];
    const { container } = render(<DownloadsPage />);

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
    expect(container.textContent).toContain("42%");
    expect(container.textContent).toContain("4.1 MB/s");
    expect(container.textContent).toContain("~18s left");
    expect(container.textContent).toContain("79.0 MB of 128.0 MB");
    expect(container.textContent).toContain("8 connections");
    expect(container.textContent).toContain("Downloading");
  });
});

describe("facet popovers (spec §7)", () => {
  it("shows the chosen value in the trigger and 'All formats' as a real row inside", () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Format: All formats"]')!;
    expect(trigger.textContent).toContain("All formats");

    fireEvent.click(trigger);

    const rows = [...container.querySelectorAll('[role="menuitemradio"]')];
    expect(rows.map((node) => node.textContent?.trim())).toEqual(["All formats", "MP4"]);
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
  });

  it("filters when a value is chosen, and the trigger then names it", () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    container.querySelector<HTMLButtonElement>('button[aria-label="Format: All formats"]')!.click();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Status: All statuses"]')!);

    const done = [...container.querySelectorAll('[role="menuitemradio"]')].find(
      (node) => node.textContent?.trim() === "done",
    )!;
    fireEvent.click(done);

    expect(container.querySelector('button[aria-label="Status: done"]')).not.toBeNull();
    expect(container.textContent).toContain("Newer clip");
  });

  it("returns to everything through the 'All formats' row", () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    container.querySelector<HTMLButtonElement>('button[aria-label="Format: All formats"]')!.click();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Status: All statuses"]')!);
    fireEvent.click(
      [...container.querySelectorAll('[role="menuitemradio"]')].find(
        (node) => node.textContent?.trim() === "All statuses",
      )!,
    );

    expect(container.querySelector('button[aria-label="Status: All statuses"]')).not.toBeNull();
  });
});

describe("bulk bar (spec §7)", () => {
  it("offers the three bulk verbs and gates the two that need a target", () => {
    const { container } = render(<DownloadsPage />);

    const labels = [
      ...buttons(container, "Retry failed"),
      ...buttons(container, "Clear all"),
      ...buttons(container, "Reveal newest"),
    ];
    expect(labels.map((node) => node.textContent?.trim())).toEqual([
      "Retry failed",
      "Clear all",
      "Reveal newest",
    ]);
    expect(buttons(container, "Reveal newest")[0].disabled).toBe(true);
    expect(buttons(container, "Retry failed")[0].disabled).toBe(true);
  });

  it("clears the whole list by calling the background for jobs and history", async () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    fireEvent.click(buttons(container, "Clear all")[0]);
    // Two sequential messages plus the reload: a macrotask drains every microtask
    // between them, where a single `Promise.resolve()` only covers the first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent[0]).toEqual({ type: "clearDownloads", tabId: -1 });
    expect(sent[1]).toEqual({ type: "clearDownloadSyncHistory" });
  });

  it("counts and offers to drop the selection", () => {
    jobs.value = [DONE_NEW, DONE_OLD];
    const { container } = render(<DownloadsPage />);

    fireEvent.click(container.querySelectorAll('[role="option"]')[0]);

    expect(container.textContent).toContain("1 selected");
    fireEvent.click(buttons(container, "Clear selection")[0]);
    expect(container.textContent).not.toContain(" selected");
  });
});

describe("empty states (D13)", () => {
  it("designs the nothing-downloaded state with a next action", () => {
    const { container } = render(<DownloadsPage />);

    expect(container.textContent).toContain("No downloads yet");
    expect(container.textContent).not.toContain("No completed downloads synced yet.");
    expect(buttons(container, "Open Options")).toHaveLength(1);
  });

  it("designs the filtered-to-nothing state and can undo it", () => {
    jobs.value = [DONE_NEW];
    filter.value = { ...filter.value, query: "nothing matches this" };

    const { container } = render(<DownloadsPage />);

    expect(container.textContent).toContain("No downloads match these filters");
    fireEvent.click(buttons(container, "Clear filters")[0]);
    expect(container.textContent).toContain("Newer clip");
  });

  it("says so when history sync is off, instead of pretending the list is complete", () => {
    syncEnabled.value = false;
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);

    expect(container.textContent).toContain("History sync is off");
  });
});

describe("keyboard model (spec §10)", () => {
  it("focuses and selects the search box on /", () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));

    expect(document.activeElement).toBe(search);
    expect(search.selectionStart).toBe(0);
  });

  it("moves the active row with the arrows and selects it with Space", () => {
    jobs.value = [DONE_NEW, DONE_OLD];
    const { container } = render(<DownloadsPage />);
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;

    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("row-new");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe("row-old");

    fireEvent.keyDown(listbox, { key: "Home" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe("row-new");

    fireEvent.keyDown(listbox, { key: "End" });
    expect(listbox.getAttribute("aria-activedescendant")).toBe("row-old");

    fireEvent.keyDown(listbox, { key: " " });
    expect(container.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
  });

  it("opens the active row on Enter", async () => {
    jobs.value = [DONE_NEW];
    const { container } = render(<DownloadsPage />);
    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;

    fireEvent.keyDown(listbox, { key: "Enter" });
    await Promise.resolve();

    expect(sent[0]).toEqual({ type: "openDownloadedFile", tabId: 4, jobId: "new" });
  });
});

describe("theme control (spec §6.2, D6)", () => {
  it("offers the three-way control and applies the choice to the document", async () => {
    const { container } = render(<DownloadsPage />);

    const dark = [...container.querySelectorAll('[role="radio"]')].find((node) => node.textContent?.trim() === "Dark")!;
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Theme");

    fireEvent.click(dark);
    await Promise.resolve();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(theme.value).toBe("dark");
    expect(sent[0]).toEqual({ type: "saveSettings", settings: { theme: "dark" } });
  });

  it("returns to System by removing the attribute", async () => {
    document.documentElement.dataset.theme = "dark";
    theme.value = "dark";
    const { container } = render(<DownloadsPage />);

    fireEvent.click(
      [...container.querySelectorAll('[role="radio"]')].find((node) => node.textContent?.trim() === "System")!,
    );
    await Promise.resolve();

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(sent[0]).toEqual({ type: "saveSettings", settings: { theme: "system" } });
  });
});
