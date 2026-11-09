/**
 * `browserApi.downloads` — the callback spelling the test env runs (vitest-chrome-mv3 is
 * callback-style and ships no `downloads` namespace, so one is installed per test).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserApi } from "../../../src/shared/browser_api.js";

function install(downloads: Record<string, unknown>): void {
  Object.assign(chrome, { downloads });
}

afterEach(() => {
  Reflect.deleteProperty(chrome, "downloads");
  Reflect.deleteProperty(chrome.runtime, "lastError");
});

describe("browserApi.downloads", () => {
  it("resolves search with the browser's items, and [] when the namespace is missing", async () => {
    install({ search: (_query: unknown, cb: (items: unknown[]) => void) => cb([{ id: 4, state: "complete" }]) });
    expect(await browserApi.downloads.search({ id: 4 })).toEqual([{ id: 4, state: "complete" }]);

    Reflect.deleteProperty(chrome, "downloads");
    expect(await browserApi.downloads.search({ id: 4 })).toEqual([]);
  });

  it("answers pause/resume/cancel with whether the browser accepted it", async () => {
    install({
      pause: (_id: number, cb: () => void) => cb(),
      cancel: (_id: number, cb: () => void) => cb(),
      resume: (_id: number, cb: () => void) => {
        Object.defineProperty(chrome.runtime, "lastError", {
          value: { message: "Download must be in progress" },
          configurable: true,
        });
        cb();
      },
    });
    expect(await browserApi.downloads.pause(1)).toBe(true);
    expect(await browserApi.downloads.cancel(1)).toBe(true);
    // A refusal is `false`, not a throw: `download_operations.ts` restarts the job on it.
    expect(await browserApi.downloads.resume(1)).toBe(false);
  });

  it("registers one onChanged listener when the namespace exists, and is a no-op otherwise", () => {
    const addListener = vi.fn();
    install({ onChanged: { addListener } });
    const handler = vi.fn();
    browserApi.onDownloadChanged(handler);
    expect(addListener).toHaveBeenCalledWith(handler);

    Reflect.deleteProperty(chrome, "downloads");
    expect(() => browserApi.onDownloadChanged(handler)).not.toThrow();
  });
});
