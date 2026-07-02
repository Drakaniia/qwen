"use strict";
import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  attachErrors: new Map(),

  attach(target, version, callback) {
    const tabId = target.tabId;
    if (this.attachErrors.has(tabId)) {
      globalThis.chrome.runtime.lastError = { message: this.attachErrors.get(tabId) };
      callback();
      return;
    }
    this.attachedTabs.add(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  detach(target, callback) {
    const tabId = target.tabId;
    this.attachedTabs.delete(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, params, callback) {
    globalThis.chrome.runtime.lastError = null;
    callback({});
  },

  onEvent: { addListener() {} },
  onDetach: { addListener() {} },
};

globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
  },
};

(async () => {
  const helpers = await import("../../../src/background/cdp_helpers.js");

  // Test module exports
  assert.equal(typeof helpers.attach, "function", "must export attach(tabId)");
  assert.equal(typeof helpers.detach, "function", "must export detach(tabId)");
  assert.equal(typeof helpers.sendCommand, "function", "must export sendCommand(tabId, method, params)");
  assert.equal(typeof helpers.cleanup, "function", "must export cleanup()");
  assert.equal(typeof helpers.activeSessions, "object", "must export activeSessions Map");

  // Test that cleanup doesn't throw on empty sessions
  await helpers.cleanup();
  assert.equal(helpers.activeSessions.size, 0, "activeSessions should be empty after cleanup");

  // Test attach succeeds with mock chrome.debugger
  const okResult = await helpers.attach(42);
  assert.equal(okResult.ok, true, "attach(42) should succeed with mock debugger");

  // Test attach deduplication — same tabId returns ok without re-attaching
  const dupResult = await helpers.attach(42);
  assert.equal(dupResult.ok, true, "duplicate attach should return ok");

  // Test sendCommand works after attach
  const cmdResult = await helpers.sendCommand(42, "Network.getAllCookies");
  assert.equal(cmdResult.ok, true, "sendCommand should succeed");

  // Test sendCommand fails when not attached
  const detachResult = await helpers.sendCommand(9999, "Network.getAllCookies");
  assert.equal(detachResult.ok, false, "sendCommand to unattached tab should fail");

  // Test detach
  await helpers.detach(42);
  assert.equal(helpers.activeSessions.has(42), false, "tab 42 should be detached");

  // Test guard: when chrome.debugger is undefined, attach returns ok: false
  const savedDebugger = globalThis.chrome.debugger;
  globalThis.chrome.debugger = undefined;
  const guardResult = await helpers.attach(1);
  assert.equal(guardResult.ok, false, "attach must return ok: false when chrome.debugger is undefined");
  assert.ok(guardResult.error, "must include error message when chrome.debugger is undefined");
  globalThis.chrome.debugger = savedDebugger;

  console.log("✓ All cdp_helpers tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
