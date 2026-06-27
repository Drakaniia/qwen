/**
 * Tests for WebKit/Safari EME Detection (GAP 9)
 *
 * Tests the detectWebKitEmeCapabilities() and isWebKitKeySystem()
 * functions from the EME interception module.
 */

import assert from "node:assert/strict";

// Set up minimal global stubs for Node.js environment
// navigator is a getter-only property, so use defineProperty
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      requestMediaKeySystemAccess: async () => {
        throw new Error("Not available");
      },
    },
    writable: true,
    configurable: true,
  });
}
globalThis.MediaKeys = class MediaKeys {};
globalThis.window = {};

let emeModule;
try {
  emeModule = await import("../../../src/content/eme_intercept.js");
} catch (err) {
  console.warn("Could not import eme_intercept.js:", err.message);
  emeModule = null;
}

(async () => {
  // ─── Test: Module exports WebKit functions ────────────────────────────────

  {
    if (!emeModule) {
      assert.ok(false, "eme_intercept.js module should be importable");
      return;
    }
    assert.equal(typeof emeModule.detectWebKitEmeCapabilities, "function", "must export detectWebKitEmeCapabilities()");
    assert.equal(typeof emeModule.isWebKitKeySystem, "function", "must export isWebKitKeySystem()");
    console.log("✓ Module exports WebKit detection functions");
  }

  // ─── Test: isWebKitKeySystem detection ────────────────────────────────────

  {
    if (emeModule) {
      assert.ok(emeModule.isWebKitKeySystem("com.apple.fps.1_0"), "FairPlay 1.0 should be detected as WebKit key system");
      assert.ok(emeModule.isWebKitKeySystem("com.apple.fps.2_0"), "FairPlay 2.0 should be detected as WebKit key system");
      assert.ok(emeModule.isWebKitKeySystem("webkit-foo"), "webkit- prefixed key systems should be detected");
      assert.ok(!emeModule.isWebKitKeySystem("com.widevine.alpha"), "Widevine should NOT be detected as WebKit");
      assert.ok(!emeModule.isWebKitKeySystem(""), "empty string should NOT be detected as WebKit");
      assert.ok(!emeModule.isWebKitKeySystem(null), "null should NOT be detected as WebKit");
      console.log("✓ isWebKitKeySystem correctly identifies WebKit/Safari key systems");
    }
  }

  // ─── Test: detectWebKitEmeCapabilities returns correct shape ──────────────

  {
    if (emeModule) {
      const result = await emeModule.detectWebKitEmeCapabilities();
      assert.ok(result !== null, "detectWebKitEmeCapabilities should return an object");
      assert.equal(typeof result.webkitKeys, "boolean", "webkitKeys should be boolean");
      assert.equal(typeof result.webkitMediaKeys, "boolean", "webkitMediaKeys should be boolean");
      assert.equal(typeof result.fairplay, "boolean", "fairplay should be boolean");
      console.log("✓ detectWebKitEmeCapabilities returns correct shape");
    }
  }

  // ─── Test: detectWebKitEmeCapabilities without WebKit features ────────────

  {
    if (emeModule) {
      // In Node.js, no WebKit features should be detected
      const result = await emeModule.detectWebKitEmeCapabilities();
      assert.equal(result.webkitKeys, false, "webkitKeys should be false in non-WebKit environment");
      assert.equal(result.webkitMediaKeys, false, "webkitMediaKeys should be false in non-WebKit environment");
      assert.equal(result.fairplay, false, "fairplay should be false in non-WebKit environment");
      console.log("✓ detectWebKitEmeCapabilities correctly reports no WebKit features in non-WebKit environment");
    }
  }

  // ─── Test: isWebKitKeySystem case insensitivity ──────────────────────────

  {
    if (emeModule) {
      assert.ok(emeModule.isWebKitKeySystem("COM.APPLE.FPS.1_0"), "should be case insensitive for FPS");
      assert.ok(emeModule.isWebKitKeySystem("WebKit-Foo"), "should be case insensitive for webkit- prefix");
      console.log("✓ isWebKitKeySystem is case insensitive");
    }
  }

  console.log("\nAll WebKit/Safari EME detection tests completed ✓");
})().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
