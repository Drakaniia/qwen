/**
 * Test: Service Worker Scope Detection
 *
 * Tests that the content script can detect whether a page already has
 * a controlling Service Worker before attempting capture SW registration.
 * This determines whether SW capture is feasible (§6.1).
 *
 * Edge Case from audit: §4.1 Service Worker scope detection (MEDIUM)
 */

import assert from "node:assert/strict";

// ─── 1. hasExistingServiceWorker detects when SW controls page ─────────

{
  console.log("--- Test 1: hasExistingServiceWorker with existing SW ---");

  // Mock navigator where a SW controller exists
  const mockNavigatorWithSW = {
    serviceWorker: {
      controller: { scriptURL: "https://example.com/sw.js", state: "activated" },
    },
  };

  // Import and test the function (re-did for each test block to avoid cross-contamination)
  const mod = await import("../../../src/content/service_worker_capture.js");

  // The function should detect the existing SW
  const detected = mod.hasExistingServiceWorker(mockNavigatorWithSW);
  assert.ok(detected === true, "hasExistingServiceWorker should return true when SW controller exists");

  console.log("  ✓ Detected existing Service Worker controller");
}

// ─── 2. No existing SW returns false ───────────────────────────────────

{
  console.log("\n--- Test 2: hasExistingServiceWorker without SW ---");

  const mod = await import("../../../src/content/service_worker_capture.js");

  // Mock navigator without a SW controller
  const mockNavigatorNoSW = {
    serviceWorker: {
      controller: null,
    },
  };

  const detected = mod.hasExistingServiceWorker(mockNavigatorNoSW);
  assert.ok(detected === false, "hasExistingServiceWorker should return false when no SW controller");

  console.log("  ✓ No SW controller correctly reported");
}

// ─── 3. Throws or handles missing navigator gracefully ─────────────────

{
  console.log("\n--- Test 3: hasExistingServiceWorker with missing navigator ---");

  const mod = await import("../../../src/content/service_worker_capture.js");

  // Simulate test environment where navigator may not have serviceWorker
  const mockNavigatorUndefined = undefined;

  const detected = mod.hasExistingServiceWorker(mockNavigatorUndefined);
  assert.ok(detected === false, "hasExistingServiceWorker should return false when navigator is undefined");

  console.log("  ✓ Handles undefined navigator gracefully");
}

// ─── 4. SW with various states (activated, installing, waiting) ────────

{
  console.log("\n--- Test 4: hasExistingServiceWorker with various SW states ---");

  const mod = await import("../../../src/content/service_worker_capture.js");

  const testStates = ["installing", "waiting", "activating", "activated", "redundant"];
  for (const state of testStates) {
    const mockNavigator = {
      serviceWorker: {
        controller: { scriptURL: "https://example.com/sw.js", state },
      },
    };
    const detected = mod.hasExistingServiceWorker(mockNavigator);
    assert.ok(detected === true, "hasExistingServiceWorker should return true regardless of SW state (" + state + ")");
  }

  console.log("  ✓ All SW states correctly detected");
}

// ─── 5. Previously unregistered SW (controller becomes null) ───────────

{
  console.log("\n--- Test 5: False negative after SW unregister ---");

  const mod = await import("../../../src/content/service_worker_capture.js");

  // Simulate what happens after a SW is unregistered
  const mockNavigatorPostUnregister = {
    serviceWorker: {
      controller: null,
    },
  };

  const detected = mod.hasExistingServiceWorker(mockNavigatorPostUnregister);
  assert.ok(detected === false, "hasExistingServiceWorker should return false after SW is unregistered");

  console.log("  ✓ Correctly reports no SW after unregister");
}

console.log("\n✓ All Service Worker scope detection tests completed");
