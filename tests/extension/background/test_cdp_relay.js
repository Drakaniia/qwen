// @ts-check
"use strict";

/**
 * Tests for the CDP relay module (src/background/cdp_relay.js).
 *
 * These tests verify:
 * 1. handleCdpCommand correctly delegates to chrome.debugger.sendCommand
 * 2. handleCdpAttach / handleCdpDetach manage session state
 * 3. handleCdpStatus reports session state
 * 4. The module structure is correct (exports, init, etc.)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  attachErrors: new Map(), // tabId → error message (to simulate failures)
  commandErrors: new Map(), // method → error message
  commandResults: new Map(), // method → result
  lastCommand: null,

  attach(target, version, callback) {
    const tabId = target.tabId;
    this.attachedTabs.add(tabId);
    if (this.attachErrors.has(tabId)) {
      callback(); // callback is called regardless, lastError provides the error
      return;
    }
    callback();
  },

  detach(target, callback) {
    const tabId = target.tabId;
    this.attachedTabs.delete(tabId);
    callback();
  },

  sendCommand(target, method, params, callback) {
    this.lastCommand = { target, method, params };
    const tabId = target.tabId;
    if (!this.attachedTabs.has(tabId)) {
      callback({ error: "Not attached" });
      return;
    }
    if (this.commandErrors.has(method)) {
      callback({ error: this.commandErrors.get(method) });
      return;
    }
    callback(this.commandResults.get(method) || {});
  },

  onEvent: {
    addListener() {},
  },
  onDetach: {
    addListener() {},
  },

  reset() {
    this.attachedTabs.clear();
    this.attachErrors.clear();
    this.commandErrors.clear();
    this.commandResults.clear();
    this.lastCommand = null;
  },
};

// Mock chrome.runtime
const mockRuntime = {
  lastError: null,
};

// Set up the global chrome mock before importing the module
globalThis.chrome = {
  debugger: mockDebugger,
  runtime: mockRuntime,
};

// Now import the module after setting up the mock
let cdpRelay;
try {
  cdpRelay = await import("../../../src/background/cdp_relay.js");
} catch (_err) {
  // The import might fail in test environment due to bundler/module resolution.
  // We'll define the interface contract tests that the source module must satisfy.
  console.warn("Could not import cdp_relay.js directly. Running structural tests.");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("cdp_relay module", () => {
  before(() => {
    mockDebugger.reset();
    cdpRelay.cleanup();
  });

  after(() => {
    mockDebugger.reset();
    cdpRelay.cleanup();
  });

  describe("module structure", () => {
    it("should export all required functions", () => {
      assert.ok(cdpRelay, "cdp_relay module should be importable");
      assert.equal(typeof cdpRelay.attach, "function");
      assert.equal(typeof cdpRelay.detach, "function");
      assert.equal(typeof cdpRelay.sendCommand, "function");
      assert.equal(typeof cdpRelay.handleCdpCommand, "function");
      assert.equal(typeof cdpRelay.handleCdpAttach, "function");
      assert.equal(typeof cdpRelay.handleCdpDetach, "function");
      assert.equal(typeof cdpRelay.handleCdpStatus, "function");
      assert.equal(typeof cdpRelay.getActiveSessionTabIds, "function");
      assert.equal(typeof cdpRelay.init, "function");
    });
  });

  describe("handleCdpAttach", () => {
    before(() => {
      mockDebugger.reset();
      cdpRelay.cleanup();
    });

    it("should attach to a valid tab", async () => {
      const result = await cdpRelay.handleCdpAttach({ tabId: 42 });
      assert.ok(result.ok);
      assert.ok(mockDebugger.attachedTabs.has(42));
    });

    it("should return error for missing tabId", async () => {
      const result = await cdpRelay.handleCdpAttach({});
      assert.ok(!result.ok);
      assert.ok(result.error);
    });

    it("should be idempotent when already attached", async () => {
      const result1 = await cdpRelay.handleCdpAttach({ tabId: 99 });
      assert.ok(result1.ok);
      const result2 = await cdpRelay.handleCdpAttach({ tabId: 99 });
      assert.ok(result2.ok);
      const sessions = cdpRelay.getActiveSessionTabIds();
      assert.equal(sessions.filter((id) => id === 99).length, 1);
    });
  });

  describe("handleCdpDetach", () => {
    before(() => {
      mockDebugger.reset();
      cdpRelay.cleanup();
    });

    it("should detach from an attached tab", async () => {
      await cdpRelay.handleCdpAttach({ tabId: 7 });
      assert.ok(mockDebugger.attachedTabs.has(7));

      const result = await cdpRelay.handleCdpDetach({ tabId: 7 });
      assert.ok(result.ok);
      assert.ok(!mockDebugger.attachedTabs.has(7));
    });

    it("should handle detach when not attached", async () => {
      const result = await cdpRelay.handleCdpDetach({ tabId: 999 });
      assert.ok(result.ok); // Should succeed silently
    });
  });

  describe("handleCdpCommand", () => {
    before(() => {
      mockDebugger.reset();
      cdpRelay.cleanup();
    });

    it("should auto-attach and send a CDP command", async () => {
      mockDebugger.commandResults.set("Network.enable", {});

      const result = await cdpRelay.handleCdpCommand({
        tabId: 42,
        method: "Network.enable",
        params: {},
      });

      assert.ok(result.ok);
      assert.ok(mockDebugger.attachedTabs.has(42), "should have auto-attached");
      assert.equal(mockDebugger.lastCommand.method, "Network.enable");
    });

    it("should return error for missing tabId or method", async () => {
      const result1 = await cdpRelay.handleCdpCommand({ method: "test" });
      assert.ok(!result1.ok);
      assert.ok(result1.error.includes("tabId"));

      const result2 = await cdpRelay.handleCdpCommand({ tabId: 1 });
      assert.ok(!result2.ok);
      assert.ok(result2.error.includes("method"));
    });

    it("should send command params correctly", async () => {
      mockDebugger.reset();

      const testParams = { expression: "document.title", returnByValue: true };

      const result = await cdpRelay.handleCdpCommand({
        tabId: 42,
        method: "Runtime.evaluate",
        params: testParams,
      });

      assert.ok(result.ok);
      assert.deepEqual(mockDebugger.lastCommand.params, testParams);
    });
  });

  describe("handleCdpStatus", () => {
    before(() => {
      mockDebugger.reset();
      cdpRelay.cleanup();
    });

    it("should report no active sessions initially", async () => {
      const result = await cdpRelay.handleCdpStatus();
      assert.ok(result.ok);
      assert.equal(result.sessionCount, 0);
      assert.ok(result.debuggerAvailable);
    });

    it("should report active sessions after attach", async () => {
      await cdpRelay.handleCdpAttach({ tabId: 42 });
      await cdpRelay.handleCdpAttach({ tabId: 99 });

      const result = await cdpRelay.handleCdpStatus();
      assert.equal(result.sessionCount, 2);
      assert.ok(result.activeSessions.includes(42));
      assert.ok(result.activeSessions.includes(99));
    });
  });

  describe("init", () => {
    before(() => mockDebugger.reset());

    it("should register debugger event listeners without error", () => {
      // Should not throw
      cdpRelay.init();
    });
  });
});
