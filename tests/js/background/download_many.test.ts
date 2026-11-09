import { describe, expect, it, vi } from "vitest";

import { fakeDeps, flush, type FakePort } from "./download_fakes.js";

/**
 * enumeratePlaylist handler contract: items become tab-scoped video rows, and the host's
 * own `isCollection` / `truncated` / `totalItems` answers reach the popup untouched.
 */
describe("enumeratePlaylistVideos", () => {
  const ITEMS = [
    { title: "Song A", url: "https://open.spotify.com/track/1" },
    { title: "Song B", url: "https://open.spotify.com/track/2" },
  ];

  function fakeCtx(reply: Record<string, unknown>) {
    const added: Array<Record<string, unknown>> = [];
    return {
      added,
      ctx: {
        senderTabId: () => 7,
        addDetectedVideo: vi.fn(async (_tab: number, v: unknown) => {
          added.push(v as Record<string, unknown>);
          return { id: `vid_${added.length}`, ...(v as object) };
        }),
        nativeRequest: vi.fn(async () => reply),
      },
    };
  }

  async function enumerate(reply: Record<string, unknown>) {
    const { ctx } = fakeCtx(reply);
    const { enumeratePlaylistVideos } = await import("../../../src/background/playlist_helpers.js");
    return { result: await enumeratePlaylistVideos(ctx as never, 7, "https://open.spotify.com/playlist/x"), ctx };
  }

  it("adds one video per item and does NOT stamp a shared groupId", async () => {
    const { ctx, result } = await enumerate({ items: ITEMS, playlistTitle: "My Mix", totalItems: 2 });

    expect(result.videoIds).toHaveLength(2);
    // One `groupId` for the whole playlist used to collapse 100 rows into one identity:
    // `download_helpers`/`download_operations` feed `video.groupId` into their dedupe
    // sets. "Download all" grouping is the selection bar's job, not this field's.
    expect(ctx.addDetectedVideo.mock.calls.map((call) => (call[1] as Record<string, unknown>).groupId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("passes the host's collection verdict through instead of inferring it", async () => {
    // One item and no playlist title is what `--flat-playlist` answers for a plain video
    // URL. Reporting `true` here is what cost a plain paste its quality sheet.
    const single = await enumerate({ items: ITEMS.slice(0, 1), playlistTitle: "", isCollection: false });
    expect(single.result.isCollection).toBe(false);

    const untitled = await enumerate({ items: ITEMS.slice(0, 1), playlistTitle: "", isCollection: true });
    expect(untitled.result.isCollection).toBe(true);
  });

  it("carries the real total and the truncation flag (spec §4)", async () => {
    const { result } = await enumerate({ items: ITEMS, playlistTitle: "My Mix", totalItems: 300, truncated: true });

    expect(result.truncated).toBe(true);
    expect(result.totalItems).toBe(300);
  });
});

/**
 * The gate itself.
 *
 * The starter below is modelled on the REAL `startNativeDownloadFromVideo` contract: it
 * returns the moment the native port is open, and the download reaches settlement later
 * through `settled`. An older fake that resolved on a manually-pumped promise modelled a
 * download-duration promise the real starter never produces — it proved the arithmetic
 * while gating nothing.
 */
describe("createDownloadQueue", () => {
  function heldStarts() {
    const open = new Map<string, () => void>();
    return {
      open,
      starter(jobId: string) {
        return async () => {
          let release = (): void => {};
          const settled = new Promise<void>((resolve) => {
            release = resolve;
          });
          open.set(jobId, release);
          return { jobId, settled };
        };
      },
      settleAll() {
        const releases = [...open.values()];
        open.clear();
        releases.forEach((fn) => fn());
      },
    };
  }

  it("holds its slot until the download SETTLES, not until it starts", async () => {
    const held = heldStarts();
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(() => 3);

    const ids = ["a", "b", "c", "d", "e"];
    const tickets = ids.map((id) => queue.add(id, held.starter(id)));
    await flush();

    // All three starters have RETURNED by now — the gate still admits no more, because
    // the returned `settled` promise has not resolved for any of them.
    expect(held.open.size).toBe(3);
    expect(tickets.map((ticket) => ticket.queued)).toEqual([false, false, false, true, true]);
    expect(tickets.map((ticket) => ticket.ahead)).toEqual([0, 0, 0, 0, 1]);

    let guard = 0;
    while (held.open.size && guard++ < 10) {
      held.settleAll();
      await flush();
    }
    const slots = await Promise.all(tickets.map((ticket) => ticket.slot));
    expect(slots.map((slot) => slot?.jobId)).toEqual(ids);
  });

  it("admits every item of a burst larger than the limit exactly once", async () => {
    const started: string[] = [];
    const held = heldStarts();
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(() => 3);

    const ids = Array.from({ length: 25 }, (_value, index) => `v${index}`);
    ids.forEach((id) =>
      queue.add(id, () => {
        started.push(id);
        return held.starter(id)();
      }),
    );
    await flush();
    expect(started).toHaveLength(3);

    let guard = 0;
    while (held.open.size && guard++ < 60) {
      held.settleAll();
      await flush();
    }
    expect(started).toEqual(ids);
  });

  it("reads the limit live: a raised limit admits more on the next admission, a lowered one stops nothing", async () => {
    let limit = 1;
    const held = heldStarts();
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(() => limit);

    queue.add("a", held.starter("a"));
    queue.add("b", held.starter("b"));
    await flush();
    expect([...held.open.keys()]).toEqual(["a"]);

    // Raised: the next admission (here, a new add) fills every free slot, line first.
    limit = 3;
    queue.add("c", held.starter("c"));
    await flush();
    expect([...held.open.keys()]).toEqual(["a", "b", "c"]);

    // Lowered: nothing running is touched; the next item just waits for enough to settle.
    limit = 1;
    const late = queue.add("d", held.starter("d"));
    expect(late.queued).toBe(true);
    held.open.get("a")?.();
    held.open.delete("a");
    await flush();
    expect(held.open.has("d")).toBe(false);
  });

  it("withdraws a waiting item: it never starts, and its ticket resolves null", async () => {
    const held = heldStarts();
    const changes: string[][] = [];
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(
      () => 1,
      (ids) => changes.push([...ids]),
    );

    queue.add("a", held.starter("a"));
    const b = queue.add("b", held.starter("b"));
    queue.add("c", held.starter("c"));

    expect(queue.withdraw("b")).toBe(true);
    expect(queue.withdraw("b")).toBe(false);
    expect(await b.slot).toBeNull();
    expect(changes.at(-1)).toEqual(["c"]);

    held.settleAll();
    await flush();
    expect([...held.open.keys()]).toEqual(["c"]);
  });

  it("one item failing does not cancel its siblings", async () => {
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(() => 3);
    const tickets = ["ok1", "bad", "ok2", "ok3", "ok4"].map((id) =>
      queue.add(id, async () => {
        if (id === "bad") {
          throw new Error("nope");
        }
        return { jobId: id, settled: Promise.resolve() };
      }),
    );
    const results = await Promise.allSettled(tickets.map((ticket) => ticket.slot));
    // Four siblings, not two: the rejected item must give its slot back, or everything
    // queued behind it waits for a settlement that never comes.
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  });

  it("counts an occupied slot until it is released, once", async () => {
    const held = heldStarts();
    const { createDownloadQueue } = await import("../../../src/background/download/queue.js");
    const queue = createDownloadQueue(() => 1);

    const release = queue.occupy();
    expect(queue.add("a", held.starter("a")).queued).toBe(true);
    release();
    release();
    await flush();
    expect([...held.open.keys()]).toEqual(["a"]);
    expect(queue.add("b", held.starter("b")).queued).toBe(true);
  });
});

/**
 * The gate as wired, end to end: `downloadMany` → the queue →
 * `startNativeDownloadFromVideo`'s port.
 */
describe("downloadMany", () => {
  it("opens three native ports for a ten-row selection and one more per settlement", async () => {
    const { deps, jobs, openPorts } = fakeDeps(10);
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    const reply = await api.downloadMany(
      7,
      Array.from({ length: 10 }, (_v, i) => `v${i}`),
    );

    // Resolves on the FIRST WAVE: `batchDownloadSelection` awaits this message before it
    // clears the selection, so a 10-row pick must not hold the popup for all 10.
    expect(reply.jobIds).toHaveLength(3);
    expect(openPorts).toHaveLength(3);
    expect(openPorts.map((port) => port.jobId)).toEqual(reply.jobIds);

    // Every row is visible before its port exists, so the tray reads "Queued" rather than
    // looking stalled on the rows the gate is holding.
    const statuses = Object.values(jobs).map((job) => job.status);
    expect(statuses.slice(0, 3)).toEqual(Array(3).fill("connecting"));
    expect(statuses.slice(3)).toEqual(Array(7).fill("queued"));
    expect(Object.values(jobs).map((job) => job.message)[3]).toBe("Waiting for a free slot.");
    expect(Object.values(jobs).map((job) => job.message)[5]).toBe("Waiting for a free slot (2 ahead).");

    const settle = (port: FakePort): void => port.emit({ type: "done", id: port.jobId, filepath: "C:/x.mp4" });
    // 10 rows, 3 at a time: 3 waves of 3 and a tail of 1.
    for (let wave = 0; wave < 4; wave += 1) {
      openPorts.splice(0).forEach(settle);
      await flush();
      expect(openPorts.length).toBe(Math.max(0, Math.min(3, 10 - (wave + 1) * 3)));
    }
    expect(openPorts).toHaveLength(0);
    // The line renumbers as it moves: the last row was 6 ahead and is now running.
    expect(Object.values(jobs).every((job) => job.status === "done")).toBe(true);
  });

  it("releases the slot on a terminal error too, so a failure cannot stall the batch", async () => {
    const { deps, openPorts } = fakeDeps(6);
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    await api.downloadMany(7, ["v0", "v1", "v2", "v3", "v4", "v5"]);
    expect(openPorts).toHaveLength(3);

    const failing = openPorts.splice(0, 1)[0];
    failing.emit({ type: "error", id: failing.jobId, error: "HTTP Error 403" });
    await flush();

    // The failed row is gone and its replacement is admitted — which is the whole point of
    // releasing on settlement rather than on a `done`-only path.
    expect(openPorts).toHaveLength(3);
    expect(openPorts.map((port) => port.jobId)).not.toContain(failing.jobId);
  });

  it("starts a real download per item instead of matching its own queued placeholder", async () => {
    const { deps, jobs, openPorts } = fakeDeps(6);
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    await api.downloadMany(7, ["v0", "v1", "v2", "v3", "v4", "v5"]);

    // `downloadMany` writes every placeholder as `status: "queued"` BEFORE the gate admits
    // anything, and "queued" is a blocking status — so the duplicate check matched each row
    // against itself, returned `{ existing: true }` for all six, opened no port at all, and
    // the tray sat on six permanent "Queued" rows. Three real ports is the whole difference.
    expect(openPorts).toHaveLength(3);
    const held = Object.values(jobs).filter((job) => job.status === "queued");
    expect(held.map((job) => job.message)).toEqual([
      "Waiting for a free slot.",
      "Waiting for a free slot (1 ahead).",
      "Waiting for a free slot (2 ahead).",
    ]);
  });

  it("still reuses a SEPARATE in-flight job for the same video", async () => {
    const { deps, openPorts } = fakeDeps(2);
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    // A real duplicate: someone already started v0 and it is still running.
    deps.updateDownload("job_other", {
      id: "job_other",
      videoId: "v0",
      url: "https://example.com/v0.mp4",
      status: "running",
    });

    const reply = await api.downloadMany(7, ["v0", "v1"]);

    // Ignoring one's OWN placeholder must not weaken this: only v1 opens a port, and the
    // reused job is what comes back for v0.
    expect(reply.jobIds[0]).toBe("job_other");
    expect(openPorts).toHaveLength(1);
    expect(openPorts[0].jobId).not.toBe("job_other");
  });

  it("leaves no Queued placeholder behind when the whole first wave cannot start", async () => {
    const { deps, jobs } = fakeDeps(4);
    // Fails inside `startNativeDownloadFromVideo`, i.e. AFTER the placeholder is written.
    deps.callTabsQuery = async (): Promise<never> => {
      throw new Error("No active tab");
    };
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    await expect(api.downloadMany(7, ["v0", "v1", "v2", "v3"])).rejects.toThrow("None of those downloads could start.");
    await flush();

    // A queued placeholder here would never be promoted, so it is a row the user could
    // only ever cancel by hand: the batch already reported failure.
    expect(Object.values(jobs).filter((job) => job.status === "queued")).toEqual([]);
    expect(Object.values(jobs).every((job) => job.status === "error")).toBe(true);
  });

  it("answers with the waiting ids when every slot is already busy elsewhere", async () => {
    const { deps, jobs, openPorts } = fakeDeps(5, { maxConcurrentDownloads: 1 });
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(deps as never);

    await api.startNativeDownload(7, "v0");
    expect(openPorts).toHaveLength(1);

    // The popup must not hang until v0 finishes: the batch is queued, and says so.
    const reply = await api.downloadMany(7, ["v1", "v2"]);
    expect(reply.jobIds).toHaveLength(2);
    expect(reply.jobIds.map((jobId) => jobs[jobId].status)).toEqual(["queued", "queued"]);
    expect(openPorts).toHaveLength(1);
  });
});
