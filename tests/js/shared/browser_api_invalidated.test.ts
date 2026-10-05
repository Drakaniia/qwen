import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The promise branch of the shim is the one Chromium 148+ takes (`globalThis.browser`
 * exists there), and it is the branch that used to leak an uncaught error: after the
 * extension is reloaded under a live content script, `runtime.sendMessage` **throws**
 * `"Extension context invalidated."` synchronously rather than rejecting, so a bare
 * `.catch()` never saw it. This file drives that branch with a stubbed `browser`
 * namespace, which nothing else can do — the module captures `isPromiseApi` at import
 * time from the one global `vitest.setup.ts` does not install.
 */

const INVALIDATED = "Extension context invalidated.";

/** Either a healthy promise-returning stub or one that throws the invalidation error. */
type Binding = () => unknown;

/** Import a fresh `browser_api` module with a promise-style `browser` global installed. */
async function importWithPromiseApi(overrides: { sendMessage?: Binding; storageGet?: Binding } = {}) {
  vi.resetModules();
  const resolve =
    <T>(value: T) =>
    () =>
      Promise.resolve(value);
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: overrides.sendMessage ?? resolve<unknown>({ ok: true }),
      onMessage: { addListener: () => undefined },
    },
    storage: {
      local: {
        get: overrides.storageGet ?? resolve<Record<string, unknown>>({}),
        set: resolve(null),
        remove: resolve(null),
      },
      sync: { get: resolve({}), set: resolve(undefined), remove: resolve(undefined) },
    },
    tabs: { query: resolve([]) },
  });
  return import("../../../src/shared/browser_api.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser_api on an invalidated extension context", () => {
  it("sees the promise API when globalThis.browser exists", async () => {
    const { isPromiseApi } = await importWithPromiseApi();
    expect(isPromiseApi).toBe(true);
  });

  it("resolves a synchronous throw from runtime.sendMessage to { ok: false, error }", async () => {
    const { sendMessage } = await importWithPromiseApi({
      sendMessage: () => {
        throw new Error(INVALIDATED);
      },
    });

    await expect(sendMessage({ type: "contentDetectedVideos" })).resolves.toEqual({
      ok: false,
      error: INVALIDATED,
    });
  });

  it("resolves a synchronous throw out of invokeAsync to its fallback", async () => {
    const { browserApi } = await importWithPromiseApi({
      storageGet: () => {
        throw new Error(INVALIDATED);
      },
    });

    await expect(browserApi.storage.get("qwinSettings")).resolves.toBeNull();
  });

  it("still resolves a healthy promise response", async () => {
    const { sendMessage } = await importWithPromiseApi();
    await expect(sendMessage({ type: "ping" })).resolves.toEqual({ ok: true });
  });
});
