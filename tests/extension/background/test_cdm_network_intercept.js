// @ts-check
"use strict";

/**
 * Tests for the CDP network interception module (src/background/cdm_network_intercept.js).
 *
 * Phase 1b: CDM-proxy pipeline — CDP network interception for Widevine
 * license exchange capture.
 *
 * These tests verify:
 * 1. Module exports the expected interface
 * 2. isWidevineUrl() correctly identifies Widevine license endpoints
 * 3. initIntercept() attaches CDP and enables Network domain
 * 4. Network.requestWillBeSent events are captured and filtered
 * 5. Network.loadingFinished triggers getResponseBody for tracked requests
 * 6. stopIntercept() cleans up sessions
 * 7. Captured license exchanges are returned in the correct format
 */

import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  lastCommand: null,
  onEventListener: null,
  onDetachListener: null,
  networkEvents: {}, // tabId → array of CDP events to fire
  getResponseBodyResult: null,
  getResponseBodyError: null,
  commandErrors: new Map(),
  commandResults: new Map(),
  attachError: null,
  detachError: null,

  attach(target, _version, callback) {
    const tabId = target.tabId;
    if (this.attachError) {
      const err = this.attachError;
      this.attachError = null;
      globalThis.chrome.runtime.lastError = { message: err };
      callback();
      return;
    }
    this.attachedTabs.add(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  detach(target, callback) {
    const tabId = target.tabId;
    if (this.detachError) {
      const err = this.detachError;
      this.detachError = null;
      globalThis.chrome.runtime.lastError = { message: err };
      callback();
      return;
    }
    this.attachedTabs.delete(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, params, callback) {
    this.lastCommand = { target, method, params };
    const tabId = target.tabId;

    if (!this.attachedTabs.has(tabId) && method !== "Runtime.evaluate") {
      globalThis.chrome.runtime.lastError = { message: "Not attached" };
      callback();
      return;
    }

    if (this.commandErrors.has(method)) {
      globalThis.chrome.runtime.lastError = { message: this.commandErrors.get(method) };
      callback();
      return;
    }

    globalThis.chrome.runtime.lastError = null;

    // Network.getResponseBody: return canned result or error
    if (method === "Network.getResponseBody") {
      if (this.getResponseBodyError) {
        callback({ error: this.getResponseBodyError });
        return;
      }
      callback({ body: this.getResponseBodyResult || "", base64Encoded: true });
      return;
    }

    // Default: return canned result or empty
    const result = this.commandResults.get(method) || {};
    callback(result);
  },

  onEvent: {
    addListener(fn) {
      mockDebugger.onEventListener = fn;
    },
  },

  onDetach: {
    addListener(fn) {
      mockDebugger.onDetachListener = fn;
    },
  },

  /**
   * Fire a simulated CDP event through the registered listener.
   * @param {string} method - CDP event method name
   * @param {Object} params - Event parameters
   */
  fireEvent(method, params) {
    if (this.onEventListener) {
      this.onEventListener({ tabId: 42 }, method, params);
    }
  },

  reset() {
    this.attachedTabs.clear();
    this.lastCommand = null;
    this.onEventListener = null;
    this.onDetachListener = null;
    this.networkEvents = {};
    this.getResponseBodyResult = null;
    this.getResponseBodyError = null;
    this.commandErrors.clear();
    this.commandResults.clear();
    this.attachError = null;
    this.detachError = null;
    globalThis.chrome.runtime.lastError = null;
  },
};

// Set up global chrome mock
globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
    connectNative() {
      return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
    },
    sendMessage() {
      return Promise.resolve({});
    },
    onMessage: { addListener() {} },
  },
};

// ─── Import the module ─────────────────────────────────────────────────────

let cdmNetworkIntercept;
try {
  cdmNetworkIntercept = await import("../../../src/background/cdm_network_intercept.js");
} catch (err) {
  console.warn("Could not import cdm_network_intercept.js directly:", err.message);
}

// ─── Test helpers ──────────────────────────────────────────────────────────

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

(async () => {
  // ─── Test 1: Module structure ─────────────────────────────────────────────

  {
    assert.ok(cdmNetworkIntercept, "cdm_network_intercept module should be importable");
    assert.equal(typeof cdmNetworkIntercept.isWidevineUrl, "function", "must export isWidevineUrl()");
    assert.equal(typeof cdmNetworkIntercept.initIntercept, "function", "must export initIntercept(tabId)");
    assert.equal(typeof cdmNetworkIntercept.stopIntercept, "function", "must export stopIntercept(tabId)");
    assert.equal(typeof cdmNetworkIntercept.stopAll, "function", "must export stopAll()");
    assert.equal(typeof cdmNetworkIntercept.getCapturedExchanges, "function", "must export getCapturedExchanges()");
    assert.equal(typeof cdmNetworkIntercept.clearCapturedExchanges, "function", "must export clearCapturedExchanges()");
    console.log("✓ Test 1: Module exports correct interface");
  }

  // ─── Test 2: isWidevineUrl detection ──────────────────────────────────────

  {
    // Recognized Widevine license endpoints
    assert.ok(
      cdmNetworkIntercept.isWidevineUrl("https://example.com/wv/license", "POST"),
      "must detect /license POST as Widevine",
    );
    assert.ok(
      cdmNetworkIntercept.isWidevineUrl("https://example.com/widevine", "POST"),
      "must detect /widevine POST as Widevine",
    );
    assert.ok(
      cdmNetworkIntercept.isWidevineUrl("https://example.com/api/license?token=abc", "POST"),
      "must detect /license with query string",
    );

    // Non-Widevine URLs should not match
    assert.ok(
      !cdmNetworkIntercept.isWidevineUrl("https://example.com/video.mp4", "GET"),
      "GET to .mp4 should not be Widevine",
    );
    assert.ok(
      !cdmNetworkIntercept.isWidevineUrl("https://example.com/index.html", "GET"),
      "GET to .html should not be Widevine",
    );
    assert.ok(
      !cdmNetworkIntercept.isWidevineUrl("https://example.com/api/stream", "GET"),
      "GET to /api/stream should not be Widevine",
    );
    assert.ok(
      !cdmNetworkIntercept.isWidevineUrl("https://example.com/manifest.m3u8", "GET"),
      "GET to .m3u8 should not be Widevine",
    );

    // Edge cases
    assert.ok(!cdmNetworkIntercept.isWidevineUrl("", "POST"), "empty URL should not be Widevine");
    assert.ok(
      !cdmNetworkIntercept.isWidevineUrl("https://example.com/wv/license", "GET"),
      "GET to /license should not be considered Widevine (need POST)",
    );
    console.log("✓ Test 2: isWidevineUrl correctly identifies Widevine license URLs");
  }

  // ─── Test 3: initIntercept attaches CDP and enables Network ───────────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});

    const result = await cdmNetworkIntercept.initIntercept(42);
    assert.ok(result.ok, "initIntercept must return ok: true");
    assert.ok(mockDebugger.attachedTabs.has(42), "debugger should be attached to tab 42");

    // Should have sent Network.enable as the first command after attach
    assert.equal(mockDebugger.lastCommand.method, "Network.enable", "first command should be Network.enable");

    console.log("✓ Test 3: initIntercept attaches CDP and enables Network domain");
  }

  // ─── Test 4: initIntercept returns error if CDP attach fails ──────────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.attachError = "Debugger already attached to the target";

    const result = await cdmNetworkIntercept.initIntercept(42);
    assert.ok(!result.ok, "initIntercept must return ok: false on attach failure");
    assert.ok(result.error, "error must be set on attach failure");
    assert.match(result.error, /attach|debugger/i, "error must mention attach/debugger");

    console.log("✓ Test 4: initIntercept handles CDP attach failure gracefully");
  }

  // ─── Test 5: Network.requestWillBeSent captures Widevine license requests ─

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    const result = await cdmNetworkIntercept.initIntercept(42);
    assert.ok(result.ok, "initIntercept must succeed");

    // Simulate a Widevine license request
    mockDebugger.fireEvent("Network.requestWillBeSent", {
      requestId: "req_1",
      request: {
        url: "https://example.licensing.com/wv/license",
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        postData: "encrypted_challenge_data_in_base64",
      },
      type: "XHR",
      timestamp: 1234567.89,
    });

    await flushMicrotasks();

    // Should have tracked this request
    const exchanges = cdmNetworkIntercept.getCapturedExchanges();
    assert.equal(exchanges.length, 1, "should have captured 1 license exchange");
    assert.equal(exchanges[0].requestId, "req_1", "should store requestId");
    assert.equal(exchanges[0].url, "https://example.licensing.com/wv/license", "should store URL");
    assert.equal(exchanges[0].postData, "encrypted_challenge_data_in_base64", "should store post data");
    assert.equal(exchanges[0].status, "pending", "status should be pending (waiting for response)");

    console.log("✓ Test 5: Network.requestWillBeSent captures Widevine license requests");
  }

  // ─── Test 6: Non-Widevine requests are NOT captured ──────────────────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    await cdmNetworkIntercept.initIntercept(42);

    // Simulate a non-Widevine request (GET, video URL)
    mockDebugger.fireEvent("Network.requestWillBeSent", {
      requestId: "req_video",
      request: {
        url: "https://cdn.example.com/video.mp4",
        method: "GET",
        headers: {},
      },
      type: "Media",
    });

    // Simulate another non-Widevine request (XHR to API)
    mockDebugger.fireEvent("Network.requestWillBeSent", {
      requestId: "req_api",
      request: {
        url: "https://api.example.com/data.json",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
      type: "XHR",
    });

    await flushMicrotasks();

    const exchanges = cdmNetworkIntercept.getCapturedExchanges();
    assert.equal(exchanges.length, 0, "non-Widevine requests should not be captured");

    console.log("✓ Test 6: Non-Widevine requests are not captured");
  }

  // ─── Test 7: Network.loadingFinished triggers getResponseBody for tracked requests ─

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    mockDebugger.getResponseBodyResult = "decrypted_license_response_in_base64";

    await cdmNetworkIntercept.initIntercept(42);

    // Fire requestWillBeSent for a Widevine license
    mockDebugger.fireEvent("Network.requestWillBeSent", {
      requestId: "req_license",
      request: {
        url: "https://example.licensing.com/wv/license",
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        postData: "challenge_base64",
      },
      type: "XHR",
    });

    await flushMicrotasks();

    // Fire loadingFinished for the same request
    mockDebugger.fireEvent("Network.loadingFinished", {
      requestId: "req_license",
      timestamp: 1234568.0,
      encodedDataLength: 2048,
    });

    await flushMicrotasks();

    const exchanges = cdmNetworkIntercept.getCapturedExchanges();
    assert.equal(exchanges.length, 1, "should have 1 captured exchange");
    assert.equal(exchanges[0].requestId, "req_license", "should match requestId");
    assert.equal(exchanges[0].status, "completed", "status should be completed");
    assert.equal(exchanges[0].responseBody, "decrypted_license_response_in_base64", "should contain response body");
    assert.ok(exchanges[0].completedAt, "should have completedAt timestamp");
    assert.ok(exchanges[0].capturedAt, "should have capturedAt timestamp");

    console.log("✓ Test 7: loadingFinished triggers getResponseBody for tracked requests");
  }

  // ─── Test 8: Captured exchanges can be retrieved and cleared ──────────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    await cdmNetworkIntercept.initIntercept(42);

    // Capture a license request
    mockDebugger.fireEvent("Network.requestWillBeSent", {
      requestId: "req_1",
      request: {
        url: "https://example.licensing.com/wv/license",
        method: "POST",
        headers: {},
        postData: "challenge",
      },
      type: "XHR",
    });

    await flushMicrotasks();

    assert.equal(cdmNetworkIntercept.getCapturedExchanges().length, 1, "should have 1 exchange");

    cdmNetworkIntercept.clearCapturedExchanges();
    assert.equal(cdmNetworkIntercept.getCapturedExchanges().length, 0, "should be empty after clear");

    console.log("✓ Test 8: Captured exchanges can be retrieved and cleared");
  }

  // ─── Test 9: stopIntercept detaches and removes event listeners ───────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    await cdmNetworkIntercept.initIntercept(42);
    assert.ok(mockDebugger.attachedTabs.has(42), "should be attached");

    const stopResult = await cdmNetworkIntercept.stopIntercept(42);
    assert.ok(stopResult.ok, "stopIntercept must return ok: true");
    assert.ok(!mockDebugger.attachedTabs.has(42), "tab should be detached after stop");

    console.log("✓ Test 9: stopIntercept detaches and cleans up");
  }

  // ─── Test 10: stopAll cleans up all active intercepts ─────────────────────

  {
    mockDebugger.reset();
    cdmNetworkIntercept.stopAll();
    cdmNetworkIntercept.clearCapturedExchanges();

    mockDebugger.commandResults.set("Network.enable", {});
    await cdmNetworkIntercept.initIntercept(42);
    await cdmNetworkIntercept.initIntercept(99);

    assert.ok(mockDebugger.attachedTabs.has(42), "tab 42 should be attached");
    assert.ok(mockDebugger.attachedTabs.has(99), "tab 99 should be attached");

    cdmNetworkIntercept.stopAll();

    assert.ok(!mockDebugger.attachedTabs.has(42), "tab 42 should be detached after stopAll");
    assert.ok(!mockDebugger.attachedTabs.has(99), "tab 99 should be detached after stopAll");

    console.log("✓ Test 10: stopAll cleans up all active intercepts");
  }

  console.log("\nAll CDM network interception tests passed ✓");
})().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
