/**
 * Artwork carried from the host's playlist expansion into the detected row
 * (`thumbnail-spec.md` §3, §7.1).
 *
 * The host already resolves per-item cover art, and it was dropped on the floor here:
 * every playlist row then fell back to `deriveSiteThumbnail(pageUrl)` — the *playlist*
 * page, which is not per-track — so a Spotify playlist rendered N rows of no art and
 * blank history rows.
 *
 * The same expansion also stamps the three `playlist*` fields, which are the popup's
 * folder key (`popup/state/playlists.ts`) and nothing else on this side.
 */
import { describe, expect, it, vi } from "vitest";

import { enumeratePlaylistVideos } from "../../../src/background/playlist_helpers.js";

const COVER = "https://i.scdn.co/image/ab67616d00001e02abcdef";
const FOLDER_COVER = "https://i.scdn.co/image/ab67616d0000b273folder";
const PAGE = "https://open.spotify.com/playlist/x";

function fakeCtx(reply: Record<string, unknown>) {
  const added: Array<Record<string, unknown>> = [];
  return {
    added,
    ctx: {
      addDetectedVideo: vi.fn(async (_tab: number, video: unknown) => {
        added.push(video as Record<string, unknown>);
        return { id: `vid_${added.length}` };
      }),
      nativeRequest: vi.fn(async () => reply),
    },
  };
}

describe("enumeratePlaylistVideos artwork", () => {
  it("passes the host's thumbnailUrl and ladder to every row", async () => {
    const { ctx, added } = fakeCtx({
      items: [
        { title: "Song A", url: "https://open.spotify.com/track/1", thumbnailUrl: COVER, thumbnailCandidates: [COVER] },
        { title: "Song B", url: "https://open.spotify.com/track/2", thumbnailUrl: COVER, thumbnailCandidates: [COVER] },
      ],
      playlistTitle: "My Mix",
      totalItems: 2,
    });

    await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    expect(added).toHaveLength(2);
    for (const row of added) {
      expect(row.thumbnailUrl).toBe(COVER);
      expect(row.thumbnailCandidates).toEqual([COVER]);
    }
  });

  it("leaves the fields absent when the host supplied no art", async () => {
    // A YouTube playlist item has no native art; the popup's site-derived ladder is the
    // fallback, and it needs these to be missing rather than empty.
    const { ctx, added } = fakeCtx({
      items: [{ title: "Clip", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }],
      playlistTitle: "List",
      totalItems: 1,
    });

    await enumeratePlaylistVideos(ctx as never, 7, "https://www.youtube.com/playlist?list=x");

    expect(added[0].thumbnailUrl).toBeUndefined();
    expect(added[0].thumbnailCandidates).toBeUndefined();
  });

  it("drops a data: URL rather than shipping it into history", async () => {
    // The synced-history budget is ~100KB; one base64 JPEG per row would eat it. See the
    // note in `background/download/native.ts`.
    const { ctx, added } = fakeCtx({
      items: [{ title: "Song A", url: "https://open.spotify.com/track/1", thumbnailUrl: "data:image/jpeg;base64,AAA" }],
      playlistTitle: "My Mix",
    });

    await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    expect(added[0].thumbnailUrl).toBeUndefined();
  });
});

describe("enumeratePlaylistVideos folder identity", () => {
  it("stamps every row with the playlist it came from, so the popup can fold them", async () => {
    // The whole feature hangs on this: the popup groups *consecutive* rows sharing a
    // `playlistId` into one collapsible folder, and a stamp that differed per row would
    // render the same playlist as N folders.
    const { ctx, added } = fakeCtx({
      items: [
        { title: "Song A", url: "https://open.spotify.com/track/1" },
        { title: "Song B", url: "https://open.spotify.com/track/2" },
      ],
      playlistTitle: "My Mix",
      playlistThumbnailUrl: FOLDER_COVER,
    });

    const reply = await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    for (const row of added) {
      expect(row.playlistId).toBe(PAGE);
      expect(row.playlistTitle).toBe("My Mix");
      expect(row.playlistThumbnailUrl).toBe(FOLDER_COVER);
    }
    // The same three ride back on the reply, next to the ids the paste box selects.
    expect(reply).toMatchObject({ playlistId: PAGE, playlistTitle: "My Mix", playlistThumbnailUrl: FOLDER_COVER });
  });

  it("never writes a playlist id into groupId, which the download path reads", async () => {
    // `download/native.ts` sends `videoId: video.groupId || video.id` and
    // `variantId: video.groupId ? video.id : ""`. A playlist id there tells the helper to
    // download a variant of a video that does not exist. This is the regression guard for
    // the stale comment that claimed enumeration set it.
    const { ctx, added } = fakeCtx({ items: [{ title: "Song A", url: "https://open.spotify.com/track/1" }] });

    await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    expect(added[0].groupId).toBeUndefined();
    expect(added[0].playlistId).toBe(PAGE);
  });

  it("drops a data: folder cover rather than shipping it onto every row", async () => {
    // Same reason as the per-item filter above: the cover rides along on every row and
    // into synced history, whose whole budget is ~100KB.
    const { ctx, added } = fakeCtx({
      items: [{ title: "Song A", url: "https://open.spotify.com/track/1" }],
      playlistTitle: "My Mix",
      playlistThumbnailUrl: "data:image/jpeg;base64,AAA",
    });

    const reply = await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    expect(added[0].playlistThumbnailUrl).toBe("");
    expect(reply.playlistThumbnailUrl).toBe("");
  });

  it("names an untitled playlist once, on every row", async () => {
    const { ctx, added } = fakeCtx({ items: [{ title: "Song A", url: "https://open.spotify.com/track/1" }] });

    const reply = await enumeratePlaylistVideos(ctx as never, 7, PAGE);

    expect(reply.playlistTitle).toBe("Playlist");
    expect(added[0].playlistTitle).toBe("Playlist");
  });
});
