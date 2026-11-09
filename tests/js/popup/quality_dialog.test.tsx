/**
 * The popup's quality dialog is now the shared `ui/components/QualityDialog.tsx`.
 *
 * These are the assertions from the old `tests/js/shared/quality_dialog.test.js` that
 * still describe real behaviour — the loading row, the five-column format table, the
 * unavailable state, the title with its CC suffix, and the native-error note — run
 * against the component. What is gone are the tests of the imperative module's own
 * machinery: `showRoot`/`hideRoot` injection, `hideOnSelect`/`hideOnBack` flags, the
 * inline-style branch, and the promise resolver, which is now `state/app.ts`.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { clear as clearSelection, selectedCount, toggle } from "../../../src/ui/useStickySelection.js";

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

  it("renders the header row, the group name in the quality column", () => {
    void chooseQuality({ formats: [FORMAT] });
    const header = render(<QualityDialogMount />).container.querySelector(".quality-header") as HTMLElement;
    expect([...header.children].map((c) => c.textContent)).toEqual(["Video", "Size", "Format", "Bitrate", "Source"]);
  });

  it("replaces the table with the reason when there are no formats", () => {
    // An empty list is a real answer now. It used to render a single synthetic
    // `Best available MP4` option that always failed on click, because the helper had
    // just refused the URL — a normal-looking row over a raw yt-dlp error.
    void chooseQuality({ formats: [], unavailableReason: "This stream is DRM-protected." });
    const host = render(<QualityDialogMount />).container;

    expect(host.querySelector(".quality-table")).toBeNull();
    expect(host.querySelectorAll(".quality-option")).toHaveLength(0);
    expect(host.querySelector(".qwin-overlay-empty")?.textContent).toBe("This stream is DRM-protected.");
  });

  it("still says something when no reason was given", () => {
    void chooseQuality({ formats: [] });
    expect(render(<QualityDialogMount />).container.querySelector(".qwin-overlay-empty")?.textContent).toBe(
      "No downloadable versions were found for this video.",
    );
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

describe("video and audio groups", () => {
  const AUDIO_KIND = {
    formatId: "140",
    kind: "audio",
    acodec: "mp4a.40.2",
    abr: 129.5,
    ext: "m4a",
    sizeBytes: 3_000_000,
  };
  const AUDIO_VCODEC = { formatId: "251", vcodec: "none", acodec: "opus", abr: 160, ext: "webm" };
  const AUDIO_FIELDS = { formatId: "a1", acodec: "mp3", ext: "mp3" };

  const groups = (host: Element) =>
    [...host.querySelectorAll("section.quality-table")].map((section) => ({
      label: section.getAttribute("aria-label"),
      rows: [...section.querySelectorAll(".quality-option")].map((row) => cellsOf(row)[0]),
    }));

  it("puts every audio-only format under Audio only, whichever way yt-dlp said so", () => {
    void chooseQuality({ formats: [AUDIO_KIND, FORMAT, AUDIO_VCODEC, AUDIO_FIELDS] });
    expect(groups(render(<QualityDialogMount />).container)).toEqual([
      { label: "Video", rows: ["1080p"] },
      { label: "Audio only", rows: ["130 kbps", "160 kbps", "Unknown"] },
    ]);
  });

  it("shows bitrate, size, codec and container for an audio row", () => {
    void chooseQuality({ formats: [AUDIO_KIND] });
    const host = render(<QualityDialogMount />).container;
    const header = host.querySelector(".quality-header") as HTMLElement;
    expect([...header.children].map((c) => c.textContent)).toEqual(["Audio only", "Size", "Codec", "Format", "Source"]);
    expect(cellsOf(optionIn(host)).slice(0, 4)).toEqual(["130 kbps", "2.9 MB", "mp4a.40.2", "M4A"]);
  });

  it("keeps a muxed format with audio fields and a height under Video", () => {
    void chooseQuality({ formats: [{ ...FORMAT, acodec: "mp4a.40.2", abr: 128, vcodec: "avc1" }] });
    expect(groups(render(<QualityDialogMount />).container).map((g) => g.label)).toEqual(["Video"]);
  });

  it("shows the duration in the header when the reply carried one", () => {
    void chooseQuality({ title: "Song", formats: [FORMAT], duration: 213 });
    const host = render(<QualityDialogMount />).container;
    expect(host.querySelector(".qwin-overlay-header")?.textContent).toContain("3:33");

    void chooseQuality({ title: "Song", formats: [FORMAT] });
    expect(render(<QualityDialogMount />).container.querySelector("[aria-label^='Duration']")).toBeNull();
  });
});

describe("modal focus", () => {
  it("moves focus to the first choice, and back to the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const host = render(<QualityDialogMount />).container;
    await act(async () => {
      void chooseQuality({ formats: [FORMAT] });
    });
    expect(document.activeElement).toBe(optionIn(host));

    await act(async () => onQualityDialogCancel());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("closes on Escape without letting the frame's handler see the key", async () => {
    const promise = chooseQuality({ formats: [FORMAT] });
    render(<QualityDialogMount />);
    await act(async () => {});
    toggle("row-1");
    let reachedDocument = false;
    const frame = () => (reachedDocument = true);
    document.addEventListener("keydown", frame);

    await act(async () => {
      fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
    });

    await expect(promise).resolves.toBeNull();
    expect(qualityDialog.value.open).toBe(false);
    expect(reachedDocument).toBe(false);
    expect(selectedCount.value).toBe(1);
    document.removeEventListener("keydown", frame);
    clearSelection();
  });

  it("keeps Tab inside the card", async () => {
    const host = render(<QualityDialogMount />).container;
    await act(async () => {
      void chooseQuality({ formats: [FORMAT, { ...FORMAT, formatId: "720p", height: 720 }] });
    });
    const cancel = host.querySelector(".qwin-overlay-cancel") as HTMLButtonElement;
    const first = optionIn(host);

    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
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
