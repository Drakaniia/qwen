(function attachQwinNativeRequests(root, factory) {
  const nativeRequests = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = nativeRequests;
  }
  root.QwinNativeRequests = nativeRequests;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinNativeRequests() {
  "use strict";

  function nativeRequest(api, hostName, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let port;
      let settled = false;
      const finish = (error, response) => {
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
          resolve(response);
        }
      };

      try {
        port = api.runtime.connectNative(hostName);
      } catch (error) {
        reject(new Error(`Native messaging is not connected: ${error.message || error}`));
        return;
      }

      const timeout = setTimeout(() => {
        finish(new Error("Native helper did not respond in time."));
      }, timeoutMs);

      port.onMessage.addListener((message) => {
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

  return {
    nativeRequest,
  };
});
