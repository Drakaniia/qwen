import { beforeEach, describe, expect, it, vi } from "vitest";

// Import prefix from tests/js/popup/ is ../../../src/ (mirrors media_list.test.ts).
// `enumeratePlaylist` and `downloadMany` are asserted through `toHaveBeenCalledWith`, so
// these are the only two mocks here that exist to prove a call's arguments, not just that
// something happened. The rest are what the module graph reaches for on boot.
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

const PLAYLIST_URL = "https://open.spotify.com/playlist/abc123";

/** Load the module fresh so a signal set by one test cannot leak into the next. */
async function loadResolvePastedUrl() {
  vi.resetModules();
  return (await import("../../../src/popup/popup_url_events.js")).resolvePastedUrl;
}

describe("resolvePastedUrl playlist branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands a playlist to rows and skips the quality dialog", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({
      ok: true,
      videoIds: ["v1", "v2"],
      playlistTitle: "My Mix",
      totalItems: 2,
    } as never);

    const resolvePastedUrl = await loadResolvePastedUrl();
    const { notice, viewMode } = await import("../../../src/popup/state/app.js");

    const opened = await resolvePastedUrl(PLAYLIST_URL);

    expect(opened).toBe(true);
    // The tab id comes from `tabsQuery` in the mock above, so this also pins the arg order.
    expect(api.enumeratePlaylist).toHaveBeenCalledWith(7, PLAYLIST_URL);
    // The whole point of the branch: rows, not a quality sheet.
    expect(api.getFormatsForUrl).not.toHaveBeenCalled();
    expect(viewMode.value).toBe("downloads");
    expect(notice.value).toEqual({ text: "Added 2 tracks from My Mix.", isError: false });
  });

  it("names an untitled playlist rather than printing undefined", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({ ok: true, videoIds: ["v1"] } as never);

    const resolvePastedUrl = await loadResolvePastedUrl();
    const { notice } = await import("../../../src/popup/state/app.js");

    await resolvePastedUrl(PLAYLIST_URL);

    expect(notice.value.text).toBe("Added 1 tracks from playlist.");
  });

  it("falls back to single-URL flow on the single-track sentinel", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    // The host prefixes the marker with prose, so the check has to be a substring match â€”
    // this is the string the native side actually raises, not a bare marker.
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({
      ok: false,
      error: "__QWIN_SINGLE_TRACK__ Use the formats flow for individual tracks.",
    } as never);
    vi.mocked(api.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);

    const resolvePastedUrl = await loadResolvePastedUrl();
    const { notice } = await import("../../../src/popup/state/app.js");

    const opened = await resolvePastedUrl("https://open.spotify.com/track/abc123");

    expect(api.getFormatsForUrl).toHaveBeenCalledTimes(1);
    expect(opened).toBe(true);
    // The sentinel is an internal marker: it must never reach the user.
    expect(notice.value.isError).toBe(false);
    expect(notice.value.text).not.toContain("__QWIN_SINGLE_TRACK__");
  });

  it("reports a real enumeration failure instead of trying the single flow", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({ ok: false, error: "Playlist is private." } as never);

    const resolvePastedUrl = await loadResolvePastedUrl();
    const { notice } = await import("../../../src/popup/state/app.js");

    const opened = await resolvePastedUrl(PLAYLIST_URL);

    expect(opened).toBe(false);
    expect(api.getFormatsForUrl).not.toHaveBeenCalled();
    expect(notice.value).toEqual({ text: "Playlist is private.", isError: true });
  });
});
