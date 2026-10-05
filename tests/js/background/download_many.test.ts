import { describe, expect, it, vi } from "vitest";

// A macrotask, not a microtask: releasing the first 3 admits the next rows through several
// awaits (the `waiting` resume, then `start`), and a fixed microtask count would race that.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
 * The 3-at-a-time gate.
 *
 * The fake below is modelled on the REAL `startNativeDownloadFromVideo` contract after
 * B1: it returns the moment the native port is open, and the download runs on a detached
 * `port.onMessage` listener, reaching settlement later through `settled`. An older fake
 * that resolved on a manually-pumped promise modelled a download-duration promise the real
 * starter never produces — it proved the arithmetic while gating nothing.
 */
describe("downloadMany queue", () => {
  /** One native port held open, exactly like the real one until a terminal message. */
  function openPorts() {
    const open: Array<() => void> = [];
    return {
      open,
      settle(id: string): void {
        const index = open.findIndex((fn) => (fn as { id?: string }).id === id);
        if (index >= 0) {
          open.splice(index, 1)[0]();
        }
      },
      start: async (_tab: number, id: string, _format: string, jobId: string) => {
        let release = (): void => {};
        const settled = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entry = Object.assign(release, { id });
        open.push(entry);
        // The real starter's return value: a job id, nothing more.
        return { jobId: jobId || `job_${id}`, settled };
      },
    };
  }

  // A macrotask, not a microtask: releasing the first 3 admits `d` and `e` through
  // several awaits (the `waiting` resume, then `start`), and a fixed microtask count
  // would race that.

  it("holds its slot until the download SETTLES, not until it starts", async () => {
    let active = 0;
    let peak = 0;
    const ports = openPorts();
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const queue = createBoundedQueue(3, (async (tab: number | undefined, id: string, format: string, jobId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await ports.start(tab as number, id, format, jobId);
      } finally {
        // `start` has returned, so the starter's own bookkeeping is done — what is still
        // outstanding is the transfer, and that is what the slot must wait for.
        active -= 1;
      }
    }) as never);

    const ids = ["a", "b", "c", "d", "e"];
    const pending = ids.map((id) => queue.add(7, id, "best", `pre_${id}`));
    await flush();

    // All five starters have RETURNED by now — the gate still admits no more than three,
    // because the returned `settled` promise has not resolved for any of them.
    expect(ports.open.length).toBe(3);

    // Settle the open ports in waves; a single pass would hang on the ones it admits.
    while (ports.open.length) {
      ports.open.splice(0).forEach((fn) => fn());
      await flush();
    }

    const slots = await Promise.all(pending);
    expect(slots.map((slot) => slot.jobId)).toEqual(ids.map((id) => `pre_${id}`));
    expect(peak).toBe(3);
  });

  it("admits every item of a burst larger than the limit exactly once", async () => {
    const started: string[] = [];
    const ports = openPorts();
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const queue = createBoundedQueue(3, (async (
      _tab: number | undefined,
      id: string,
      _format: string,
      jobId: string,
    ) => {
      started.push(id);
      return ports.start(7, id, "best", jobId);
    }) as never);

    const ids = Array.from({ length: 25 }, (_value, index) => `v${index}`);
    const pending = ids.map((id) => queue.add(7, id, "best", `job_${id}`));
    await flush();
    expect(started).toHaveLength(3);

    let guard = 0;
    while (ports.open.length && guard++ < 60) {
      ports.open.splice(0).forEach((fn) => fn());
      await flush();
    }

    await Promise.all(pending);
    expect(started.sort()).toEqual([...ids].sort());
    expect(new Set(started).size).toBe(ids.length);
  });

  it("does not deadlock when a starter settles synchronously", async () => {
    const started: string[] = [];
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const queue = createBoundedQueue(3, (async (
      _tab: number | undefined,
      id: string,
      _format: string,
      jobId: string,
    ) => {
      started.push(id);
      // e.g. the "duplicate blocked" path, which opens nothing at all.
      return { jobId: jobId || `job_${id}`, settled: Promise.resolve() };
    }) as never);

    const slots = await Promise.all(["a", "b", "c", "d", "e"].map((id) => queue.add(7, id, "best", `job_${id}`)));

    expect(started).toHaveLength(5);
    expect(slots).toHaveLength(5);
  });

  it("one item failing does not cancel its siblings", async () => {
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const fakeStart = async (_tab: number, id: string, _format: string, jobId: string) => {
      if (id === "bad") {
        throw new Error("nope");
      }
      return { jobId: jobId || `job_${id}`, settled: Promise.resolve() };
    };
    const queue = createBoundedQueue(3, fakeStart as never);
    const results = await Promise.allSettled(
      ["ok1", "bad", "ok2", "ok3", "ok4"].map((id) => queue.add(7, id, "best", `job_${id}`)),
    );
    // Four siblings, not two: the rejected item must give its slot back, or everything
    // queued behind it waits for a settlement that never comes.
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  });
});

/**
 * The gate as wired, end to end: `downloadMany` → `createBoundedQueue` →
 * `startNativeDownloadFromVideo`'s port. The port fake is the real contract — it accepts
 * the request and stays silent until the test delivers a terminal message, which is
 * exactly the window in which the old gate had already let the whole playlist through.
 */
describe("downloadMany", () => {
  interface FakePort {
    jobId: string;
    emit: (message: Record<string, unknown>) => void;
  }

  function fakeDeps(videoCount: number) {
    const jobs: Record<string, Record<string, unknown>> = {};
    const openPorts: FakePort[] = [];

    const deps = {
      api: { runtime: { connectNative: (): unknown => null, lastError: null } },
      callTabsQuery: async () => [{ url: "https://example.com/watch" }],
      ensureStateLoaded: async () => {},
      downloadPortsById: {} as Record<string, unknown>,
      getSettings: () => ({}),
      getDownloadsById: () => jobs,
      nativeRequestHeadersForVideo: async () => [],
      normalizeUrl: (url: string) => url,
      userAgent: () => "UA",
      detectFormat: () => "MP4",
      titleFromUrl: () => "untitled",
      resetDownloadProgressDetails: () => ({}),
      artifactPatchFromMessage: () => ({}),
      isRetryableSourceError: () => false,
      userFriendlyDownloadError: (error: unknown) => String(error),
      variantsForVideo: () => [],
      findVariant: (video: Record<string, unknown>) => video,
      blockingDownloadStatuses: new Set(["connecting", "running"]),
      updateDownload: (jobId: string, patch: Record<string, unknown>) => {
        jobs[jobId] = { ...(jobs[jobId] || { id: jobId }), ...patch };
      },
      getTabVideos: async () =>
        Array.from({ length: videoCount }, (_value, index) => ({
          id: `v${index}`,
          url: `https://example.com/v${index}.mp4`,
          title: `Video ${index}`,
          format: "MP4",
          pageUrl: "https://example.com/watch",
          downloadable: true,
        })),
    };

    deps.api.runtime.connectNative = () => {
      let listener: (message: Record<string, unknown>) => void = () => {};
      const disconnectListeners: Array<() => void> = [];
      const handle = {
        jobId: "",
        emit(message: Record<string, unknown>) {
          listener(message);
        },
      };
      openPorts.push(handle);
      return {
        postMessage(message: Record<string, unknown>) {
          handle.jobId = String(message.id || "");
        },
        disconnect() {},
        onMessage: {
          addListener(fn: (message: Record<string, unknown>) => void) {
            listener = fn;
          },
        },
        onDisconnect: {
          addListener(fn: () => void) {
            disconnectListeners.push(fn);
          },
        },
      };
    };

    return { deps, jobs, openPorts };
  }

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
    // looking stalled on the 97 items the gate is holding.
    expect(Object.values(jobs).map((job) => job.status)).toEqual(Array(10).fill("queued"));
    expect(Object.values(jobs).map((job) => job.message)[3]).toBe("Queued #4 of 10.");

    const settle = (port: FakePort): void => port.emit({ type: "done", id: port.jobId, filepath: "C:/x.mp4" });
    // 10 rows, 3 at a time: 3 waves of 3 and a tail of 1.
    for (let wave = 0; wave < 4; wave += 1) {
      openPorts.splice(0).forEach(settle);
      await flush();
      expect(openPorts.length).toBe(Math.max(0, Math.min(3, 10 - (wave + 1) * 3)));
    }
    expect(openPorts).toHaveLength(0);
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
});
