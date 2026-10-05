/**
 * History-row thumbnails (spec `thumbnail-spec.md` §7, §7.2).
 *
 * Two halves of one story. `fromSync` derives what a synced entry's single persisted
 * `url` implies, and `HistoryRow` walks the resulting ladder instead of latching on the
 * first `onError` — the old code gave up after one failed request, which is how a
 * 403'd candidate turned into a permanently blank tile (spec §1.4).
 *
 * The glyph tile is the ladder's floor, not its replacement: it must not appear while
 * any candidate is still untried, and it must appear once they are all used up.
 */
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryRow } from "../../../src/popup/downloads/HistoryRow.js";
import {
  framesByUrl,
  history,
  jobs,
  loadAll,
  records,
  type DownloadRecord,
} from "../../../src/popup/downloads/state.js";

const NOW = Date.now();

/** A row's fields only — the actions and the progress line need nothing from a test. */
function record(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    key: "row",
    title: "Clip",
    url: "https://cdn.example/clip.mp4",
    sourceHost: "cdn.example",
    format: "MP4",
    status: "done",
    size: "",
    updatedAt: NOW,
    thumbnailUrl: "",
    live: false,
    ...overrides,
  };
}

function renderRow(overrides: Partial<DownloadRecord> = {}) {
  return render(
    <HistoryRow
      record={record(overrides)}
      id="row"
      selected={false}
      active={false}
      onSelect={() => {}}
      onOpen={() => {}}
      onReveal={() => {}}
    />,
  );
}

/** The glyph tile is the only `span.w-16` on a row; `StatusDot` draws no icon. */
function glyph(container: Element): Element | null {
  return container.querySelector("span.w-16 svg");
}

function image(container: Element): HTMLImageElement | null {
  return container.querySelector("img");
}

const MANIFEST = "https://cdn.example/live/master.m3u8";
const FRAME = "data:image/jpeg;base64,AAAA";

beforeEach(() => {
  jobs.value = [];
  history.value = [];
  framesByUrl.value = {};
});

afterEach(cleanup);

describe("synced history derives art from its one url (spec §7.2, D6)", () => {
  it("gives a YouTube watch entry its row", () => {
    history.value = [
      { title: "Synced", status: "done", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", completedAt: NOW },
    ];

    expect(records.value[0].thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("gives a youtu.be entry the same row", () => {
    history.value = [{ title: "Synced", status: "done", url: "https://youtu.be/dQw4w9WgXcQ", completedAt: NOW }];

    expect(records.value[0].thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("leaves a direct media entry on the glyph — no page context survives D6", () => {
    history.value = [{ title: "Synced", status: "done", url: "https://cdn.example/clip.mp4", completedAt: NOW }];

    expect(records.value[0].thumbnailUrl).toBe("");
  });
});

describe("HistoryRow renders the ladder", () => {
  it("shows the stamped thumbnail for a record that has one", () => {
    const { container } = renderRow({ thumbnailUrl: "https://cdn.example/poster.jpg" });

    expect(image(container)?.getAttribute("src")).toBe("https://cdn.example/poster.jpg");
    expect(glyph(container)).toBeNull();
  });

  it("falls back to the glyph tile for a record with no thumbnail", () => {
    const { container } = renderRow();

    expect(image(container)).toBeNull();
    expect(glyph(container)).not.toBeNull();
  });

  it("renders no <img> at all for a blob: thumbnail, which can never resolve", () => {
    const { container } = renderRow({ thumbnailUrl: "blob:https://cdn.example/2f0a-uuid" });

    expect(image(container)).toBeNull();
    expect(glyph(container)).not.toBeNull();
  });
});

describe("a stream frame closes the last rung (hls-thumbnail-spec.md §1.3, §5.3, H7)", () => {
  type Callback = (response: unknown) => void;
  type SendMessage = (message: unknown, callback?: Callback) => void;

  /**
   * `browser_api` is callback-mode under these tests, so one stub answers both the sync
   * history read and the frame lookup, and records every message the page sent.
   */
  function stubChrome(frames: Record<string, string>): unknown[] {
    const sent: unknown[] = [];
    // `loadAll` reads `storage.local` too, and the MV3 mock never calls the callback on
    // its own — `browser_api`'s promise wrapper would hang forever without this.
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys: unknown, callback?: (items: unknown) => void) =>
      callback?.({}),
    );
    (chrome.runtime.sendMessage as unknown as { mockImplementation: (fn: SendMessage) => void }).mockImplementation(
      (message, callback) => {
        const request = message as { type?: string; urls?: string[] };
        sent.push(request);
        if (request.type === "getDownloadSyncHistory") {
          callback?.({
            ok: true,
            history: [{ title: "Live", status: "done", url: MANIFEST, completedAt: NOW }],
            syncInfo: { totalCount: 1, syncEnabled: true },
          });
          return;
        }
        if (request.type === "thumbnailFrames") {
          // Misses are absent, per §5.3 — the row keeps its glyph.
          callback?.({
            ok: true,
            frames: Object.fromEntries(
              (request.urls || []).filter((url) => url in frames).map((url) => [url, frames[url]]),
            ),
          });
          return;
        }
        callback?.({ ok: true });
      },
    );
    return sent;
  }

  it("renders the frame for a synced .m3u8 entry that derivation could never reach", async () => {
    stubChrome({ [MANIFEST]: FRAME });

    await loadAll();

    expect(records.value[0].thumbnailUrl).toBe(FRAME);
    const { container } = renderRow({ thumbnailUrl: records.value[0].thumbnailUrl, format: "MP4" });
    expect(image(container)?.getAttribute("src")).toBe(FRAME);
    expect(glyph(container)).toBeNull();
  });

  it("leaves the glyph on a miss", async () => {
    stubChrome({});

    await loadAll();

    expect(records.value[0].thumbnailUrl).toBe("");
    const { container } = renderRow({ thumbnailUrl: records.value[0].thumbnailUrl, format: "MP4" });
    expect(image(container)).toBeNull();
    expect(glyph(container)).not.toBeNull();
  });

  it("asks once for the whole list, and never for a row that already has art", async () => {
    const sent = stubChrome({ [MANIFEST]: FRAME });

    history.value = [
      { title: "Live", status: "done", url: MANIFEST, completedAt: NOW },
      { title: "Clip", status: "done", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", completedAt: NOW - 1 },
    ];
    await loadAll();

    const lookups = sent.filter((message) => (message as { type?: string }).type === "thumbnailFrames");
    expect(lookups).toHaveLength(1);
    // The YouTube row derives its own art, so asking about it would only cost an
    // ffmpeg spawn to replace art it already has.
    expect((lookups[0] as { urls: string[] }).urls).toEqual([MANIFEST]);
  });
});

describe("onError advances the ladder instead of latching (spec §1.4)", () => {
  // Two candidates: the stamped thumbnail, then what the url derives.
  const twoEntryLadder = {
    thumbnailUrl: "https://cdn.example/poster.jpg",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  };

  it("tries the next candidate on the first failure, with no glyph in between", () => {
    const { container } = renderRow(twoEntryLadder);

    fireEvent.error(image(container)!);

    expect(image(container)?.getAttribute("src")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(glyph(container)).toBeNull();
  });

  it("shows the glyph once every candidate has failed", () => {
    const { container } = renderRow(twoEntryLadder);

    fireEvent.error(image(container)!);
    fireEvent.error(image(container)!);

    expect(image(container)).toBeNull();
    expect(glyph(container)).not.toBeNull();
  });
});
