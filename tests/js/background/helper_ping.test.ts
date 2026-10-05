/**
 * First covering test for the helper ping (native-helper-status-spec.md §5 Step 7).
 *
 * `cachedHelperStatus` is the single value every helper panel reads, so the two facts worth
 * pinning are which `connected` each ping result produces and that the un-answered state
 * is `null` rather than `false`. `refreshCachedHelperStatus` calls its module-local
 * `pingNativeHost`, so there is no injection seam — `chrome.runtime.connectNative` is the
 * one spy that reaches it, which is also the same mocking seam `shared/browser_api.test.ts`
 * established.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOST = "com.qwin.video_downloader";

type Deliver = (reply: unknown) => void;

/**
 * A port that answers the ping with a `pong`, echoing the ping's own id the way
 * `host.py:pong_response` does. Answering synchronously is legal and keeps the 5s timeout
 * out of the test.
 */
function pongPort(version: string, dependencies: Record<string, unknown>): chrome.runtime.Port {
  let deliver: Deliver = () => undefined;
  return {
    onMessage: {
      addListener: (fn: Deliver) => {
        deliver = fn;
      },
    },
    onDisconnect: { addListener: () => undefined },
    postMessage: (message: unknown) =>
      deliver({ id: (message as { id: string }).id, type: "pong", version, dependencies }),
    disconnect: () => undefined,
  } as unknown as chrome.runtime.Port;
}

/** A port that dies without a pong — the helper is not registered, or could not start. */
function deadPort(): chrome.runtime.Port {
  let drop: () => void = () => undefined;
  return {
    onMessage: { addListener: () => undefined },
    onDisconnect: {
      addListener: (fn: () => void) => {
        drop = fn;
      },
    },
    postMessage: () => drop(),
    disconnect: () => undefined,
  } as unknown as chrome.runtime.Port;
}

/**
 * A fresh module per test: `cachedHelperStatus` is a module-level `let` that every probe
 * reassigns. The namespace is returned rather than destructured, because a destructured
 * copy would be the value from before the probe ran.
 */
async function freshPing(): Promise<typeof import("../../../src/background/background_helper_ping.js")> {
  vi.resetModules();
  return import("../../../src/background/background_helper_ping.js");
}

function setLastError(message: string): void {
  Object.defineProperty(chrome.runtime, "lastError", { value: { message }, configurable: true });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(chrome.runtime, "lastError");
});

describe("refreshCachedHelperStatus", () => {
  it("starts un-answered rather than declaring a failure nobody has observed", async () => {
    const ping = await freshPing();

    expect(ping.cachedHelperStatus.connected).toBeNull();
    expect(ping.cachedHelperStatus.lastChecked).toBe(0);
    expect(ping.cachedHelperStatus.dependencies).toEqual({});
  });

  it("records connected, the version and the reported dependencies after a pong", async () => {
    const ping = await freshPing();
    const dependencies = { ytDlp: true, ffmpeg: true, aria2c: true, nM3u8DlRe: true, streamlink: true };
    const connect = vi.spyOn(chrome.runtime, "connectNative").mockReturnValue(pongPort("1.0.0", dependencies));

    await ping.refreshCachedHelperStatus(vi.fn(), HOST);

    expect(connect).toHaveBeenCalledWith(HOST);
    expect(ping.cachedHelperStatus).toMatchObject({ connected: true, version: "1.0.0", dependencies, error: "" });
    expect(ping.cachedHelperStatus.lastChecked).toBeGreaterThan(0);
  });

  it("records a dead port as a checked failure and keeps the host's own error", async () => {
    const ping = await freshPing();
    vi.spyOn(chrome.runtime, "connectNative").mockReturnValue(deadPort());
    setLastError("Specified native messaging host not found.");

    await ping.refreshCachedHelperStatus(vi.fn(), HOST);

    // `connected: false`, not `null`: a probe ran and came back empty-handed, which is the
    // fact Options has to be able to render differently from "nobody has answered yet".
    expect(ping.cachedHelperStatus).toMatchObject({
      connected: false,
      error: "Specified native messaging host not found.",
      dependencies: {},
    });
  });

  it("falls back to its own wording when the port dies with no error message", async () => {
    const ping = await freshPing();
    vi.spyOn(chrome.runtime, "connectNative").mockReturnValue(deadPort());

    await ping.refreshCachedHelperStatus(vi.fn(), HOST);

    expect(ping.cachedHelperStatus.error).toBe("Native helper is not registered or could not start.");
    expect(ping.cachedHelperStatus.connected).toBe(false);
  });

  it("broadcasts only when the connected value changes", async () => {
    const ping = await freshPing();
    const notify = vi.fn();
    vi.spyOn(chrome.runtime, "connectNative").mockReturnValue(pongPort("1.0.0", { ytDlp: true }));

    await ping.refreshCachedHelperStatus(notify, HOST);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: "helperStatusChanged", status: { connected: true } });

    // A second identical pong is not news; re-broadcasting every 30s would repaint the panel.
    await ping.refreshCachedHelperStatus(notify, HOST);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ping.cachedHelperStatus.connected).toBe(true);
  });
});
