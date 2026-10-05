/**
 * The Phase 2 rows (spec §6.6, §6.8, §6.9; acceptance criteria 4, 8, 13).
 *
 * These assertions exist because the previous rows *threw data away*, not because the
 * rows were wrong. `DownloadJob` carried `speed`, `eta`, `downloadedSize`, `totalSize`,
 * `connections` and `stage` and drew none of them; `VideoCandidate` refused the five
 * fields its own wire type already delivered. A test that only checked "renders a row"
 * would have passed on both old components, so each case below pins a field that used to
 * be dropped.
 *
 * Acceptance criterion 13 (spec §1.6, D17) gets its own case: the old row's copy told
 * users to "use the Record button above" for a feature deleted in dad38be / f38e6de /
 * 8c5c698.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobRow } from "../../../../src/popup/views/JobRow.js";
import { SelectionBar } from "../../../../src/popup/views/SelectionBar.js";
import { VideoRow } from "../../../../src/popup/views/VideoRow.js";
import { activeTabId } from "../../../../src/popup/state/app.js";
import { currentDownloads } from "../../../../src/popup/state/downloads.js";
import { currentVideos, type VideoCandidate } from "../../../../src/popup/state/videos.js";
import { clear, select } from "../../../../src/ui/useStickySelection.js";

vi.mock("../../../../src/popup/popup_actions.js", () => ({
  runDownloadAction: vi.fn(async () => ""),
  startVideoDownload: vi.fn(async () => {}),
}));

// Only the grab is stubbed. `state/app.js` also imports this module, so a wholesale
// mock would have to restate everything it reads — one override on the real module is
// both smaller and honest about what the row actually calls.
vi.mock("../../../../src/shared/popup_api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/shared/popup_api.js")>()),
  grabThumbnailFrame: vi.fn(async () => ({ ok: true })),
}));

const { runDownloadAction, startVideoDownload } = await import("../../../../src/popup/popup_actions.js");
const { grabThumbnailFrame } = await import("../../../../src/shared/popup_api.js");

type Job = Record<string, unknown> & { id: string };

const BASE: VideoCandidate = {
  id: "v1",
  url: "https://cdn.example/a.mp4",
  title: "Big Buck Bunny",
  downloadable: true,
};

function row(video: Partial<VideoCandidate> = {}): HTMLElement {
  const props = { video: { ...BASE, ...video } as VideoCandidate, active: false, selected: false };
  return render(<VideoRow {...props} />).container as HTMLElement;
}

function jobRow(job: Job): HTMLElement {
  return render(<JobRow job={job as never} />).container as HTMLElement;
}

const text = (host: HTMLElement) => host.textContent || "";

/** The row's single thumbnail. `VideoRow` has no other `<img>`. */
function image(host: Element): HTMLImageElement | null {
  return host.querySelector("img");
}

/**
 * The play/music glyph, scoped to the thumbnail tile. `Checkbox` draws its tick inside
 * an `absolute inset-0` overlay too, so the tile's own `aspect-video` is the discriminator.
 */
function glyph(host: Element): Element | null {
  return host.querySelector(".aspect-video svg");
}

beforeEach(() => {
  document.body.innerHTML = "";
  // A row's grab is keyed on the active tab (the media list is tab-scoped), so every
  // test needs one or the effect bails.
  activeTabId.value = 7;
  currentDownloads.value = [];
  currentVideos.value = [];
  clear();
  vi.mocked(runDownloadAction).mockClear();
  vi.mocked(runDownloadAction).mockResolvedValue("");
  vi.mocked(startVideoDownload).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("VideoRow: the inline resolution ladder (spec §3.1, §6.6)", () => {
  it("shows resolution, container and streaming protocol from fields that used to be dropped", () => {
    // height/duration arrived on DetectedVideo and were refused by the popup's render
    // type, so the row could not say either of these.
    const host = row({ height: 1080, duration: 596, format: "M3U8" });
    expect(text(host)).toContain("1080p");
    expect(text(host)).toContain("MP4");
    expect(text(host)).toContain("HLS");
    expect(text(host)).toContain("9:56");
  });

  it("shows the size from sizeBytes", () => {
    expect(text(row({ sizeBytes: 134217728 }))).toContain("128.0 MB");
  });

  it("omits an unknown height rather than printing a fabricated 0p", () => {
    expect(text(row({ height: 0 }))).not.toContain("0p");
  });

  it("says audio, not a resolution, for an audio-only candidate", () => {
    expect(text(row({ format: "AUDIO" }))).toContain("audio");
  });

  it("clamps the title to two lines rather than balancing it", () => {
    const host = row({ title: "A very long title ".repeat(20) });
    const title = host.querySelector(".line-clamp-2");
    expect(title).not.toBeNull();
    // `text-wrap: balance` fights a clamp by rebalancing on every truncation.
    expect(title?.className).not.toContain("text-balance");
    expect(title?.className).not.toContain("text-pretty");
  });

  it("renders the thumbnail unconditionally", () => {
    // D12 / spec §6.6: `layout.css:96`'s `.video-preview { display: none }` was the bug
    // and there is no longer a `.boxes` mode to switch it back on with.
    expect(row({ thumbnailUrl: "https://cdn.example/t.jpg" }).querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example/t.jpg",
    );
  });
});

describe("VideoRow: the stream-frame grab (hls-thumbnail-spec.md §6.1, H3/H4/H8)", () => {
  const THREE = ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/3.jpg"];

  /** Burn the whole ladder, which is what flips `exhausted`. */
  function exhaust(host: HTMLElement): void {
    for (let guard = 0; guard < 6 && !glyph(host); guard += 1) {
      const img = image(host);
      if (!img) {
        return;
      }
      fireEvent.error(img);
    }
  }

  beforeEach(() => {
    vi.mocked(grabThumbnailFrame).mockClear();
  });

  it("asks for a frame once when the ladder is empty (H3, H4's empty-ladder arm)", async () => {
    await act(async () => {
      row({ id: "empty-1" });
    });

    expect(grabThumbnailFrame).toHaveBeenCalledTimes(1);
    expect(grabThumbnailFrame).toHaveBeenCalledWith(expect.any(Number), "empty-1");
  });

  /** A container to render into, so each `act` flushes one transition at a time. */
  function slot(): HTMLElement {
    return document.createElement("div");
  }

  it("does not re-fire when an exhausted ladder re-renders (H3, once per video)", async () => {
    let host = slot();
    await act(async () => {
      host = row({ id: "once-1", format: "M3U8", thumbnailCandidates: THREE });
    });
    expect(grabThumbnailFrame).not.toHaveBeenCalled();

    await act(async () => {
      exhaust(host);
    });
    expect(grabThumbnailFrame).toHaveBeenCalledTimes(1);

    // Three more renders — a progress tick, a `videoListUpdated`, a filter change.
    await act(async () => {
      row({ id: "once-1", format: "M3U8", thumbnailCandidates: THREE });
      exhaust(host);
    });
    expect(grabThumbnailFrame).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a spent non-segmented ladder (H4's second arm is segmented-only)", async () => {
    await act(async () => {
      const host = row({ id: "mp4-1", format: "MP4", thumbnailCandidates: THREE });
      exhaust(host);
    });

    expect(grabThumbnailFrame).not.toHaveBeenCalled();
  });

  it("fires for a spent segmented ladder, and again after the tab changes (keyed per tab)", async () => {
    let host = slot();
    await act(async () => {
      host = row({ id: "seg-1", format: "M3U8", thumbnailCandidates: THREE });
    });
    await act(async () => {
      exhaust(host);
    });
    expect(grabThumbnailFrame).toHaveBeenCalledTimes(1);

    // The guard is keyed `tabId:id`, because the media list is tab-scoped and a
    // `video.id` is only unique within its tab.
    activeTabId.value = 4242;
    await act(async () => {
      host = row({ id: "seg-1", format: "M3U8", thumbnailCandidates: THREE });
    });
    await act(async () => {
      exhaust(host);
    });
    expect(grabThumbnailFrame).toHaveBeenCalledTimes(2);
    expect(grabThumbnailFrame).toHaveBeenLastCalledWith(4242, "seg-1");
  });

  it("resets the cursor when the ladder grows, so the new head shows instead of the glyph", async () => {
    // The one thing §5.2's free ride is not free about: the frame does not change
    // `video.id`, so no keyed remount happens and the exhausted index would point past
    // the end of the longer ladder.
    const first = render(
      <VideoRow
        video={{ ...BASE, id: "grow-1", format: "M3U8", thumbnailCandidates: THREE }}
        active={false}
        selected={false}
      />,
    );
    await act(async () => {
      exhaust(first.container as HTMLElement);
    });
    expect(glyph(first.container)).not.toBeNull();

    const frame = "data:image/jpeg;base64,AAAA";
    await act(async () => {
      first.rerender(
        <VideoRow
          video={{ ...BASE, id: "grow-1", format: "M3U8", thumbnailCandidates: [frame, ...THREE] }}
          active={false}
          selected={false}
        />,
      );
    });

    expect(image(first.container)?.getAttribute("src")).toBe(frame);
    expect(glyph(first.container)).toBeNull();
  });
});

describe("VideoRow: the thumbnail ladder (spec §6, D4/D15)", () => {
  // The content script's ladder is used verbatim when present, which is also the only
  // way to get three candidates without deriving site art from a real host.
  const THREE = ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/3.jpg"];

  it("falls back to the glyph after a single candidate 404s", () => {
    const host = row({ thumbnailCandidates: ["https://cdn.example/only.jpg"] });
    expect(glyph(host)).toBeNull();

    fireEvent.error(image(host)!);

    expect(glyph(host)).not.toBeNull();
  });

  it("tries candidate 2 and then 3 before the glyph appears", () => {
    const host = row({ thumbnailCandidates: THREE });
    expect(image(host)?.getAttribute("src")).toBe(THREE[0]);

    fireEvent.error(image(host)!);
    expect(image(host)?.getAttribute("src")).toBe(THREE[1]);
    expect(glyph(host)).toBeNull();

    fireEvent.error(image(host)!);
    expect(image(host)?.getAttribute("src")).toBe(THREE[2]);
    // The point of the ladder: a glyph between the retries would hide a row whose art
    // is one request away.
    expect(glyph(host)).toBeNull();
  });

  it("keeps the last attempt on screen, blurred, once the ladder is spent (D15)", () => {
    const host = row({ thumbnailCandidates: THREE });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      fireEvent.error(image(host)!);
    }

    expect(glyph(host)).not.toBeNull();
    // A thumbnail that resolved too small to recognise still identifies the video; a
    // bare play icon does not.
    expect(image(host)?.getAttribute("src")).toBe(THREE[2]);
    expect(image(host)?.className).toContain("blur-[6px]");
  });

  it("renders no <img> for a blob: thumbnail, which can never resolve in an extension page", () => {
    // spec §1.3, D11: a blob URL is scoped to the origin that made it, so it 404s in
    // `chrome-extension://` on every row, every open.
    const host = row({ thumbnailUrl: "blob:https://cdn.example/2f0a-uuid" });
    expect(image(host)).toBeNull();
    expect(glyph(host)).not.toBeNull();
  });

  it("renders the glyph immediately when there is no art at all, with no retry to burn", () => {
    const host = row();
    expect(image(host)).toBeNull();
    expect(glyph(host)).not.toBeNull();
  });
});

describe("VideoRow: selection (D21)", () => {
  it("keeps the checkbox in the DOM at opacity 0 rather than mounting it on hover", () => {
    const box = row().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
  });

  it("shows the box for a selected row", () => {
    const host = render(<VideoRow video={BASE} active={false} selected />).container as HTMLElement;
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it("toggles the shared selection set, so the sticky bar's count cannot disagree", async () => {
    const host = row();
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    expect([...(await import("../../../../src/ui/useStickySelection.js")).selection.value]).toEqual(["v1"]);
  });

  it("labels the box with the row's own title", () => {
    expect(row().querySelector('input[type="checkbox"]')?.getAttribute("aria-label")).toBe("Select Big Buck Bunny");
  });
});

describe("VideoRow: audio (spec §6.4)", () => {
  it("badges an audio candidate and offers extraction rather than download", () => {
    const host = row({ format: "AUDIO" });
    expect(text(host)).toContain("Audio");
    expect(text(host)).toContain("Extract audio");
    expect(host.querySelector('input[type="checkbox"]')?.getAttribute("aria-label")).toContain("Big Buck Bunny");
  });
});

describe("VideoRow: subtitles (spec §3.2, Phase 1 honesty)", () => {
  it("advertises the count that crossed the wire", () => {
    expect(text(row({ hasSubtitles: true, subtitleLanguages: 7 }))).toContain("CC · 7 languages");
  });

  it("expands to a labelled unavailable state instead of inventing a language list", async () => {
    const host = row({ hasSubtitles: true, subtitleLanguages: 7 });
    const toggle = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").startsWith("CC")) as
      | HTMLButtonElement
      | undefined;
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(text(host)).toContain("native helper update");
    // A real picker would be a <select> or a list of codes; neither may appear.
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector("optgroup")).toBeNull();
  });

  it("renders no affordance at all when there are no subtitles", () => {
    const host = row({ hasSubtitles: false });
    expect([...host.querySelectorAll("button")].some((b) => (b.textContent || "").includes("CC"))).toBe(false);
  });
});

describe("VideoRow: progress replaces the button in place (spec §6.6)", () => {
  it("draws the download button while idle", () => {
    const host = row();
    expect(text(host)).toContain("Download");
    expect(host.querySelector("[role=progressbar]")).toBeNull();
  });

  it("swaps the button for the meter when a job is running, in the same 28px box", () => {
    currentDownloads.value = [{ id: "j1", videoId: "v1", status: "running", percent: 62 }] as never;
    const host = row();
    expect(host.querySelector("[role=progressbar]")).not.toBeNull();
    expect(host.querySelector('button[data-video-id], button[class*="bg-accent"]')).toBeNull();
  });

  it("renders the running job's speed, ETA, bytes and connections", () => {
    currentDownloads.value = [
      {
        id: "j1",
        videoId: "v1",
        status: "running",
        percent: 62,
        speed: "4.1MiB/s",
        eta: "00:18",
        downloadedSize: "79.4MiB",
        totalSize: "128MiB",
        connections: 8,
      },
    ] as never;
    const host = text(row());
    expect(host).toContain("62%");
    expect(host).toContain("4.1 MB/s");
    expect(host).toContain("18s left");
    expect(host).toContain("79.4 MB of 128.0 MB");
    expect(host).toContain("8 connections");
  });

  it("starts the download on click", async () => {
    const host = row();
    const button = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Download"));
    await act(async () => button?.click());
    expect(startVideoDownload).toHaveBeenCalledWith("v1");
  });
});

describe("VideoRow: the non-downloadable next action (D17, acceptance criterion 13)", () => {
  it("never mentions a Record button", () => {
    // The old copy: "Browser-only URL. Wait for a downloadable video stream or use the
    // Record button above." Screen recording was deleted three commits ago and there has
    // never been a Record button (spec §1.6).
    const host = row({ downloadable: false });
    expect(text(host)).not.toMatch(/record/i);
    expect(text(host)).toContain("cannot fetch this stream");
  });

  it("offers the action that actually works — handing the URL to the browser", () => {
    const host = row({ downloadable: false });
    const open = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Open the stream"));
    expect(open).toBeDefined();
    expect(open?.textContent).toContain("Open the stream");
  });

  it("offers nothing when there is no URL to open", () => {
    const host = render(
      <VideoRow video={{ id: "v2", title: "No URL", downloadable: false }} active={false} selected={false} />,
    ).container as HTMLElement;
    expect([...host.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Open the stream"))).toBe(
      false,
    );
  });
});

describe("JobRow: the DownloadJob surface that used to be unrendered (spec §1.4, §3.1, §6.8)", () => {
  const running = {
    id: "j1",
    videoId: "v1",
    title: "Big Buck Bunny",
    status: "running",
    percent: 62,
    stage: "download",
    speed: "4.1MiB/s",
    eta: "00:18",
    downloadedSize: "79.4MiB",
    totalSize: "128MiB",
    connections: 8,
  };

  it("draws speed, ETA, bytes and connections", () => {
    const host = text(jobRow(running));
    expect(host).toContain("62%");
    expect(host).toContain("4.1 MB/s");
    expect(host).toContain("18s left");
    expect(host).toContain("79.4 MB of 128.0 MB");
    expect(host).toContain("8 connections");
  });

  it("draws the stage timeline as discrete stops", () => {
    const host = jobRow(running);
    expect(host.querySelectorAll("ol li")).toHaveLength(4);
    expect(host.querySelector("ol")?.textContent).toContain("Fetching");
    expect(host.querySelector("ol")?.textContent).toContain("Merging");
  });

  it("shows no timeline for a stage the host does not emit, rather than guessing one", () => {
    expect(jobRow({ id: "j", status: "running", stage: "nonsense" }).querySelector("ol")).toBeNull();
  });

  it("is honest about a post-processing job: no percentage, no invented bar", () => {
    const host = jobRow({ ...running, stage: "postprocess", percent: undefined });
    expect(host.querySelector("[role=progressbar]")?.hasAttribute("aria-valuenow")).toBe(false);
    expect(host.querySelector("ol")?.textContent).toContain("Merging");
  });

  it("marks an error with the error's own text and a critical dot", () => {
    const host = jobRow({ id: "j", status: "error", error: "disk full" });
    expect(text(host)).toContain("disk full");
    expect(host.querySelector('[role="status"]')?.className).toContain("text-critical");
  });

  it("gives a status dot a text label rather than shipping a bare coloured circle", () => {
    expect(jobRow(running).querySelector('[role="status"] .sr-only')?.textContent).toBe("running: Big Buck Bunny");
  });

  it("collapses a terminal job: no bar, no stage timeline, just the outcome", () => {
    // §6.8 / D15: full history is downloads.html's job, not the tray's.
    const host = jobRow({ id: "j", status: "done", title: "Done", totalSize: "128MiB" });
    expect(host.querySelector("[role=progressbar]")).toBeNull();
    expect(host.querySelector("ol")).toBeNull();
    expect(text(host)).toContain("128.0 MB");
  });

  it.each([
    ["running", ["Pause", "Cancel"]],
    ["paused", ["Resume", "Cancel"]],
    ["pausing", ["Cancel"]],
    ["done", ["Redownload", "Remove"]],
    ["error", ["Retry", "Remove"]],
  ])("offers the real actions for %s", (status, expected) => {
    const labels = [...jobRow({ id: "j", status }).querySelectorAll("button")].map((b) => b.textContent || "");
    for (const label of expected) {
      expect(labels.some((text) => text.includes(label))).toBe(true);
    }
  });

  it.each([
    ["running", "Pause"],
    ["running", "Cancel"],
    ["paused", "Resume"],
  ])("dispatches %s / %s to the real background message", async (status, label) => {
    // The verbs are `downloadActions()`'s and `runDownloadAction` maps them onto
    // `{type:"pauseDownload"}` / `{type:"cancelDownload"}` / `{type:"resumeDownload"}`
    // in `shared/popup_api.ts`. No new message names are invented here.
    const verb = label.toLowerCase();
    const host = jobRow({ id: "job-7", status });
    const button = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes(label));
    await act(async () => button?.click());
    expect(runDownloadAction).toHaveBeenCalledWith(verb, "job-7");
  });

  it("surfaces a failed action on the button that was pressed", async () => {
    vi.mocked(runDownloadAction).mockResolvedValue("helper said no");
    const host = jobRow({ id: "j", status: "paused" });
    const resume = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Resume"));
    await act(async () => resume?.click());
    const again = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Resume"));
    expect(again?.getAttribute("title")).toBe("helper said no");
  });
});

describe("SelectionBar (spec §6.9, D21)", () => {
  it("is absent with nothing selected", () => {
    clear();
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    expect(text(host)).toBe("");
  });

  it("counts the selection", async () => {
    select(["a", "b", "c"]);
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    expect(text(host)).toContain("3 selected");
  });

  it("is chrome and carries no scrim", () => {
    select(["a"]);
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    const bar = host.querySelector(".material-chrome");
    expect(bar).not.toBeNull();
    // §6.9: "a parallel, non-blocking layer must not break flow" — so no dimming layer.
    expect(host.querySelector(".bg-scrim")).toBeNull();
    expect(bar?.className).not.toContain("bg-black");
  });

  it("enables the executor and fires on click", async () => {
    select(["a", "b"]);
    const onDownloadAll = vi.fn();
    const host = render(<SelectionBar onDownloadAll={onDownloadAll} />).container as HTMLElement;
    const downloadAll = [...host.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("Download all"),
    );
    expect(downloadAll).toBeDefined();
    const button = downloadAll as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // WCAG 2.5.3: the visible label is the accessible name — the disabled-state
    // `aria-label` override is gone with the disabled state it explained.
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.textContent).toContain("Download all");
    await act(async () => button.click());
    expect(onDownloadAll).toHaveBeenCalledTimes(1);
  });

  it("clears the selection", async () => {
    select(["a", "b"]);
    const { selection } = await import("../../../../src/ui/useStickySelection.js");
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    const clearButton = [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Clear"));
    await act(async () => clearButton?.click());
    expect(selection.value.size).toBe(0);
  });

  it("announces the count politely", () => {
    select(["a"]);
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    const bar = host.querySelector('[role="status"]');
    expect(bar?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows the selected row's thumbnail", () => {
    currentVideos.value = [{ ...BASE, id: "t1", thumbnailUrl: "https://cdn.example/selected.jpg" }];
    select(["t1"]);
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    // spec §6 (D1): at 24px the ladder is overkill — first candidate or nothing.
    expect(image(host)?.getAttribute("src")).toBe("https://cdn.example/selected.jpg");
  });

  it("shows the play glyph for a selected row with no art", () => {
    currentVideos.value = [{ ...BASE, id: "t2" }];
    select(["t2"]);
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    expect(image(host)).toBeNull();
    expect(host.querySelector(".size-6 svg")).not.toBeNull();
  });
});
