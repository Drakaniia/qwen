/**
 * Every way a download starts, stops and survives a restart, through the real
 * `download/index.ts` orchestrator and the fake port in `download_fakes.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeDeps, flush } from "./download_fakes.js";

const INTERRUPTED = "Interrupted — press Resume to continue.";

async function orchestrator(videoCount: number, settings: Record<string, unknown> = {}) {
  const fake = fakeDeps(videoCount, settings);
  const { create } = await import("../../../src/background/download/index.js");
  return { ...fake, api: create(fake.deps as never) };
}

// vitest-chrome-mv3 ships no `downloads` namespace. `browserApi` reads `chrome.downloads`
// at call time, so a plain object installed per test is what it talks to.
beforeEach(() => {
  Object.assign(chrome, {
    downloads: {
      search: (_query: unknown, cb: (items: unknown[]) => void) => cb([]),
      pause: (_id: number, cb: () => void) => cb(),
      resume: (_id: number, cb: () => void) => cb(),
      cancel: (_id: number, cb: () => void) => cb(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(chrome.runtime, "lastError");
  Reflect.deleteProperty(chrome, "downloads");
});

describe("one gate for every start (maxConcurrentDownloads)", () => {
  it("queues a single click past the limit and starts it when a slot frees", async () => {
    const { api, jobs, openPorts } = await orchestrator(3, { maxConcurrentDownloads: 1 });

    const first = await api.startNativeDownload(7, "v0");
    // Answers at once with a queued row — the popup must not wait for v0 to finish.
    const second = await api.startNativeDownload(7, "v1");
    expect(openPorts).toHaveLength(1);
    expect(jobs[second.jobId]).toMatchObject({ status: "queued", message: "Waiting for a free slot.", videoId: "v1" });

    openPorts[0].emit({ type: "done", id: first.jobId, filepath: "C:/v0.mp4" });
    await flush();
    expect(openPorts).toHaveLength(2);
    expect(openPorts[1].jobId).toBe(second.jobId);
  });

  it("puts a retry through the gate too", async () => {
    const { api, deps, jobs, openPorts } = await orchestrator(2, { maxConcurrentDownloads: 1 });
    await api.startNativeDownload(7, "v0");
    deps.updateDownload("job_failed", {
      id: "job_failed",
      tabId: 7,
      url: "https://example.com/v1.mp4",
      status: "error",
    });

    // A retry is a new job (its own id), and it waits its turn like any other start.
    const retried = await api.retryDownload(7, "job_failed");

    expect(openPorts).toHaveLength(1);
    expect(jobs[retried.jobId]).toMatchObject({ status: "queued", url: "https://example.com/v1.mp4" });
  });

  it("clamps garbage and out-of-range limits instead of trusting them", async () => {
    const { api, openPorts } = await orchestrator(8, { maxConcurrentDownloads: 99 });
    for (let index = 0; index < 8; index += 1) {
      await api.startNativeDownload(7, `v${index}`);
    }
    // CONCURRENCY_MAX is 6.
    expect(openPorts).toHaveLength(6);
  });
});

describe("a queued row", () => {
  it("is never started after it was cancelled", async () => {
    const { api, jobs, openPorts } = await orchestrator(2, { maxConcurrentDownloads: 1 });
    const first = await api.startNativeDownload(7, "v0");
    const queued = await api.startNativeDownload(7, "v1");

    await api.cancelDownload(7, queued.jobId);
    expect(jobs[queued.jobId].status).toBe("canceled");

    openPorts[0].emit({ type: "done", id: first.jobId });
    await flush();
    // Before the fix the gate started it anyway and overwrote the canceled record.
    expect(openPorts).toHaveLength(1);
    expect(jobs[queued.jobId].status).toBe("canceled");
  });

  it("pauses out of the line and goes back into it on Resume", async () => {
    const { api, jobs, openPorts } = await orchestrator(2, { maxConcurrentDownloads: 1 });
    const first = await api.startNativeDownload(7, "v0");
    const queued = await api.startNativeDownload(7, "v1");

    await api.controlActiveDownload(queued.jobId, "pause");
    expect(jobs[queued.jobId]).toMatchObject({ status: "paused" });
    openPorts[0].emit({ type: "done", id: first.jobId });
    await flush();
    expect(openPorts).toHaveLength(1);

    await api.resumeDownload(7, queued.jobId);
    expect(openPorts).toHaveLength(2);
    expect(openPorts[1].jobId).toBe(queued.jobId);
  });
});

describe("the browser download path", () => {
  async function startBrowserJob(settings: Record<string, unknown> = {}) {
    const fake = await orchestrator(2, settings);
    const pending = fake.api.startNativeDownload(7, "v0", "best", "", "browser");
    await flush();
    fake.browserDownloads[0].reply(41);
    const { jobId } = await pending;
    return { ...fake, jobId };
  }

  it("stores the chrome.downloads id and holds its slot until the transfer completes", async () => {
    const { api, jobs, jobId, openPorts } = await startBrowserJob({ maxConcurrentDownloads: 1 });
    expect(jobs[jobId]).toMatchObject({ browserDownloadId: 41, status: "running" });

    const next = await api.startNativeDownload(7, "v1");
    expect(jobs[next.jobId].status).toBe("queued");

    await api.onBrowserDownloadChanged({
      id: 41,
      bytesReceived: { current: 50, previous: 0 },
      totalBytes: { current: 200 },
    } as never);
    expect(jobs[jobId]).toMatchObject({ percent: 25, rawDownloadedBytes: 50, rawTotalBytes: 200 });

    await api.onBrowserDownloadChanged({
      id: 41,
      state: { current: "complete" },
      filename: { current: "C:/v0.mp4" },
    } as never);
    await flush();
    expect(jobs[jobId]).toMatchObject({ status: "done", filepath: "C:/v0.mp4" });
    expect(openPorts).toHaveLength(1);
  });

  it("pauses, resumes and cancels through chrome.downloads", async () => {
    const pause = vi
      .spyOn(chrome.downloads, "pause")
      .mockImplementation(((_id: number, cb: () => void) => cb()) as never);
    const resume = vi
      .spyOn(chrome.downloads, "resume")
      .mockImplementation(((_id: number, cb: () => void) => cb()) as never);
    const cancel = vi
      .spyOn(chrome.downloads, "cancel")
      .mockImplementation(((_id: number, cb: () => void) => cb()) as never);
    const { api, jobs, jobId } = await startBrowserJob();

    await api.controlActiveDownload(jobId, "pause");
    expect(pause).toHaveBeenCalledWith(41, expect.any(Function));
    expect(jobs[jobId].status).toBe("paused");

    await api.resumeDownload(7, jobId);
    expect(resume).toHaveBeenCalledWith(41, expect.any(Function));
    expect(jobs[jobId].status).toBe("running");

    await api.cancelDownload(7, jobId);
    expect(cancel).toHaveBeenCalledWith(41, expect.any(Function));
    expect(jobs[jobId].status).toBe("canceled");

    // A completion that raced the cancel must not resurrect the row as `done`.
    await api.onBrowserDownloadChanged({ id: 41, state: { current: "complete" } } as never);
    expect(jobs[jobId].status).toBe("canceled");
  });

  it("maps an interruption to an error, and a user cancel in the browser UI to canceled", async () => {
    const { api, jobs, jobId } = await startBrowserJob();
    await api.onBrowserDownloadChanged({
      id: 41,
      state: { current: "interrupted" },
      error: { current: "NETWORK_FAILED" },
    } as never);
    expect(jobs[jobId]).toMatchObject({ status: "error", error: "Browser download interrupted: NETWORK_FAILED" });

    const other = await startBrowserJob();
    await other.api.onBrowserDownloadChanged({
      id: 41,
      state: { current: "interrupted" },
      error: { current: "USER_CANCELED" },
    } as never);
    expect(other.jobs[other.jobId].status).toBe("canceled");
  });

  it("ignores downloads that are not ours", async () => {
    const { api, jobs, jobId } = await startBrowserJob();
    await api.onBrowserDownloadChanged({ id: 999, state: { current: "complete" } } as never);
    expect(jobs[jobId].status).toBe("running");
  });
});

describe("startup reconciliation", () => {
  it("settles every job a previous worker lifetime left active", async () => {
    vi.spyOn(chrome.downloads, "search").mockImplementation(((query: { id: number }, cb: (items: unknown[]) => void) =>
      cb(
        query.id === 1
          ? [{ id: 1, state: "complete", filename: "C:/done.mp4" }]
          : query.id === 2
            ? [{ id: 2, state: "in_progress", paused: false }]
            : [],
      )) as never);
    const fake = fakeDeps(0, { maxConcurrentDownloads: 2 });
    const old = { updatedAt: 1, tabId: 7 };
    Object.assign(fake.jobs, {
      running: { ...old, id: "running", status: "running", url: "https://e.com/a.mp4" },
      pausing: { ...old, id: "pausing", status: "pausing", url: "https://e.com/b.mp4" },
      canceling: { ...old, id: "canceling", status: "canceling", url: "https://e.com/c.mp4" },
      browserDone: { ...old, id: "browserDone", status: "running", browserDownloadId: 1, backend: "browser" },
      browserLive: { ...old, id: "browserLive", status: "running", browserDownloadId: 2, backend: "browser" },
      browserGone: { ...old, id: "browserGone", status: "running", browserDownloadId: 3, backend: "browser" },
      queuedLate: { ...old, id: "queuedLate", status: "queued", url: "https://e.com/q2.mp4", createdAt: 20 },
      queuedEarly: { ...old, id: "queuedEarly", status: "queued", url: "https://e.com/q1.mp4", createdAt: 10 },
      finished: { ...old, id: "finished", status: "done" },
    });
    const { create } = await import("../../../src/background/download/index.js");
    const api = create(fake.deps as never);

    await api.reconcileInterruptedJobs();
    await flush();

    expect(fake.jobs.running).toMatchObject({ status: "paused", message: INTERRUPTED });
    expect(fake.jobs.pausing).toMatchObject({ status: "paused", message: INTERRUPTED });
    expect(fake.jobs.canceling.status).toBe("canceled");
    expect(fake.jobs.browserDone).toMatchObject({ status: "done", filepath: "C:/done.mp4" });
    expect(fake.jobs.browserLive.status).toBe("running");
    expect(fake.jobs.browserGone.status).toBe("error");
    expect(fake.jobs.finished.status).toBe("done");
    // The live browser transfer holds one of the two slots, so exactly one queued row is
    // re-admitted — the older one.
    expect(fake.openPorts.map((port) => port.jobId)).toEqual(["queuedEarly"]);
    expect(fake.jobs.queuedLate.status).toBe("queued");

    // Interrupted native jobs come back through Resume.
    await api.resumeDownload(7, "running");
    expect(fake.jobs.running.status).toBe("queued");
  });
});

describe("the native port", () => {
  it("sends title and the height cap for best, and no cap for an explicit format or audio", async () => {
    const { api, openPorts } = await orchestrator(2, { preferredMaxHeight: 720 });
    await api.startNativeDownload(7, "v0");
    await api.startNativeDownload(7, "v1", "137");
    expect(openPorts[0].posted[0]).toMatchObject({ type: "download", title: "Video 0", maxHeight: 720 });
    expect(openPorts[1].posted[0]).toMatchObject({ formatId: "137", maxHeight: 0 });

    const music = await orchestrator(1, { preferredMaxHeight: 720, musicMode: true });
    await music.api.startNativeDownload(7, "v0");
    expect(music.openPorts[0].posted[0]).toMatchObject({ maxHeight: 0 });
  });

  it("does not overwrite a fast reply with the post-send status", async () => {
    const { api, deps, jobs, openPorts } = await orchestrator(1);
    const connect = deps.api.runtime.connectNative;
    // The helper answers `started` before `postMessage` has even returned.
    deps.api.runtime.connectNative = () => {
      const port = connect() as { postMessage: (message: Record<string, unknown>) => void };
      const handle = openPorts[openPorts.length - 1];
      const post = port.postMessage;
      port.postMessage = (message) => {
        post(message);
        handle.emit({ type: "started", id: message.id, label: "yt-dlp" });
      };
      return port;
    };

    const { jobId } = await api.startNativeDownload(7, "v0");
    expect(jobs[jobId]).toMatchObject({ status: "running", message: "Trying yt-dlp…" });
  });

  it("keeps a just-sent job on connecting, not queued", async () => {
    const { api, jobs } = await orchestrator(1);
    const { jobId } = await api.startNativeDownload(7, "v0");
    expect(jobs[jobId]).toMatchObject({ status: "connecting", message: "Sent to native helper." });
  });

  it("finishes the row when the source fallback itself throws", async () => {
    const { api, deps, jobs, openPorts } = await orchestrator(1);
    deps.isRetryableSourceError = () => true;
    deps.fallbackVideoForDownload = async () => {
      throw new Error("fallback search exploded");
    };
    const { jobId } = await api.startNativeDownload(7, "v0");

    openPorts[0].emit({ type: "error", id: jobId, error: "HTTP Error 403: Forbidden" });
    await flush();
    expect(jobs[jobId]).toMatchObject({ status: "error", error: "fallback search exploded" });
  });

  it("reads a `gone` control reply as interrupted for a pause and canceled for a cancel", async () => {
    const { api, deps, jobs, openPorts } = await orchestrator(2);
    const fallback = vi.fn(async () => null);
    deps.isRetryableSourceError = () => true;
    deps.fallbackVideoForDownload = fallback;

    const paused = await api.startNativeDownload(7, "v0");
    await api.controlActiveDownload(paused.jobId, "pause");
    openPorts[0].emit({ type: "control", id: paused.jobId, status: "gone", message: "No such task." });
    expect(jobs[paused.jobId]).toMatchObject({ status: "paused", message: INTERRUPTED });
    expect(deps.downloadPortsById[paused.jobId]).toBeUndefined();

    // An older helper says it as an error; while canceling, that is not a download failure.
    const canceled = await api.startNativeDownload(7, "v1");
    await api.cancelDownload(7, canceled.jobId);
    openPorts[1].emit({ type: "error", id: canceled.jobId, error: "No active download with that id." });
    await flush();
    expect(jobs[canceled.jobId].status).toBe("canceled");
    expect(fallback).not.toHaveBeenCalled();

    // Resume relaunches the interrupted job on a fresh port.
    await api.resumeDownload(7, paused.jobId);
    expect(openPorts).toHaveLength(3);
    expect(jobs[paused.jobId]).toMatchObject({ status: "connecting" });
  });
});
