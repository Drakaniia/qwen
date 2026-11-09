import { browserApi } from "../shared/browser_api.js";
import type { HelperStatus, NotifyPopup, PingResult } from "./types.js";

// ── Cached helper status ────────────────────────────────────────────────

export const HELPER_PING_INTERVAL_MS = 30000;

export let cachedHelperStatus: HelperStatus = {
  // `null`, not `false`: no probe has answered yet, which is a different fact from
  // "a probe ran and the helper was unreachable". Both leave `dependencies` empty, so
  // only the tri-state keeps the UI from calling all five tools missing on first paint.
  // See native-helper-status-spec.md §2.1.
  connected: null,
  version: "",
  dependencies: {},
  lastChecked: 0,
  error: "",
};
let helperPingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a ping check and update the cached status.
 * If the status changed from the previous check, broadcast to popups.
 * @param notifyPopup - Function to send messages to popup
 * @param hostName - Native messaging host name to ping
 */
export async function refreshCachedHelperStatus(notifyPopup: NotifyPopup, hostName: string): Promise<void> {
  // This runs every 30s from a bare `setInterval`, so a rejection here is an unhandled
  // rejection every 30s. `pingNativeHost` already resolves on every path it knows of; the
  // catch is the backstop for the ones it does not.
  const result: PingResult = await pingNativeHost(hostName).catch((error: unknown) => ({
    ok: false as const,
    error: (error as Error)?.message || String(error),
  }));
  const previousConnected = cachedHelperStatus.connected;

  if (result && result.ok) {
    cachedHelperStatus = {
      connected: true,
      version: result.version || "",
      dependencies: result.dependencies || {},
      lastChecked: Date.now(),
      error: "",
    };
  } else {
    cachedHelperStatus = {
      connected: false,
      version: "",
      dependencies: {},
      lastChecked: Date.now(),
      error: result && result.error ? result.error : "Native helper is not registered or could not start.",
    };
  }

  // Broadcast to popups if status changed
  if (previousConnected !== cachedHelperStatus.connected) {
    notifyPopup({ type: "helperStatusChanged", status: { ...cachedHelperStatus } });
  }
}

/**
 * Start the periodic helper ping interval.
 * Runs immediately on start, then every HELPER_PING_INTERVAL_MS.
 * @param notifyPopup - Function to send messages to popup
 * @param hostName - Native messaging host name to ping
 */
export function startHelperPing(notifyPopup: NotifyPopup, hostName: string): void {
  // Clear any existing timer
  if (helperPingTimer !== null) {
    clearInterval(helperPingTimer);
  }

  // Run immediately
  void refreshCachedHelperStatus(notifyPopup, hostName);

  // Then run periodically
  helperPingTimer = setInterval(() => void refreshCachedHelperStatus(notifyPopup, hostName), HELPER_PING_INTERVAL_MS);
}

// ── Native host ping ─────────────────────────────────────────────────────

/**
 * Ping the native host to check if it's running and get version/dependency info.
 *
 * No injection seam on purpose: `chrome.runtime.connectNative` is the only way in,
 * so an optional `runtimeApi` override would be a second, permanently-untested path
 * to the same port. `tests/js/background/helper_ping.test.ts` spies on the real API
 * instead.
 *
 * @param hostName - The native messaging host name
 */
export function pingNativeHost(hostName: string): Promise<PingResult> {
  return new Promise((resolve) => {
    const id = `ping_${Date.now()}`;
    let settled = false;
    let port: chrome.runtime.Port | null = null;
    try {
      // The raw call, not `browserApi.runtime.connectNative`: that wrapper turns a throw
      // into `null`, and the throw's message ("Specified native messaging host not
      // found", "Access to the specified native messaging host is forbidden") is the
      // only diagnosis Options can show.
      port = browserApi.raw.runtime.connectNative(hostName);
    } catch (error) {
      resolve({ ok: false, error: `Native messaging is not connected: ${(error as Error)?.message || error}` });
      return;
    }

    const finish = (result: PingResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
      try {
        if (port) {
          port.disconnect();
        }
      } catch (_error) {}
    };

    if (!port) {
      finish({ ok: false, error: "Native messaging is not available in this browser." });
      return;
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Native helper did not respond." });
    }, 5000);

    port.onMessage.addListener((raw) => {
      const message = raw as { id?: string; type?: string; version?: string; dependencies?: Record<string, unknown> };
      if (message && message.id === id && message.type === "pong") {
        clearTimeout(timeout);
        finish({ ok: true, version: message.version, dependencies: message.dependencies || {} });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      const runtimeError = browserApi.raw.runtime.lastError ? browserApi.raw.runtime.lastError.message : "";
      console.warn("[helper-ping] Native messaging port disconnected:", runtimeError || "no error message");
      finish({
        ok: false,
        error: runtimeError || "Native helper is not registered or could not start.",
      });
    });

    try {
      port.postMessage({ type: "ping", id });
    } catch (error) {
      clearTimeout(timeout);
      finish({ ok: false, error: (error as Error)?.message || String(error) });
    }
  });
}
