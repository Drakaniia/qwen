"use strict";
import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  cookiesResult: [],

  attach(target, _version, callback) {
    this.attachedTabs.add(target.tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  detach(target, callback) {
    this.attachedTabs.delete(target.tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, _params, callback) {
    globalThis.chrome.runtime.lastError = null;
    if (method === "Network.getAllCookies") {
      callback({ cookies: this.cookiesResult });
    } else {
      callback({});
    }
  },
};

globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
  },
  tabs: {
    update: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(null),
  },
};

(async () => {
  const solver = await import("../../../src/background/cloudflare_solver.js");

  // Verify module exports
  assert.equal(typeof solver.detectAndSolveCloudflare, "function");
  assert.equal(typeof solver.openCloudflarePage, "function");
  assert.equal(typeof solver.waitForChallengeComplete, "function");
  assert.equal(typeof solver.extractCFClearance, "function");

  // Test that extractCFClearance returns null when no cf_clearance cookie
  let result = await solver.extractCFClearance(42);
  assert.equal(result, null, "Should return null when no cf_clearance cookie");

  // Test that extractCFClearance returns cf_clearance value when present
  mockDebugger.cookiesResult = [
    { name: "cf_clearance", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    { name: "session", value: "s123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
  ];
  result = await solver.extractCFClearance(42);
  assert.equal(result, "abc123", "Should return cf_clearance value when present");

  // Test graceful handling of missing cookies
  mockDebugger.cookiesResult = [];
  result = await solver.extractCFClearance(42);
  assert.equal(result, null, "Should return null when cookies array is empty");

  console.log("✓ All Cloudflare solver tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
