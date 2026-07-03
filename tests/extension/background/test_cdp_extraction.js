// @ts-check
"use strict";

/**
 * Tests for the CDP-based URL extraction module (src/background/cdp_extraction.js).
 *
 * These tests verify:
 * 1. Module exports the expected interface
 * 2. getExtractionScript() returns valid JavaScript that finds video sources
 * 3. extractVideosFromTab() handles empty results correctly
 * 4. extractVideosFromTab() handles video results correctly
 * 5. CDP attach failures are handled gracefully
 * 6. Runtime.evaluate failures are handled gracefully
 */

import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  lastCommand: null,
  evaluateResults: new Map(), // expression → result
  evaluateError: null, // if set, Runtime.evaluate will fail
  attachError: null, // if set, attach will fail

  attach(target, version, callback) {
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
    this.attachedTabs.delete(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, params, callback) {
    this.lastCommand = { target, method, params };
    const tabId = target.tabId;

    if (!this.attachedTabs.has(tabId)) {
      globalThis.chrome.runtime.lastError = { message: "Not attached" };
      callback();
      return;
    }

    if (method === "Runtime.evaluate") {
      if (this.evaluateError) {
        const err = this.evaluateError;
        this.evaluateError = null;
        globalThis.chrome.runtime.lastError = { message: err };
        callback();
        return;
      }

      const expression = params.expression || "";
      const key = expression.slice(0, 100);
      const canned = this.evaluateResults.get(key);
      if (canned !== undefined) {
        globalThis.chrome.runtime.lastError = null;
        callback({ result: { type: "object", value: canned } });
        return;
      }

      // Default: return empty array
      globalThis.chrome.runtime.lastError = null;
      callback({ result: { type: "object", value: [] } });
      return;
    }

    globalThis.chrome.runtime.lastError = null;
    callback({});
  },

  onEvent: { addListener() {} },
  onDetach: { addListener() {} },

  reset() {
    this.attachedTabs.clear();
    this.lastCommand = null;
    this.evaluateResults.clear();
    this.evaluateError = null;
    this.attachError = null;
    globalThis.chrome.runtime.lastError = null;
  },
};

// Set up global chrome mock
globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
    connectNative() {
      return null;
    },
  },
};

// ─── Import the module ─────────────────────────────────────────────────────

let cdpExtraction;
try {
  cdpExtraction = await import("../../../src/background/cdp/index.js");
} catch (err) {
  console.warn("Could not import cdp_extraction.js directly:", err.message);
  console.warn("Running structural interface tests only.");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

(async () => {
  // ─── Test 1: Module structure ─────────────────────────────────────────────

  {
    assert.ok(cdpExtraction, "cdp_extraction module should be importable");
    assert.equal(typeof cdpExtraction.getExtractionScript, "function", "module must export getExtractionScript()");
    assert.equal(
      typeof cdpExtraction.extractVideosFromTab,
      "function",
      "module must export extractVideosFromTab(tabId)",
    );
    console.log("✓ Test 1: Module exports correct interface");
  }

  // ─── Test 2: getExtractionScript() returns valid JavaScript ────────────────

  {
    const script = cdpExtraction.getExtractionScript();
    assert.equal(typeof script, "string", "extraction script must be a string");
    assert.ok(script.length > 50, "extraction script must be non-trivial");

    // The script is a self-executing function that returns an array.
    // We can test it by evaluating it directly.
    const result = eval(`(${script})`);
    assert.ok(Array.isArray(result), "extraction script must return an array");
    assert.equal(result.length, 0, "extraction script returns empty when in Node.js (no DOM)");
    console.log("✓ Test 2: getExtractionScript() returns valid JavaScript that runs without error");
  }

  // ─── Test 3: extractVideosFromTab returns empty for page with no videos ────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const result = await cdpExtraction.extractVideosFromTab(42);
    assert.ok(result.ok, "extractVideosFromTab must return ok: true");
    assert.ok(Array.isArray(result.videos), "result.videos must be an array");
    assert.equal(result.videos.length, 0, "result.videos must be empty for a page with no videos");
    console.log("✓ Test 3: extractVideosFromTab returns empty when no videos found");
  }

  // ─── Test 4: extractVideosFromTab returns videos when found ───────────────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    // Set up mock to return video sources
    const mockVideos = [
      { url: "https://example.com/video.mp4", type: "video/mp4", source: "video-src" },
      { url: "https://example.com/stream.m3u8", type: "application/x-mpegURL", source: "video-src" },
    ];

    // The module's extraction script will be injected via Runtime.evaluate.
    // Match on the first 100 chars of the script.
    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);
    mockDebugger.evaluateResults.set(scriptKey, mockVideos);

    const result = await cdpExtraction.extractVideosFromTab(42);
    assert.ok(result.ok, "extractVideosFromTab must return ok: true");
    assert.ok(Array.isArray(result.videos), "result.videos must be an array");
    assert.equal(result.videos.length, 2, "result.videos must contain 2 videos");
    assert.equal(result.videos[0].url, "https://example.com/video.mp4");
    assert.equal(result.videos[1].url, "https://example.com/stream.m3u8");
    console.log("✓ Test 4: extractVideosFromTab returns videos when found");
  }

  // ─── Test 5: Handles CDP attach failure gracefully ────────────────────────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    // Simulate attach failure
    mockDebugger.attachError = "Debugger is already attached to the target";

    const result = await cdpExtraction.extractVideosFromTab(42);
    assert.ok(!result.ok, "extractVideosFromTab must return ok: false on attach failure");
    assert.ok(result.error, "result.error must be set on attach failure");
    assert.match(result.error, /attach|debugger/i, "error must mention attach/debugger");
    console.log("✓ Test 5: Handles CDP attach failure gracefully");
  }

  // ─── Test 6: Handles Runtime.evaluate failure gracefully ──────────────────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    // Simulate evaluate failure
    mockDebugger.evaluateError = "Cannot find function";

    const result = await cdpExtraction.extractVideosFromTab(99);
    assert.ok(!result.ok, "extractVideosFromTab must return ok: false on evaluate failure");
    assert.ok(result.error, "result.error must be set on evaluate failure");
    assert.match(result.error, /Cannot find function/, "error must mention the CDP error");
    console.log("✓ Test 6: Handles Runtime.evaluate failure gracefully");
  }

  // ─── Test 7: detachAfter option controls whether CDP stays attached ───────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    // By default, detachAfter is true, so tab is detached after extraction
    const resultDefault = await cdpExtraction.extractVideosFromTab(55);
    assert.ok(resultDefault.ok, "extraction with default options should succeed");
    assert.ok(
      !mockDebugger.attachedTabs.has(55),
      "by default, CDP should be detached after extraction (detachAfter: true)",
    );
    console.log("✓ Test 7a: Default behavior detaches CDP after extraction");
  }

  // ─── Test 8: detachAfter: false keeps CDP attached ────────────────────────

  {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    // With detachAfter: false, tab stays attached
    const resultKeep = await cdpExtraction.extractVideosFromTab(77, { detachAfter: false });
    assert.ok(resultKeep.ok, "extraction with detachAfter:false should succeed");
    assert.ok(mockDebugger.attachedTabs.has(77), "with detachAfter: false, CDP should stay attached after extraction");

    // Cleanup should detach
    cdpExtraction.cleanup();
    assert.ok(!mockDebugger.attachedTabs.has(77), "cleanup should detach from all tabs");
    console.log("✓ Test 8: detachAfter:false keeps CDP attached, cleanup works");
  }

  console.log("\nAll CDP extraction tests passed ✓");
})().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
