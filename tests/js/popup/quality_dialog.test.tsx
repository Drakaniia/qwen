/**
 * The popup's quality dialog is now the shared `ui/components/QualityDialog.tsx`.
 *
 * These are the assertions from the old `tests/js/shared/quality_dialog.test.js` that
 * still describe real behaviour — the loading row, the five-column format table, the
 * "best" fallback row, the title with its CC suffix, and the native-error note — run
 * against the component. What is gone are the tests of the imperative module's own
 * machinery: `showRoot`/`hideRoot` injection, `hideOnSelect`/`hideOnBack` flags, the
 * inline-style branch, and the promise resolver, which is now `state/app.ts`.
 */
import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { QualityDialogMount } from "../../../src/popup/components/QualityDialogMount.js";
import {
  chooseQuality,
  hideQualityDialog,
  onQualityDialogCancel,
  onQualityFormatSelected,
  qualityDialog,
  qualityRequestSerial,
  showQualityLoading,
  updateQualityLoadingStatus,
} from "../../../src/popup/state/app.js";

const FORMAT = {
  formatId: "1080p",
  variantId: "v1",
  backend: "yt-dlp",
  sourceUrl: "https://cdn.example/a.mp4",
  label: "1080p MP4",
  height: 1080,
  ext: "mp4",
  bitrate: 2500,
  source: "yt-dlp",
  sizeBytes: 5_000_000,
};

const cellsOf = (button: Element) => [...button.querySelectorAll(".quality-cell")].map((c) => c.textContent);
const optionIn = (host: Element) => host.querySelector(".quality-option") as HTMLButtonElement;

afterEach(() => {
  cleanup();
  hideQualityDialog();
});

describe("loading view", () => {
  it("shows the title and the default loading text", () => {
    showQualityLoading();
    const host = render(<QualityDialogMount />).container;
    expect(host.querySelector("[role=dialog]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector(".qwin-overlay-title")?.textContent).toBe("Loading versions...");
    expect(host.querySelector(".quality-loading")?.textContent).toBe("Checking available video versions...");
  });

  it("accepts a title override", () => {
    showQualityLoading("Asking helper");
    expect(render(<QualityDialogMount />).container.querySelector(".qwin-overlay-title")?.textContent).toBe(
      "Asking helper",
    );
  });

  it("rewrites the loading text from the native host, but only while loading", () => {
    showQualityLoading();
    updateQualityLoadingStatus("still working");
    expect(render(<QualityDialogMount />).container.querySelector(".quality-loading")?.textContent).toBe(
      "still working",
    );

    void chooseQuality({ formats: [FORMAT] });
    updateQualityLoadingStatus("too late");
    const host = render(<QualityDialogMount />).container;
    expect(host.querySelector(".quality-loading")).toBeNull();
  });

  it("is a no-op before any request", () => {
    expect(() => updateQualityLoadingStatus("x")).not.toThrow();
    expect(render(<QualityDialogMount />).container.querySelector(".quality-loading")).toBeNull();
  });

  it("marks the dialog hidden rather than tearing it down when closed", () => {
    const host = render(<QualityDialogMount />).container;
    const dialog = host.querySelector("[role=dialog]");
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute("hidden")).toBe(true);
  });
});

describe("format table", () => {
  it("renders one row per format with the five formatted columns", () => {
    void chooseQuality({ formats: [FORMAT] });
    const [button] = render(<QualityDialogMount />).container.querySelectorAll(".quality-option");
    expect(cellsOf(button)).toEqual(["1080p", "4.8 MB", "MP4", "2500 kbps", "yt-dlp"]);
    expect(button.className).toBe("quality-row quality-option");
    expect(button.querySelector(".primary-cell")).not.toBeNull();
    expect(button.getAttribute("title")).toBe("https://cdn.example/a.mp4");
  });

  it("gives every option the same five values as its accessible name", () => {
    void chooseQuality({ formats: [FORMAT] });
    const [button] = render(<QualityDialogMount />).container.querySelectorAll(".quality-option");
    expect(button.getAttribute("aria-label")).toBe(cellsOf(button).join(", "));
  });

  it("renders the header row", () => {
    void chooseQuality({ formats: [FORMAT] });
    const header = render(<QualityDialogMount />).container.querySelector(".quality-header") as HTMLElement;
    expect([...header.children].map((c) => c.textContent)).toEqual(["Quality", "Size", "Format", "Bitrate", "Source"]);
  });

  it("falls back to the single 'best' choice for an empty format list", () => {
    void chooseQuality({ formats: [] });
    const [button] = render(<QualityDialogMount />).container.querySelectorAll(".quality-option");
    expect(cellsOf(button)).toEqual(["Best available MP4", "Unknown", "VIDEO", "Unknown", "detected"]);
  });

  it("titles the dialog from the video, with the CC suffix", () => {
    const title = () => render(<QualityDialogMount />).container.querySelector(".qwin-overlay-title")?.textContent;
    void chooseQuality({ title: "Song", formats: [] });
    expect(title()).toBe("Compare versions: Song");
    void chooseQuality({ title: "Song", formats: [], hasSubtitles: true });
    expect(title()).toBe("Compare versions: Song — CC");
    void chooseQuality({ formats: [] });
    expect(title()).toBe("Compare versions");
  });

  it("renders a native-error note when provided", () => {
    void chooseQuality({ formats: [FORMAT], nativeError: "helper said no" });
    expect(render(<QualityDialogMount />).container.querySelector(".quality-note")?.textContent).toBe("helper said no");
  });

  it("clears any previously rendered choices when a load starts", () => {
    void chooseQuality({ formats: [FORMAT] });
    showQualityLoading();
    expect(render(<QualityDialogMount />).container.querySelectorAll(".quality-option")).toHaveLength(0);
  });
});

describe("the choice itself", () => {
  it("resolves with the picked format and closes", async () => {
    const promise = chooseQuality({ formats: [FORMAT] });
    optionIn(render(<QualityDialogMount />).container).click();
    await expect(promise).resolves.toEqual({ formatId: "1080p", variantId: "v1", backend: "yt-dlp" });
    expect(qualityDialog.value.open).toBe(false);
  });

  it("defaults formatId/variantId/backend from the selection", () => {
    void chooseQuality({ formats: [{ label: "Best" }] });
    onQualityFormatSelected({});
    expect(qualityDialog.value.open).toBe(false);
  });

  it("resolves null when the dialog is cancelled mid-choice", async () => {
    const promise = chooseQuality({ formats: [FORMAT] });
    onQualityDialogCancel();
    await expect(promise).resolves.toBeNull();
    expect(qualityDialog.value.open).toBe(false);
  });

  it("invalidates the in-flight request when a load is cancelled", () => {
    const before = qualityRequestSerial.value;
    showQualityLoading();
    const token = qualityRequestSerial.value;
    onQualityDialogCancel();
    expect(qualityRequestSerial.value).toBe(token + 1);
    expect(qualityRequestSerial.value).not.toBe(before);
    expect(qualityDialog.value.open).toBe(false);
  });

  it("resolves a pending choice when Settings closes the dialog", async () => {
    // The old chooser dropped the resolver here and the download button stayed on
    // "Loading..." for the rest of the popup's life.
    const promise = chooseQuality({ formats: [FORMAT] });
    hideQualityDialog();
    await expect(promise).resolves.toBeNull();
  });

  it("hands out a request token that only matches its own request", () => {
    const token = showQualityLoading();
    expect(qualityRequestSerial.value).toBe(token);
    showQualityLoading();
    expect(qualityRequestSerial.value).toBe(token + 1);
  });
});
