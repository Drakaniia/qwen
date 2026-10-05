import { describe, expect, it, vi } from "vitest";

// enumeratePlaylist handler contract: items become tab-scoped videos sharing one groupId.
describe("enumeratePlaylist handler", () => {
  it("adds one video per item with a shared playlist groupId", async () => {
    const added: unknown[] = [];
    const fakeCtx = {
      senderTabId: () => 7,
      addDetectedVideo: vi.fn(async (_tab: number, v: unknown) => {
        added.push(v);
        return { id: `vid_${added.length}`, ...(v as object) };
      }),
      nativeRequest: vi.fn(async () => ({
        items: [
          { title: "Song A", url: "https://open.spotify.com/track/1" },
          { title: "Song B", url: "https://open.spotify.com/track/2" },
        ],
        playlistTitle: "My Mix",
        totalItems: 2,
      })),
    };
    const { enumeratePlaylistVideos } = await import("../../../src/background/playlist_helpers.js");
    const result = await enumeratePlaylistVideos(fakeCtx as never, 7, "https://open.spotify.com/playlist/x");
    expect(result.videoIds).toHaveLength(2);
    const groups = new Set(added.map((v) => (v as { groupId: string }).groupId));
    expect(groups.size).toBe(1);
  });
});
