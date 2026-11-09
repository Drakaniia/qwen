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
import { clear, select, selectedCount } from "../../../../src/ui/useStickySelection.js";

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

/**
 * The row's own Download button. Label-matched rather than picked by position, so an
 * audio row's "Extract audio" and a subtitles row's "CC" toggle cannot satisfy it.
 */
function downloadButton(host: Element): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Download"));
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
    expect(image(host)?.className).toContain("blur-sm");
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
  /**
   * The checkbox's ancestors, nearest first. Written as a walk rather than a selector
   * because the fix that matters is "no ancestor hides it" — pinning *which* wrapper
   * carries the class would re-break the moment the markup changes shape.
   */
  function wrappersOf(input: Element): Element[] {
    const chain: Element[] = [];
    for (let node = input.parentElement; node; node = node.parentElement) {
      chain.push(node);
    }
    return chain;
  }

  it("leaves an unchecked box visible, at every width and on any pointer (D21)", () => {
    // The row used to rest at `opacity-0` and reveal on `group-hover`, which at the
    // default 460px popup width on a desktop browser left an invisible box and nothing
    // to aim at. The reported symptom was "the checkbox is not clickable"; the handler
    // was always fine, so the assertion is on the class list rather than on `checked`.
    const box = row().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    for (const node of wrappersOf(box)) {
      expect(node.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    }
  });

  it("keeps the checked-state crossfade the spec's one permitted tween (§4.5, §4.6)", () => {
    const box = row().querySelector('input[type="checkbox"]') as HTMLInputElement;
    // 150ms on opacity only — `theme.css` clamps it to 150ms under reduced motion, so
    // the fade survives rather than being dropped.
    expect(
      wrappersOf(box)
        .map((node) => node.className)
        .join(" "),
    ).toMatch(/transition-opacity/);
    expect(
      wrappersOf(box)
        .map((node) => node.className)
        .join(" "),
    ).toMatch(/duration-150/);
  });

  it("makes the input itself the hit area, so a click on the drawn box lands (D21)", () => {
    // vitest cannot hit-test — `input.click()` dispatches directly on the node — so the
    // invariant is pinned in the class list instead. `sr-only` on the input plus
    // `pointer-events-none` on the drawn box left a label-less checkbox with a 1px
    // target: visible, focusable, and still not clickable.
    const box = row().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.className).toContain("absolute");
    expect(box.className).toContain("inset-0");
    expect(box.className).toContain("size-full");
    expect(box.className).not.toContain("sr-only");
    // Still visually hidden, so the platform-drawn box is what the user sees.
    expect(box.className).toContain("opacity-0");
  });

  it("keeps the checkbox in the DOM at every width rather than mounting it on hover", () => {
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

  it("toggles on click: the box checks itself and the bar's count follows, both ways", async () => {
    // The whole loop in one case, because the symptom was "not clickable" and no single
    // link in it — input, `toggle`, the signal, the re-read of `isSelected` — was ever
    // broken on its own. `selectedCount` is the `computed` behind `SelectionBar`'s label.
    const host = row();
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(selectedCount.value).toBe(0);

    await act(async () => box.click());

    expect(box.checked).toBe(true);
    expect(selectedCount.value).toBe(1);

    await act(async () => box.click());

    expect(box.checked).toBe(false);
    expect(selectedCount.value).toBe(0);
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

describe("VideoRow: a selection takes the buttons over (spec §6.9, D21)", () => {
  it("draws every downloadable row's button while nothing is selected", () => {
    expect(selectedCount.value).toBe(0);
    expect(downloadButton(row({ id: "a" }))).toBeDefined();
    expect(downloadButton(row({ id: "b" }))).toBeDefined();
  });

  it("hides every row's button as soon as anything is selected — selected or not", async () => {
    // The chosen semantics: the sticky bar's "Download all" is the only way to start
    // anything, so a row left showing a competing button contradicts it. `b` is not in
    // the selection and still loses its button.
    const hosts = [row({ id: "a" }), row({ id: "b" })];
    await act(async () => select(["a", "b"]));

    expect(selectedCount.value).toBe(2);
    for (const host of hosts) {
      expect(downloadButton(host)).toBeUndefined();
    }
    // The row itself survives: only the action column empties.
    expect(hosts[0].querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it("re-renders on the count alone, without a prop or an effect", async () => {
    // The signal read happens during render, so writing the signal is what re-renders
    // the row — no `useEffect`, no parent re-render.
    const host = row({ id: "solo" });
    expect(downloadButton(host)).toBeDefined();
    await act(async () => select(["solo"]));
    expect(downloadButton(host)).toBeUndefined();
  });

  it("brings the buttons back when the selection is cleared", async () => {
    const host = row({ id: "a" });
    await act(async () => select(["a", "b"]));
    expect(downloadButton(host)).toBeUndefined();

    await act(async () => clear());

    expect(selectedCount.value).toBe(0);
    expect(downloadButton(host)).toBeDefined();
  });

  it("still reports a running job's meter while selected — the button, not the bar, goes", async () => {
    // The regression guard for the branch order: hiding the button must not hide the
    // progress that replaced it, or a download in flight goes invisible the moment the
    // user touches the checkbox.
    currentDownloads.value = [{ id: "j1", videoId: "a", status: "running", percent: 62 }] as never;
    const host = row({ id: "a" });
    expect(host.querySelector("[role=progressbar]")).not.toBeNull();

    await act(async () => select(["a"]));

    expect(host.querySelector("[role=progressbar]")).not.toBeNull();
    expect(text(host)).toContain("62%");
    expect(downloadButton(host)).toBeUndefined();
  });
});

describe("VideoRow: a folder track keeps its own Download action (spec §6.9)", () => {
  const PLAYLIST = "https://music.youtube.com/playlist?list=PLY5CT0TRwHPt";

  /** A track row as `MediaView` renders it under an open folder header. */
  function track(video: Partial<VideoCandidate> = {}): HTMLElement {
    return render(
      <VideoRow
        video={{ ...BASE, playlistId: PLAYLIST, source: "playlist", ...video } as VideoCandidate}
        active={false}
        selected={false}
        inFolder
      />,
    ).container as HTMLElement;
  }

  it("keeps the button while the paste's own selection is active", async () => {
    // The reported gap: `resolvePastedUrl` pre-selects every track it added, so the bulk
    // rule hid the button on every row of the folder for as long as that selection stood
    // — "Download all" on the bar was the only way to take a single track out of it.
    const host = track({ id: "a" });
    await act(async () => select(["a", "b"]));

    expect(selectedCount.value).toBe(2);
    expect(downloadButton(host)).toBeDefined();
  });

  it("downloads just that track on click, without touching the selection", async () => {
    const host = track({ id: "solo" });
    await act(async () => select(["solo", "other"]));

    await act(async () => downloadButton(host)?.click());

    expect(startVideoDownload).toHaveBeenCalledWith("solo");
    expect(selectedCount.value).toBe(2);
  });

  it("still swaps to the running job's meter rather than adding a second control", async () => {
    currentDownloads.value = [{ id: "j1", videoId: "a", status: "running", percent: 62 }] as never;
    const host = track({ id: "a" });
    await act(async () => select(["a"]));

    expect(host.querySelector("[role=progressbar]")).not.toBeNull();
    expect(downloadButton(host)).toBeUndefined();
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

  it("keeps the executor reachable once the tile strip outgrows the bar", () => {
    // 40 tiles at 24px is ~1000px of flex basis in a 460px popup. A `shrink-0` strip
    // overflows rather than clips, and takes "Download all" off the right edge with it.
    currentVideos.value = Array.from({ length: 40 }, (_, n) => ({ ...BASE, id: `many-${n}` }));
    select(currentVideos.value.map((video) => video.id));
    const host = render(<SelectionBar onDownloadAll={vi.fn()} />).container as HTMLElement;
    const buttons = [...host.querySelectorAll("button")];
    const downloadAll = buttons.find((b) => (b.textContent || "").includes("Download all")) as HTMLButtonElement;
    expect(downloadAll).toBeDefined();
    // The strip yields; the buttons never do.
    expect(downloadAll.className).toContain("shrink-0");
    const strip = host.querySelector(".size-6")?.parentElement;
    expect(strip?.className).toContain("shrink");
    expect(strip?.className).not.toContain("shrink-0");
    // The swipe is the native `overflow-x` scroll, so the box has to be one — and it has
    // to hold the width the count used to claim, or there is nothing to scroll.
    expect(strip?.className).toContain("overflow-x-auto");
    expect(strip?.className).toContain("grow");
    const count = host.querySelector(".nums");
    expect(count?.className).not.toContain("flex-1");
  });
});
