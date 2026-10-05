import type { ExtensionApi, NativeRequestPayload, NativeResponse } from "./types.js";

/**
 * One request/response round trip over native messaging.
 *
 * Rejects with an `Error` for every failure mode (no port, host `error` message,
 * early disconnect, timeout) so the caller has a single failure path, and resolves
 * with the host's own reply otherwise.
 */
function nativeRequest(
  api: ExtensionApi,
  hostName: string,
  payload: NativeRequestPayload,
  timeoutMs = 60000,
): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port | undefined;
    let settled = false;
    const finish = (error: Error | null, response?: NativeResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        if (port) {
          port.disconnect();
        }
      } catch (_error) {}
      if (error) {
        reject(error);
      } else {
        resolve(response as NativeResponse);
      }
    };

    try {
      port = api.runtime.connectNative(hostName);
      if (!port) {
        throw new Error("Native messaging is not available.");
      }
    } catch (error) {
      reject(new Error(`Native messaging is not connected: ${(error as Error).message || error}`));
      return;
    }

    const timeout = setTimeout(() => {
      finish(new Error("Native helper did not respond in time."));
    }, timeoutMs);

    port.onMessage.addListener((message: NativeResponse) => {
      if (!message || message.id !== payload.id) {
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.error || "Native helper returned an error."));
        return;
      }
      finish(null, message);
    });

    port.onDisconnect.addListener(() => {
      const runtimeError = api.runtime.lastError ? api.runtime.lastError.message : "";
      if (!settled) {
        finish(new Error(runtimeError || "Native helper disconnected."));
      }
    });

    port.postMessage(payload);
  });
}

export { nativeRequest };
