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

describe("downloadMany queue", () => {
  it("starts at most 3 at once and continues after one finishes", async () => {
    let active = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    const fakeStart = async (_tab: number, id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => finishers.push(resolve));
      active -= 1;
      return { jobId: `job_${id}` };
    };
    // A macrotask, not a microtask: releasing the first 3 admits `d` and `e` through
    // several awaits (the `waiting` resume, then `start`), and a fixed microtask count
    // would race that.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const queue = createBoundedQueue(3, fakeStart as never);
    const pending = ["a", "b", "c", "d", "e"].map((id) => queue.add(7, id, "best"));
    await flush();
    expect(peak).toBe(3);
    // Drain in waves. One `splice` is not enough: finishing `a`/`b`/`c` is what lets `d`
    // and `e` in, and those two need releasing too — that is the "continues after one
    // finishes" half of this assertion, and a single pass would hang on them forever.
    while (finishers.length) {
      finishers.splice(0).forEach((fn) => fn());
      await flush();
    }
    const results = await Promise.all(pending);
    expect(results).toHaveLength(5);
    expect(peak).toBe(3);
  });

  it("one item failing does not cancel its siblings", async () => {
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const fakeStart = async (_tab: number, id: string) => {
      if (id === "bad") throw new Error("nope");
      return { jobId: `job_${id}` };
    };
    const queue = createBoundedQueue(3, fakeStart as never);
    const results = await Promise.allSettled(["ok1", "bad", "ok2"].map((id) => queue.add(7, id, "best")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
});
