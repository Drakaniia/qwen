import { beforeEach, describe, expect, it, vi } from "vitest";

// Import prefix from tests/js/popup/ is ../../../src/ (mirrors media_list.test.ts).
vi.mock("../../../src/shared/popup_api.js", () => ({
  enumeratePlaylist: vi.fn(),
  getFormatsForUrl: vi.fn(),
  downloadVideo: vi.fn(),
  downloadMany: vi.fn(),
  saveSettings: vi.fn(async () => ({})),
  tabsQuery: vi.fn(async () => [{ id: 7, url: "https://open.spotify.com/playlist/abc123" }]),
  getVideos: vi.fn(async () => ({ ok: true, videos: [], downloads: [], settings: {} })),
  getDownloadSyncHistory: vi.fn(async () => ({ ok: true, history: [], syncInfo: {} })),
}));

import * as PopupApi from "../../../src/shared/popup_api.js";
import { notice, viewMode } from "../../../src/popup/state/app.js";
import { resolvePastedUrl } from "../../../src/popup/popup_url_events.js";
import { batchDownloadSelection } from "../../../src/popup/views/PopupFrame.js";
import { selection } from "../../../src/ui/useStickySelection.js";

const PLAYLIST_URL = "https://open.spotify.com/playlist/abc123";

// Every signal this file reads is module-level, and both suites below write them, so each
// test starts from the initial value rather than from whatever ran before it.
function resetSignals() {
  viewMode.value = "media";
  notice.value = { text: "", isError: false };
  selection.value = new Set();
}

describe("resolvePastedUrl playlist branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSignals();
  });

  it("expands a playlist to rows and skips the quality dialog", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({
      ok: true,
      videoIds: ["v1", "v2"],
      playlistTitle: "My Mix",
      totalItems: 2,
    } as never);

    const opened = await resolvePastedUrl(PLAYLIST_URL);

    expect(opened).toBe(true);
    // The tab id comes from the `tabsQuery` mock above, so this also pins the arg order.
    expect(PopupApi.enumeratePlaylist).toHaveBeenCalledWith(7, PLAYLIST_URL);
    // The whole point of the branch: rows, not a quality sheet.
    expect(PopupApi.getFormatsForUrl).not.toHaveBeenCalled();
    expect(viewMode.value).toBe("downloads");
    expect(notice.value).toEqual({ text: "Added 2 tracks from My Mix.", isError: false });
  });

  it("names an untitled playlist rather than printing undefined", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({ ok: true, videoIds: ["v1"] } as never);

    await resolvePastedUrl(PLAYLIST_URL);

    expect(notice.value.text).toBe("Added 1 tracks from playlist.");
  });

  it("falls back to single-URL flow on the single-track sentinel", async () => {
    // The host prefixes the marker with prose, so this has to be a substring match — this
    // is the string the native side actually raises, not a bare marker.
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({
      ok: false,
      error: "__QWIN_SINGLE_TRACK__ Use the formats flow for individual tracks.",
    } as never);
    vi.mocked(PopupApi.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);

    const opened = await resolvePastedUrl("https://open.spotify.com/track/abc123");

    expect(PopupApi.getFormatsForUrl).toHaveBeenCalledTimes(1);
    expect(opened).toBe(true);
    // The sentinel is an internal marker: it must never reach the user.
    expect(notice.value.isError).toBe(false);
    expect(notice.value.text).not.toContain("__QWIN_SINGLE_TRACK__");
  });

  it("reports a real enumeration failure instead of trying the single flow", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({ ok: false, error: "Playlist is private." } as never);

    const opened = await resolvePastedUrl(PLAYLIST_URL);

    expect(opened).toBe(false);
    expect(PopupApi.getFormatsForUrl).not.toHaveBeenCalled();
    expect(notice.value).toEqual({ text: "Playlist is private.", isError: true });
  });
});

describe("batchDownloadSelection (spec §6.9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSignals();
  });

  it("sends the ordered selection to downloadMany and clears it", async () => {
    vi.mocked(PopupApi.downloadMany).mockResolvedValue({ ok: true, jobIds: ["j1", "j2"] } as never);
    // Selection order is what the bar walks, so this seeds a non-alphabetical order: an
    // implementation that sorted or deduped on the way through would fail here.
    const ordered = ["v3", "v1", "v2"];
    selection.value = new Set(ordered);

    const reply = await batchDownloadSelection(7, ordered, "best");

    expect(PopupApi.downloadMany).toHaveBeenCalledWith(7, ordered, "best");
    expect(reply.jobIds).toHaveLength(2);
    expect(selection.value.size).toBe(0);
    expect(viewMode.value).toBe("downloads");
  });

  it("defaults to the best format", async () => {
    vi.mocked(PopupApi.downloadMany).mockResolvedValue({ ok: true, jobIds: ["j1"] } as never);

    await batchDownloadSelection(7, ["v1"]);

    expect(PopupApi.downloadMany).toHaveBeenCalledWith(7, ["v1"], "best");
  });

  it("throws the host's message and keeps the selection when the batch does not start", async () => {
    vi.mocked(PopupApi.downloadMany).mockResolvedValue({ ok: false, error: "Helper is not connected." } as never);
    selection.value = new Set(["v1"]);

    await expect(batchDownloadSelection(7, ["v1"])).rejects.toThrow("Helper is not connected.");
    // Nothing started, so nothing is forgiven — dropping the selection here would make the
    // retry impossible without re-selecting every row.
    expect(selection.value.size).toBe(1);
  });
});
