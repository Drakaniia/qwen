import { describe, expect, it, vi } from "vitest";

import { browserApi } from "../../../src/shared/browser_api.js";
import * as PopupApi from "../../../src/shared/popup_api.js";

/**
 * Two loops below walk `browserApi` and the `popup_api` namespace by *name*. Neither
 * object has an index signature — deliberately, the wrapper is typed so a typo in a
 * caller is an error — so the loops read them through this one cast rather than
 * weakening either type.
 */
const byName = (target: object, key: string) => (target as Record<string, unknown>)[key];

/**
 * The chrome messaging methods are overloaded on their callback arity, so an inferred
 * second/third parameter lands on the wrong overload (`options`, or a bare `{}`). These
 * spies name the callback they actually invoke.
 */
type Reply = (response?: unknown) => void;

describe("browserApi surface", () => {
  it("exposes the mocked chrome object, not a promise-api global", () => {
    expect(browserApi.raw).toBe(globalThis.chrome);
    expect(browserApi.isChrome).toBe(true);
    expect(browserApi.isFirefox).toBe(false);
  });

  it("has the documented namespaces", () => {
    for (const key of ["storage", "tabs", "cookies", "scripting", "runtime", "webRequest", "action"]) {
      expect(byName(browserApi, key)).toBeTypeOf("object");
    }
    expect(browserApi.storage.sync).toBeTypeOf("object");
    expect(browserApi.webRequest.onBeforeRequest.addListener).toBeTypeOf("function");
    expect(browserApi.webRequest.onBeforeSendHeaders.addListener).toBeTypeOf("function");
    expect(browserApi.webRequest.onHeadersReceived.addListener).toBeTypeOf("function");
  });

  it("has the documented registration helpers", () => {
    for (const key of [
      "onTabRemoved",
      "onTabUpdated",
      "onMessage",
      "onBeforeRequest",
      "onBeforeSendHeaders",
      "onHeadersReceived",
    ]) {
      expect(byName(browserApi, key)).toBeTypeOf("function");
    }
  });

  it("registers listeners without throwing", () => {
    const handler = vi.fn();
    expect(() => browserApi.onMessage(handler)).not.toThrow();
    expect(() => browserApi.onTabRemoved(handler)).not.toThrow();
    expect(() => browserApi.onTabUpdated(handler)).not.toThrow();
    expect(() => browserApi.onBeforeRequest(handler)).not.toThrow();
    expect(() => browserApi.onBeforeSendHeaders(handler)).not.toThrow();
    expect(() => browserApi.onHeadersReceived(handler)).not.toThrow();
  });

  it("routes storage.local through the callback bridge", async () => {
    const set = vi.spyOn(chrome.storage.local, "set").mockImplementation((_i, cb) => cb?.());
    const get = vi.spyOn(chrome.storage.local, "get").mockImplementation((_k, cb) => cb?.({ key: "value" }));
    const remove = vi.spyOn(chrome.storage.local, "remove").mockImplementation((_k, cb) => cb?.());

    await browserApi.storage.set({ key: "value" });
    await expect(browserApi.storage.get("key")).resolves.toEqual({ key: "value" });
    await browserApi.storage.remove("key");

    expect(set.mock.calls[0][0]).toEqual({ key: "value" });
    expect(get.mock.calls[0][0]).toBe("key");
    expect(remove.mock.calls[0][0]).toBe("key");

    set.mockRestore();
    get.mockRestore();
    remove.mockRestore();
  });

  it("routes storage.sync through the callback bridge", async () => {
    const get = vi.spyOn(chrome.storage.sync, "get").mockImplementation((_k, cb) => cb?.({ only: "sync" }));
    await expect(browserApi.storage.sync.get("only")).resolves.toEqual({ only: "sync" });
    expect(get).toHaveBeenCalled();
    get.mockRestore();
  });

  it("resolves runtime.sendMessage to the callback's response", async () => {
    const send = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockImplementation(((_m: unknown, cb: unknown) => (cb as Reply | undefined)?.({ ok: true })) as never);
    await expect(browserApi.runtime.sendMessage({ type: "ping" })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalled();
    send.mockRestore();
  });

  it("resolves tabs.sendMessage to null when the receiver does not answer", async () => {
    const send = vi
      .spyOn(chrome.tabs, "sendMessage")
      .mockImplementation(((_t: unknown, _m: unknown, cb: unknown) => (cb as Reply | undefined)?.(undefined)) as never);
    await expect(browserApi.tabs.sendMessage(1, { type: "ping" })).resolves.toBeNull();
    send.mockRestore();
  });

  it("falls back instead of throwing for every chrome method the mock has not implemented", async () => {
    // vitest-chrome-mv3 either throws "<ns>.<method> is not implemented" or returns
    // undefined depending on how many times the mock has been reset. Every
    // browserApi wrapper must absorb both instead of rejecting.
    await expect(browserApi.tabs.query({})).resolves.toBeFalsy();
    await expect(browserApi.cookies.getAll({} as chrome.cookies.CookieDetails)).resolves.toEqual([]);
    // An injection request with no `target`, so the chrome typing is bypassed on purpose.
    await expect(browserApi.scripting.executeScript({} as never)).resolves.toBeNull();
    expect(browserApi.runtime.connectNative("com.qwin.video_downloader")).toBeNull();
  });

  it("returns the callback payload rather than treating lastError as fatal", async () => {
    const send = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockImplementation(((_m: unknown, cb: unknown) => (cb as Reply | undefined)?.({ ok: false })) as never);
    await expect(browserApi.runtime.sendMessage({ type: "ping" })).resolves.toEqual({ ok: false });
    send.mockRestore();
  });
});

describe("popup_api surface", () => {
  const EXPECTED_EXPORTS = [
    "runtimeMessage",
    "tabsQuery",
    "getVideos",
    "getVideoFormats",
    "getFormatsForUrl",
    // playlist-parallel-download: a playlist URL expands to rows, then one batched
    // download message instead of one per row.
    "enumeratePlaylist",
    "downloadMany",
    "rescanTab",
    "clearVideos",
    "clearDownloads",
    "downloadVideo",
    "pauseDownload",
    "resumeDownload",
    "cancelDownload",
    "retryDownload",
    "openDownloadedFile",
    "showDownloadedFile",
    "removeDownload",
    "saveSettings",
    "chooseDownloadFolder",
    "pingNativeHost",
    "getHelperStatus",
    "getDownloadSyncHistory",
    "setDownloadSyncEnabled",
    "clearDownloadSyncHistory",
    // hls-thumbnail-spec.md §3.2/§5.3. `rescanForFrames` is the odd one out: it
    // goes straight into the tab via `tabs.sendMessage`, not to the background.
    "grabThumbnailFrame",
    "thumbnailFrames",
    "rescanForFrames",
  ];

  it("exports every semantic message helper as a function", () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(byName(PopupApi, name), name).toBeTypeOf("function");
    }
    expect(Object.keys(PopupApi).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  /** Capture the message the module sends through chrome.runtime.sendMessage. */
  async function sent(call: () => Promise<unknown>) {
    const spy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockImplementation(((_message: unknown, callback: unknown) =>
        (callback as Reply | undefined)?.({ ok: true })) as never);
    const result = await call();
    const payload = spy.mock.calls[0]?.[0];
    spy.mockRestore();
    return { payload, result };
  }

  it.each([
    ["getVideos", () => PopupApi.getVideos(7), { type: "getVideos", tabId: 7 }],
    ["getVideoFormats", () => PopupApi.getVideoFormats(7, "v1"), { type: "getVideoFormats", tabId: 7, videoId: "v1" }],
    [
      "getFormatsForUrl",
      () => PopupApi.getFormatsForUrl(7, { id: "v1" }),
      { type: "getFormatsForUrl", tabId: 7, video: { id: "v1" } },
    ],
    ["rescanTab", () => PopupApi.rescanTab(7), { type: "rescanTab", tabId: 7 }],
    ["clearVideos", () => PopupApi.clearVideos(7), { type: "clearVideos", tabId: 7 }],
    ["clearDownloads", () => PopupApi.clearDownloads(7), { type: "clearDownloads", tabId: 7 }],
    ["pauseDownload", () => PopupApi.pauseDownload(7, "j"), { type: "pauseDownload", tabId: 7, jobId: "j" }],
    ["resumeDownload", () => PopupApi.resumeDownload(7, "j"), { type: "resumeDownload", tabId: 7, jobId: "j" }],
    ["cancelDownload", () => PopupApi.cancelDownload(7, "j"), { type: "cancelDownload", tabId: 7, jobId: "j" }],
    ["retryDownload", () => PopupApi.retryDownload(7, "j"), { type: "retryDownload", tabId: 7, jobId: "j" }],
    [
      "openDownloadedFile",
      () => PopupApi.openDownloadedFile(7, "j"),
      { type: "openDownloadedFile", tabId: 7, jobId: "j" },
    ],
    [
      "showDownloadedFile",
      () => PopupApi.showDownloadedFile(7, "j"),
      { type: "showDownloadedFile", tabId: 7, jobId: "j" },
    ],
    ["removeDownload", () => PopupApi.removeDownload(7, "j"), { type: "removeDownload", tabId: 7, jobId: "j" }],
    ["chooseDownloadFolder", () => PopupApi.chooseDownloadFolder(), { type: "chooseDownloadFolder" }],
    ["pingNativeHost", () => PopupApi.pingNativeHost(), { type: "pingNativeHost" }],
    ["getHelperStatus", () => PopupApi.getHelperStatus(), { type: "getHelperStatus" }],
    ["getDownloadSyncHistory", () => PopupApi.getDownloadSyncHistory(), { type: "getDownloadSyncHistory" }],
    [
      "setDownloadSyncEnabled",
      () => PopupApi.setDownloadSyncEnabled(true),
      { type: "setDownloadSyncEnabled", enabled: true },
    ],
    ["clearDownloadSyncHistory", () => PopupApi.clearDownloadSyncHistory(), { type: "clearDownloadSyncHistory" }],
  ])("%s sends the expected message", async (_name, call, expected) => {
    const { payload, result } = await sent(call);
    expect(payload).toEqual(expected);
    expect(result).toEqual({ ok: true });
  });

  it("downloadVideo defaults variantId and backend", async () => {
    const { payload } = await sent(() => PopupApi.downloadVideo(7, "v1", "best"));
    expect(payload).toEqual({
      type: "downloadVideo",
      tabId: 7,
      videoId: "v1",
      formatId: "best",
      variantId: "",
      backend: "auto",
    });
  });

  it("downloadVideo forwards an explicit variant and backend", async () => {
    const { payload } = await sent(() => PopupApi.downloadVideo(7, "v1", "best", "var-2", "aria2"));
    expect(payload).toMatchObject({ variantId: "var-2", backend: "aria2" });
  });

  it("saveSettings nests the settings object", async () => {
    const { payload } = await sent(() => PopupApi.saveSettings({ downloadFolder: "D:/vids", musicMode: true }));
    expect(payload).toEqual({
      type: "saveSettings",
      settings: { downloadFolder: "D:/vids", musicMode: true },
    });
  });

  it("runtimeMessage surfaces lastError as { ok: false }", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(((_message: unknown, callback: unknown) => {
      Object.defineProperty(chrome.runtime, "lastError", {
        value: { message: "Could not establish connection" },
        configurable: true,
      });
      (callback as Reply | undefined)?.(undefined);
    }) as never);
    await expect(PopupApi.getVideos(1)).resolves.toEqual({
      ok: false,
      error: "Could not establish connection",
    });
    spy.mockRestore();
  });

  it("tabsQuery queries the active tab in the current window", async () => {
    const spy = vi
      .spyOn(chrome.tabs, "query")
      .mockImplementation((_info: chrome.tabs.QueryInfo, callback?: (tabs: chrome.tabs.Tab[]) => void) =>
        callback?.([{ id: 5 } as chrome.tabs.Tab]),
      );
    await expect(PopupApi.tabsQuery()).resolves.toEqual([{ id: 5 }]);
    expect(spy.mock.calls[0][0]).toEqual({ active: true, currentWindow: true });
    spy.mockRestore();
  });
});
