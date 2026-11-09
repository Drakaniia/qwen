/**
 * Worker-startup state and the `formats` pass-through, both read through a fresh
 * `tab_state` module so its load-once flag starts clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function mockStorage(stored: Record<string, unknown>): void {
  vi.spyOn(chrome.storage.local, "get").mockImplementation(((_keys: unknown, cb: (items: unknown) => void) =>
    cb(stored)) as never);
  vi.spyOn(chrome.storage.local, "set").mockImplementation(((_items: unknown, cb?: () => void) => cb?.()) as never);
  vi.spyOn(chrome.storage.sync, "get").mockImplementation(((_keys: unknown, cb: (items: unknown) => void) =>
    cb({})) as never);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tab_state.load", () => {
  it("applies the stored history-sync toggle instead of booting with sync on", async () => {
    mockStorage({ qwinSettings: { downloadSyncEnabled: false } });
    const tabState = await import("../../../src/background/tab_state.js");
    const downloadSync = await import("../../../src/shared/download_sync.js");

    expect(downloadSync.isSyncEnabled()).toBe(true);
    await tabState.load();
    expect(downloadSync.isSyncEnabled()).toBe(false);
  });
});

describe("getNativeFormatsForVideo", () => {
  it("passes audio-only entries, their codec fields and the media duration through untouched", async () => {
    mockStorage({});
    vi.spyOn(chrome.tabs, "sendMessage").mockImplementation(((_tab: unknown, _msg: unknown, cb?: () => void) =>
      cb?.()) as never);
    const { getNativeFormatsForVideo } = await import("../../../src/background/format_helpers.js");
    const audio = {
      id: "140",
      ext: "m4a",
      kind: "audio",
      vcodec: "none",
      acodec: "mp4a.40.2",
      abr: 129,
      protocol: "https",
    };
    const video = {
      id: "137",
      ext: "mp4",
      kind: "video",
      vcodec: "avc1",
      acodec: "none",
      height: 1080,
      protocol: "https",
    };
    const nativeRequest = vi.fn(async () => ({ formats: [audio, video], duration: 212, title: "Song" }));

    const result = await getNativeFormatsForVideo(
      7,
      { id: "v1", url: "https://www.youtube.com/watch?v=abc", pageUrl: "https://www.youtube.com/watch?v=abc" },
      () => [],
      undefined,
      nativeRequest as never,
      async () => null,
    );

    expect(result.duration).toBe(212);
    expect(result.formats).toHaveLength(2);
    expect(result.formats[0]).toMatchObject({ ...audio, formatId: "140", optionType: "native-format" });
    expect(result.formats[0].height).toBeUndefined();
    expect(result.formats[1]).toMatchObject({ kind: "video", vcodec: "avc1", height: 1080 });
  });

  it("joins the host's separate audioFormats list after the video formats", async () => {
    mockStorage({});
    vi.spyOn(chrome.tabs, "sendMessage").mockImplementation(((_tab: unknown, _msg: unknown, cb?: () => void) =>
      cb?.()) as never);
    const { getNativeFormatsForVideo } = await import("../../../src/background/format_helpers.js");
    const nativeRequest = vi.fn(async () => ({
      formats: [{ id: "137", ext: "mp4", kind: "video", height: 1080 }],
      // `yt_dlp_command.py`'s shape: the `id` is a full selector, `formatId` the bare id.
      audioFormats: [{ id: "140/bestaudio", formatId: "140", kind: "audio", vcodec: "none", abr: 129, ext: "m4a" }],
      duration: 60,
    }));

    const result = await getNativeFormatsForVideo(
      7,
      { id: "v1", url: "https://www.youtube.com/watch?v=abc", pageUrl: "https://www.youtube.com/watch?v=abc" },
      () => [],
      undefined,
      nativeRequest as never,
      async () => null,
    );

    expect(result.formats.map((format) => format.kind)).toEqual(["video", "audio"]);
    // The selector is what goes back to the host as the chosen format, verbatim.
    expect(result.formats[1]).toMatchObject({ id: "140/bestaudio", formatId: "140/bestaudio", abr: 129 });
    expect(result.unavailableReason).toBe("");
  });
});
