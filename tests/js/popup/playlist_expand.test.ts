import { act, cleanup, render } from "@testing-library/preact";
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { hideQualityDialog, notice, qualityDialog, viewMode } from "../../../src/popup/state/app.js";
import { resolvePastedUrl } from "../../../src/popup/popup_url_events.js";
import { batchDownloadSelection } from "../../../src/popup/views/PopupFrame.js";
import { PlaylistRow } from "../../../src/popup/views/PlaylistRow.js";
import { DEFAULT_FILTER } from "../../../src/ui/filter.js";
import { groupUniqueFullVideos } from "../../../src/shared/video_sorting.js";
import { selection } from "../../../src/ui/useStickySelection.js";
import {
  expandedPlaylists,
  isPlaylistExpanded,
  mediaRows,
  playlistSelectionState,
  setPlaylistChildrenSelected,
  togglePlaylist,
  type MediaRow,
  type PlaylistGroup,
} from "../../../src/popup/state/playlists.js";
import {
  currentVideos,
  displayedVideos,
  setScanStatus,
  sizeThreshold,
  videoFilter,
  type VideoCandidate,
} from "../../../src/popup/state/videos.js";

const PLAYLIST_URL = "https://open.spotify.com/playlist/abc123";

// Every signal this file reads is module-level, and both suites below write them, so each
// test starts from the initial value rather than from whatever ran before it.
function resetSignals() {
  viewMode.value = "media";
  notice.value = { text: "", isError: false };
  selection.value = new Set();
  // The quality sheet is now opened BEFORE enumeration, so it is module state these tests
  // both read and write.
  hideQualityDialog();
}

/** The `ok` reply `enumeratePlaylist` sends for a genuine multi-item collection. */
function collectionReply(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    isCollection: true,
    videoIds: ["v1", "v2"],
    playlistTitle: "My Mix",
    totalItems: 2,
    truncated: false,
    ...overrides,
  };
}

describe("resolvePastedUrl playlist branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSignals();
  });

  it("expands a playlist to rows and skips the quality dialog", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue(collectionReply() as never);

    const opened = await resolvePastedUrl(PLAYLIST_URL);

    expect(opened).toBe(true);
    // The tab id comes from the `tabsQuery` mock above, so this also pins the arg order.
    expect(PopupApi.enumeratePlaylist).toHaveBeenCalledWith(7, PLAYLIST_URL);
    // The whole point of the branch: rows, not a quality sheet.
    expect(PopupApi.getFormatsForUrl).not.toHaveBeenCalled();
    // Rows live in Media — switching to Downloads hid the expansion behind the job tray.
    expect(viewMode.value).toBe("media");
    expect(notice.value).toEqual({ text: "Added 2 tracks from My Mix. Press Download all.", isError: false });
    // Pre-selected so the selection bar offers Download all in one click.
    expect([...selection.value]).toEqual(["v1", "v2"]);
  });

  it("names an untitled playlist rather than printing undefined", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue(
      collectionReply({ playlistTitle: "", videoIds: ["v1"], totalItems: 1 }) as never,
    );

    await resolvePastedUrl(PLAYLIST_URL);

    expect(notice.value.text).toBe("Added 1 tracks from playlist. Press Download all.");
  });

  it("names the real total when the enumeration was truncated (spec §4)", async () => {
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue(
      collectionReply({
        videoIds: Array.from({ length: 100 }, (_v, i) => `v${i}`),
        totalItems: 300,
        truncated: true,
      }) as never,
    );

    await resolvePastedUrl(PLAYLIST_URL);

    expect(notice.value.text).toBe("Added 100 tracks from My Mix — the first 100 of 300. Press Download all.");
  });

  it("falls through to the quality sheet for a single item the host did not vouch for", async () => {
    // `yt-dlp --flat-playlist` answers a plain YouTube link or a direct MP4 with ONE
    // entry and no playlist title. Treating that as a one-item playlist took the quality
    // picker away from every ordinary paste, so the host's `isCollection` gates the
    // branch — a length check would not have caught it.
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({
      ok: true,
      isCollection: false,
      videoIds: ["v1"],
      playlistTitle: "",
      totalItems: 1,
      truncated: false,
    } as never);
    vi.mocked(PopupApi.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);

    const opened = await resolvePastedUrl("https://www.youtube.com/watch?v=abc123");

    expect(opened).toBe(true);
    expect(PopupApi.getFormatsForUrl).toHaveBeenCalledTimes(1);
    expect(viewMode.value).not.toBe("downloads");
    expect(notice.value.text).not.toContain("Added 1 tracks");
  });

  it("falls through when a one-item answer omits isCollection entirely", async () => {
    // Anything the host did not explicitly vouch for goes to the formats flow.
    vi.mocked(PopupApi.enumeratePlaylist).mockResolvedValue({ ok: true, videoIds: ["v1"] } as never);
    vi.mocked(PopupApi.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);

    await resolvePastedUrl(PLAYLIST_URL);

    expect(PopupApi.getFormatsForUrl).toHaveBeenCalledTimes(1);
    expect(notice.value.text).not.toContain("Added");
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

  it("recovers into the single-URL flow when enumeration rejects outright", async () => {
    // A transport-level rejection says nothing about the URL: the helper can be down, the
    // worker asleep, the 90s enumeration timeout expiring on a big playlist. Letting it
    // escape made the paste box a silent no-op — nothing above this call has a catch.
    vi.mocked(PopupApi.enumeratePlaylist).mockRejectedValue(new Error("Could not establish connection."));
    vi.mocked(PopupApi.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);

    const opened = await resolvePastedUrl("https://example.com/video.mp4");

    expect(opened).toBe(true);
    expect(PopupApi.getFormatsForUrl).toHaveBeenCalledTimes(1);
    expect(notice.value.isError).toBe(false);
  });

  it("shows the quality sheet before it waits on enumeration", async () => {
    // ALSO-FIX 2: every non-Spotify paste is extracted twice, and with the dialog opened
    // only afterwards the whole first extraction passed with nothing on screen.
    const seen: boolean[] = [];
    vi.mocked(PopupApi.enumeratePlaylist).mockImplementation(async () => {
      seen.push(qualityDialog.value.open);
      return collectionReply();
    });

    await resolvePastedUrl(PLAYLIST_URL);

    expect(seen).toEqual([true]);
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

// ── The folder the rows render in (`popup/state/playlists.ts`) ──────────────────

const FOLDER = "https://open.spotify.com/playlist/abc123";
const FOLDER_COVER = "https://i.scdn.co/image/folder";

/** One track of `folder`. `lastSeen` keeps the default recency sort in input order. */
function song(id: string, lastSeen: number, folder: string | null = FOLDER): VideoCandidate {
  return {
    id,
    url: `https://open.spotify.com/track/${id}`,
    title: `Track ${id}`,
    source: "playlist",
    lastSeen,
    downloadable: true,
    ...(folder
      ? { playlistId: folder, playlistTitle: "My Mix", playlistThumbnailUrl: FOLDER_COVER }
      : { pageUrl: "https://example.com/watch" }),
  };
}

const header = (rows: MediaRow[]) => rows.filter((row) => row.kind === "playlist");

beforeEach(() => {
  currentVideos.value = [];
  videoFilter.value = { ...DEFAULT_FILTER };
  sizeThreshold.value = null;
  setScanStatus("ready");
  expandedPlaylists.value = new Set();
  selection.value = new Set();
});

afterEach(() => {
  cleanup();
});

describe("mediaRows: a playlist collapses into one folder", () => {
  it("turns forty rows into one header, and the header carries the cover and the count", () => {
    // This is the feature: a pasted playlist used to be 100 rows with no indication they
    // belonged together.
    currentVideos.value = Array.from({ length: 40 }, (_v, i) => song(`t${i}`, 40 - i));

    const rows = mediaRows.value;
    const folders = header(rows);

    expect(rows).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id: FOLDER, title: "My Mix", thumbnailUrl: FOLDER_COVER, count: 40 });
    // Collapsed means collapsed: the header alone, no children on screen.
    expect((folders[0] as PlaylistGroup).children).toHaveLength(40);
  });

  it("reveals the songs when it is expanded, and hides them again when it closes", () => {
    currentVideos.value = [song("a", 3), song("b", 2), song("c", 1)];
    expect(mediaRows.value).toHaveLength(1);

    togglePlaylist(FOLDER);
    expect(isPlaylistExpanded(FOLDER)).toBe(true);
    expect(mediaRows.value.map((row) => (row.kind === "video" ? row.video.id : "folder"))).toEqual([
      "folder",
      "a",
      "b",
      "c",
    ]);

    togglePlaylist(FOLDER);
    expect(mediaRows.value).toHaveLength(1);
  });

  it("keeps a bare candidate in place, and splits a playlist that a page row interrupts", () => {
    // Consecutive runs, not one folder per playlist id: `a` and `b` are the same playlist
    // but the page candidate sits between them, so they are two runs and therefore two
    // folders. Bucketing by id instead would silently merge rows the user cannot see are
    // adjacent any more.
    currentVideos.value = [song("a", 4), song("page", 3, null), song("b", 2)];

    expect(mediaRows.value.map((row) => (row.kind === "video" ? row.video.id : "folder"))).toEqual([
      "folder",
      "page",
      "folder",
    ]);

    togglePlaylist(FOLDER);
    expect(mediaRows.value.map((row) => (row.kind === "video" ? row.video.id : "folder"))).toEqual([
      "folder",
      "a",
      "page",
      "folder",
      "b",
    ]);
  });

  it("keeps search operating on the songs, so one track is findable inside a folder", () => {
    // The point of not touching `displayedVideos`: the filter still sees songs, and the
    // one match is still reachable — it is only its *rendering* that is a folder.
    currentVideos.value = [song("a", 3), song("needle", 2), song("c", 1)];
    videoFilter.value = { ...DEFAULT_FILTER, query: "needle" };

    expect(displayedVideos.value.map((video) => video.id)).toEqual(["needle"]);

    togglePlaylist(FOLDER);
    expect(mediaRows.value.map((row) => (row.kind === "video" ? row.video.id : "folder"))).toEqual([
      "folder",
      "needle",
    ]);
  });

  it("starts collapsed and forgets nothing that was not asked for", () => {
    currentVideos.value = [song("a", 1)];
    expect(isPlaylistExpanded(FOLDER)).toBe(false);
    expect(mediaRows.value).toHaveLength(1);
  });
});

describe("selecting a folder's tracks", () => {
  beforeEach(() => {
    currentVideos.value = [song("a", 3), song("b", 2), song("c", 1)];
  });

  it("selects and clears every child, and reads indeterminate in between", () => {
    const folder = header(mediaRows.value)[0] as PlaylistGroup;

    setPlaylistChildrenSelected(folder.children, true);
    expect([...selection.value]).toEqual(["a", "b", "c"]);
    expect(playlistSelectionState(folder.children)).toBe("all");

    // The middle state is the reason the box is three-state: two of three is neither
    // "select this" nor "done".
    selection.value = new Set(["a", "b"]);
    expect(playlistSelectionState(folder.children)).toBe("some");

    setPlaylistChildrenSelected(folder.children, false);
    expect(selection.value.size).toBe(0);
    expect(playlistSelectionState(folder.children)).toBe("none");
  });

  it("clears the folder without clearing a page candidate selected beside it", () => {
    // "Clear this folder" is a question about the folder. Replacing the whole set would
    // silently forgive an unrelated selection the user cannot see any more.
    const folder = header(mediaRows.value)[0] as PlaylistGroup;
    selection.value = new Set(["a", "b", "page"]);

    setPlaylistChildrenSelected(folder.children, false);

    expect([...selection.value]).toEqual(["page"]);
  });

  it("never claims an all-selected folder with nothing in it", () => {
    expect(playlistSelectionState([])).toBe("none");
  });
});

describe("a YouTube playlist paste reaches the folder intact", () => {
  /**
   * The reported bug, end to end.
   *
   * A YouTube Music playlist enumerates one `watch?v=` entry per track, all stamped with
   * the same `playlistId` and the playlist URL as `pageUrl`. `getVisibleVideosForTab`'s
   * grouping read that as "same page, same stem (`watch`)" and handed the popup ONE row
   * with 61 variants — so the folder was captioned "1 track" while the paste had selected
   * 61 ids, and the 60 tracks with no row could be neither seen nor deselected. Only the
   * *background* half was broken; the popup layer is fed `currentVideos` directly here so
   * this suite covers the seam between them.
   */
  function paste(playlist: string, count: number) {
    return Array.from({ length: count }, (_value, index) => ({
      id: `h${index}`,
      url: `https://www.youtube.com/watch?v=v${index}`,
      title: `Track ${index}`,
      pageUrl: playlist,
      source: "playlist",
      format: "YOUTUBE",
      playlistId: playlist,
      playlistTitle: "High School Radio",
      playlistThumbnailUrl: "",
      downloadable: true,
      duration: 200,
      // Newest first, the order the enumeration added them in.
      lastSeen: count - index,
    }));
  }

  it("folds sixty-one enumerated tracks into one folder of sixty-one togglable rows", () => {
    const playlist = "https://music.youtube.com/playlist?list=PLY5CT0TRwHPt";
    const enumerated = paste(playlist, 61);

    // What the background's `getVisibleVideosForTab` sends the popup.
    currentVideos.value = groupUniqueFullVideos(enumerated) as unknown as VideoCandidate[];

    // One folder, captioned with the track count rather than 1.
    expect(mediaRows.value).toHaveLength(1);
    const folder = header(mediaRows.value)[0] as PlaylistGroup;
    expect(folder).toMatchObject({ kind: "playlist", count: 61 });

    // Every track is reachable once it is open — the 61 rows the paste selected.
    togglePlaylist(playlist);
    expect(mediaRows.value).toHaveLength(62);

    // And the header's box answers for all of them: all selected, then none.
    selection.value = new Set(enumerated.map((entry) => entry.id));
    expect(playlistSelectionState(folder.children)).toBe("all");
    setPlaylistChildrenSelected(folder.children, false);
    expect(selection.value.size).toBe(0);
  });
});

describe("the folder row", () => {
  function header_(): HTMLElement {
    currentVideos.value = [song("a", 3), song("b", 2)];
    const folder = header(mediaRows.value)[0] as PlaylistGroup;
    return render(h(PlaylistRow, { row: folder, active: false, onToggle: () => togglePlaylist(folder.id) }))
      .container as HTMLElement;
  }

  it("shows the cover, the name and the count", () => {
    const host = header_();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(FOLDER_COVER);
    expect(host.textContent).toContain("My Mix");
    expect(host.textContent).toContain("2 tracks");
  });

  it("reports itself collapsed and opens on a click anywhere in the row", async () => {
    const host = header_();
    const row = host.querySelector("li");
    expect(row?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => row?.click());

    expect(isPlaylistExpanded(FOLDER)).toBe(true);
  });

  it("selects every track from its checkbox without opening the folder", async () => {
    // The two are different questions, and a checkbox click that also unfolded the folder
    // would be an action the user could not undo from the same control.
    const host = header_();
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;

    await act(async () => box.click());

    expect([...selection.value]).toEqual(["a", "b"]);
    expect(isPlaylistExpanded(FOLDER)).toBe(false);
  });

  it("shows a partially selected folder as indeterminate", async () => {
    selection.value = new Set(["a"]);
    const host = header_();
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement;

    await act(async () => {});

    // `indeterminate` is a DOM property with no attribute — the same reason `Checkbox`
    // sets it in an effect.
    expect(box.indeterminate).toBe(true);
    expect(host.querySelector("li")?.getAttribute("aria-selected")).toBe("false");
  });
});
