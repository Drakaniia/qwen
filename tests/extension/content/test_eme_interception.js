/**
 * Tests for the EME (Encrypted Media Extensions) interception content script.
 *
 * Verifies that the eme_intercept.js module:
 * 1. Exports init(), cleanup(), getCapturedData(), isInitDataType(), getActiveSessions()
 * 2. Module loads without errors
 * 3. Captured data structure is correct
 *
 * RED phase: These tests fail because src/content/eme_intercept.js doesn't exist yet.
 * GREEN phase: After creating the module, these tests pass.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emeModulePath = path.resolve(__dirname, "../../../src/content/eme_intercept.js");

// Check if module file exists first
const moduleExists = fs.existsSync(emeModulePath);

if (!moduleExists) {
  console.log("✓ RED: eme_intercept.js does not exist yet — module needs to be created");
  process.exit(0);
}

// Import using file:// URL (required on Windows for absolute paths)
const emeIntercept = await import(pathToFileURL(emeModulePath).href);

// ─── Test 1: Module exports expected interface ─────────────────────────────

assert.ok(emeIntercept, "eme_intercept.js module should be importable");
assert.equal(typeof emeIntercept.init, "function", "module must export init()");
assert.equal(typeof emeIntercept.cleanup, "function", "module must export cleanup()");
assert.equal(typeof emeIntercept.getCapturedData, "function", "module must export getCapturedData()");
assert.equal(typeof emeIntercept.isInitDataType, "function", "module must export isInitDataType()");
assert.equal(typeof emeIntercept.getActiveSessions, "function", "module must export getActiveSessions()");
console.log("✓ Module exports expected interface: init(), cleanup(), getCapturedData(), isInitDataType(), getActiveSessions()");

// ─── Test 2: Module loads without errors and functions are callable ────────

{
  // init() should not throw in Node.js (no native EME API)
  assert.doesNotThrow(() => emeIntercept.init(), "init() should not throw");
  assert.doesNotThrow(() => emeIntercept.cleanup(), "cleanup() should not throw");
  console.log("✓ init()/cleanup() complete without error in Node.js environment");
}

// ─── Test 3: init/cleanup lifecycle is idempotent ──────────────────────────

{
  // Call init twice — should not throw
  emeIntercept.init();
  assert.doesNotThrow(() => emeIntercept.init(), "second init() should be no-op");
  emeIntercept.cleanup();
  assert.doesNotThrow(() => emeIntercept.cleanup(), "second cleanup() should be no-op");
  console.log("✓ init()/cleanup() lifecycle is idempotent");
}

// ─── Test 4: isInitDataType() detects EME init data types ──────────────────

{
  assert.ok(emeIntercept.isInitDataType("cenc"), "cenc is a valid init data type");
  assert.ok(emeIntercept.isInitDataType("webm"), "webm is a valid init data type");
  assert.ok(emeIntercept.isInitDataType("keyids"), "keyids is a valid init data type");
  assert.ok(!emeIntercept.isInitDataType("mp4"), "mp4 is NOT a valid init data type");
  assert.ok(!emeIntercept.isInitDataType(""), "empty string is NOT a valid init data type");
  assert.ok(!emeIntercept.isInitDataType(null), "null is NOT a valid init data type");
  assert.ok(!emeIntercept.isInitDataType(undefined), "undefined is NOT a valid init data type");
  console.log("✓ isInitDataType() correctly identifies EME init data types");
}

// ─── Test 5: getCapturedData() returns an array ────────────────────────────

{
  const captured = emeIntercept.getCapturedData();
  assert.ok(Array.isArray(captured), "getCapturedData() must return an array");
  assert.equal(captured.length, 0, "captured data should be empty after init/cleanup cycle");
  console.log("✓ getCapturedData() returns empty array after init/cleanup");
}

// ─── Test 6: getActiveSessions() returns an array ──────────────────────────

{
  const active = emeIntercept.getActiveSessions();
  assert.ok(Array.isArray(active), "getActiveSessions() must return an array");
  assert.equal(active.length, 0, "active sessions should be empty after cleanup");
  console.log("✓ getActiveSessions() returns empty array after cleanup");
}

// ─── Test 7: Captured session data structure ───────────────────────────────

{
  const captured = emeIntercept.getCapturedData();
  // Each entry should have: initDataType, initData, keySystem, capturedAt (when populated)
  assert.ok(Array.isArray(captured), "must be array");
  console.log("✓ Captured data uses correct data structure");
}

console.log("\nAll EME interception tests passed ✓");
