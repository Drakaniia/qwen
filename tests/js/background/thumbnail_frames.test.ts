/**
 * The H9 budget and the by-URL frame cache (`hls-thumbnail-spec.md` §5, §9).
 *
 * `thumbnail_frames.ts` is a factory precisely so these can be asserted without a service
 * worker: every collaborator is a stub, so "no host call" and "at most two in flight" are
 * observable facts rather than timing accidents. Each `create()` gets a fresh budget and a
 * fresh cache, so the tests are independent by construction rather than by tab id.
 */
import { describe, expect, it, vi } from "vitest";

import { create } from "../../../src/background/thumbnail_frames.js";
import type { NativeRequestPayload, NativeResponse, VideoRecord } from "../../../src/background/types.js";

const FRAME = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";

/** Let queued microtasks and timers drain — the grab path has several awaits per hop. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function record(id: string, url: string): VideoRecord {
  return { id, url, format: "M3U8", pageUrl: "https://site.example/watch" };
}

/** A harness with `v0`…`v{n-1}` in one tab, each on its own manifest URL. */
function harness(
  native: (payload: NativeRequestPayload, timeoutMs?: number) => Promise<NativeResponse> = async () => ({
    ok: true,
    frameUrl: "",
  }),
) {
  const records = new Map<number, VideoRecord[]>();
  const nativeRequest = vi.fn(native);
  const rememberCaptures = vi.fn();
  const notifyPopup = vi.fn();
  const frames = create({
    nativeRequest,
    notifyPopup,
    getVisibleVideosForTab: (tabId) => records.get(tabId as number) || [],
    getVideosForTab: (tabId) => records.get(tabId as number) || [],
    nativeRequestHeadersForVideo: async () => [],
    rememberCaptures,
  });
  return {
    frames,
    nativeRequest,
    rememberCaptures,
    notifyPopup,
    records,
    put(tabId: number, videos: VideoRecord[]) {
      records.set(tabId, videos);
    },
  };
}

describe("grabFrame budget", () => {
  it("spends at most six host calls per tab — the seventh returns '' without one", async () => {
    const h = harness();
    h.put(
      1,
      Array.from({ length: 7 }, (_, i) => record(`v${i}`, `https://cdn.example/${i}.m3u8`)),
    );

    for (let i = 0; i < 7; i++) {
      expect(await h.frames.grabFrame(1, `v${i}`)).toBe("");
    }
    expect(h.nativeRequest).toHaveBeenCalledTimes(6);
    // H9's 20s cap, and §4.1's fields, on every call.
    expect(h.nativeRequest.mock.calls[0][1]).toBe(20000);
    expect(h.nativeRequest.mock.calls[0][0]).toMatchObject({
      type: "thumbnailFrame",
      url: "https://cdn.example/0.m3u8",
      pageUrl: "https://site.example/watch",
      atSeconds: 1,
    });
  });

  it("counts the budget per tab, and re-arms it when a tab is cleared", async () => {
    const h = harness();
    h.put(
      1,
      Array.from({ length: 7 }, (_, i) => record(`v${i}`, `https://cdn.example/a${i}.m3u8`)),
    );
    h.put(
      2,
      Array.from({ length: 7 }, (_, i) => record(`v${i}`, `https://cdn.example/b${i}.m3u8`)),
    );

    for (let i = 0; i < 6; i++) {
      await h.frames.grabFrame(1, `v${i}`);
    }
    expect(await h.frames.grabFrame(1, "v6")).toBe("");
    // Tab 2 has spent nothing, so its first grab still runs.
    await h.frames.grabFrame(2, "v0");
    expect(h.nativeRequest).toHaveBeenCalledTimes(7);

    h.frames.clearTab(1);
    await h.frames.grabFrame(1, "v6");
    expect(h.nativeRequest).toHaveBeenCalledTimes(8);
  });

  it("runs at most two host calls at once and queues the rest", async () => {
    const gates: ((response: NativeResponse) => void)[] = [];
    const h = harness(() => new Promise<NativeResponse>((resolve) => gates.push(resolve)));
    h.put(
      1,
      ["v0", "v1", "v2"].map((id, i) => record(id, `https://cdn.example/${i}.m3u8`)),
    );

    const pending = [h.frames.grabFrame(1, "v0"), h.frames.grabFrame(1, "v1"), h.frames.grabFrame(1, "v2")];

    await tick();
    expect(h.nativeRequest).toHaveBeenCalledTimes(2);

    gates[0]({ ok: true, frameUrl: FRAME });
    await tick();
    expect(h.nativeRequest).toHaveBeenCalledTimes(3);

    gates[1]({ ok: true, frameUrl: "" });
    gates[2]({ ok: true, frameUrl: "" });
    await expect(Promise.all(pending)).resolves.toEqual([FRAME, "", ""]);
  });

  it("resolves '' — never rejects — when the host call fails", async () => {
    const h = harness(async () => {
      throw new Error("no ffmpeg");
    });
    h.put(1, [record("v0", "https://cdn.example/dead.m3u8")]);

    await expect(h.frames.grabFrame(1, "v0")).resolves.toBe("");
    expect(h.rememberCaptures).not.toHaveBeenCalled();
    expect(h.notifyPopup).not.toHaveBeenCalled();
  });

  it("writes the frame as a capture and refreshes the popup", async () => {
    const h = harness(async () => ({ ok: true, frameUrl: FRAME }));
    h.put(1, [record("v0", "https://cdn.example/live.m3u8")]);

    expect(await h.frames.grabFrame(1, "v0")).toBe(FRAME);
    expect(h.rememberCaptures).toHaveBeenCalledWith(1, [{ id: "v0", thumbnailCandidates: [FRAME] }]);
    expect(h.notifyPopup).toHaveBeenCalledWith({
      type: "videoListUpdated",
      tabId: 1,
      videos: [record("v0", "https://cdn.example/live.m3u8")],
    });
  });

  it("returns '' for an unknown video, an unknown tab, or a record with no URL", async () => {
    const h = harness();
    h.put(1, [record("v0", "https://cdn.example/0.m3u8")]);

    await expect(h.frames.grabFrame(1, "nope")).resolves.toBe("");
    await expect(h.frames.grabFrame(99, "v0")).resolves.toBe("");
    await expect(h.frames.grabFrame(1, "")).resolves.toBe("");
    expect(h.nativeRequest).not.toHaveBeenCalled();
  });
});

describe("framesByUrl", () => {
  it("serves a cached frame and a cached empty on a repeat request, with no second call", async () => {
    const h = harness(async (payload) =>
      String(payload.url).endsWith("live.m3u8") ? { ok: true, frameUrl: FRAME } : { ok: true, frameUrl: "" },
    );
    h.put(1, [record("live", "https://cdn.example/live.m3u8"), record("dead", "https://cdn.example/dead.m3u8")]);

    expect(await h.frames.grabFrame(1, "live")).toBe(FRAME);
    expect(await h.frames.grabFrame(1, "dead")).toBe("");
    expect(h.frames.framesForUrls(["https://cdn.example/live.m3u8", "https://cdn.example/dead.m3u8"])).toEqual({
      "https://cdn.example/live.m3u8": FRAME,
    });

    expect(await h.frames.grabFrame(1, "live")).toBe(FRAME);
    expect(await h.frames.grabFrame(1, "dead")).toBe("");
    expect(h.nativeRequest).toHaveBeenCalledTimes(2);
  });

  it("re-publishes a cached frame to the asking tab, so a second tab gets its art", async () => {
    // The cache is keyed by URL while a capture is keyed by tab + id, so returning the
    // frame without writing a capture leaves the second tab's row on its glyph forever —
    // `VideoRow`'s `framesRequested` guard means it will not ask again.
    const h = harness(async () => ({ ok: true, frameUrl: FRAME }));
    h.put(1, [record("v0", "https://cdn.example/live.m3u8")]);
    h.put(2, [record("v0", "https://cdn.example/live.m3u8")]);

    await h.frames.grabFrame(1, "v0");
    expect(h.rememberCaptures).toHaveBeenCalledTimes(1);
    h.rememberCaptures.mockClear();
    h.notifyPopup.mockClear();

    expect(await h.frames.grabFrame(2, "v0")).toBe(FRAME);
    expect(h.nativeRequest).toHaveBeenCalledTimes(1);
    expect(h.rememberCaptures).toHaveBeenCalledWith(2, [{ id: "v0", thumbnailCandidates: [FRAME] }]);
    expect(h.notifyPopup).toHaveBeenCalledTimes(1);
  });

  it("is a lookup — framesForUrls never spawns a grab", async () => {
    const h = harness();
    expect(h.frames.framesForUrls(["https://cdn.example/never.m3u8"])).toEqual({});
    expect(h.nativeRequest).not.toHaveBeenCalled();
  });

  it("omits a URL whose grab is still pending", async () => {
    const gates: ((response: NativeResponse) => void)[] = [];
    const h = harness(() => new Promise<NativeResponse>((resolve) => gates.push(resolve)));
    h.put(1, [record("v0", "https://cdn.example/slow.m3u8")]);

    const pending = h.frames.grabFrame(1, "v0");
    await tick();
    expect(h.frames.framesForUrls(["https://cdn.example/slow.m3u8"])).toEqual({});

    gates[0]({ ok: true, frameUrl: FRAME });
    await pending;
    expect(h.frames.framesForUrls(["https://cdn.example/slow.m3u8"])).toEqual({
      "https://cdn.example/slow.m3u8": FRAME,
    });
  });

  it("keeps the most recent 64 entries and drops the oldest", async () => {
    // One tab per grab: the budget is per tab, and each URL is distinct, so this
    // exercises the trim rather than the budget. Every URL must yield a *frame* — an
    // `empty` entry is deliberately absent from `framesForUrls`, so it cannot be counted.
    const urls = Array.from({ length: 65 }, (_, i) => `https://cdn.example/${i}.m3u8`);
    const h = harness(async (payload) => ({ ok: true, frameUrl: `${FRAME}${String(payload.url)}` }));
    urls.forEach((url, i) => h.put(i, [record(`v${i}`, url)]));

    for (let i = 0; i < urls.length; i++) {
      await h.frames.grabFrame(i, `v${i}`);
    }
    const frames = h.frames.framesForUrls(urls);
    expect(Object.keys(frames)).toHaveLength(64);
    expect(frames[urls[0]]).toBeUndefined();
    expect(frames[urls[64]]).toBe(`${FRAME}${urls[64]}`);
  });

  it("counts a re-read of a cached frame as recent", async () => {
    const urls = Array.from({ length: 64 }, (_, i) => `https://cdn.example/${i}.m3u8`);
    const h = harness(async (payload) => ({ ok: true, frameUrl: `${FRAME}${String(payload.url)}` }));
    urls.forEach((url, i) => h.put(i, [record(`v${i}`, url)]));
    for (let i = 0; i < urls.length; i++) {
      await h.frames.grabFrame(i, `v${i}`);
    }

    // Touch the oldest entry, then add a 65th — the touched one must survive.
    expect(await h.frames.grabFrame(0, "v0")).toBe(`${FRAME}${urls[0]}`);
    const extra = "https://cdn.example/64.m3u8";
    h.put(64, [record("v64", extra)]);
    await h.frames.grabFrame(64, "v64");

    const frames = h.frames.framesForUrls([...urls, extra]);
    expect(frames[urls[0]]).toBe(`${FRAME}${urls[0]}`);
    expect(frames[urls[1]]).toBeUndefined();
    expect(Object.keys(frames)).toHaveLength(64);
  });
});
