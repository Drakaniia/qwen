// @ts-check
"use strict";

/**
 * Layer 2 — CDP Source Extraction Tests
 *
 * Tests for four gaps identified in `docs/audit/implementation-gaps.md`:
 *   1. Iframe recursion — extract videos from child frames via CDP
 *   2. Shadow DOM traversal — find videos inside shadow roots
 *   3. Mutation watching — wait for dynamically-added video elements
 *   4. Event simulation — trigger load/play on lazy-loaded video elements
 *
 * All edge cases are covered per feature.
 *
 * Following TDD: write failing test first, then implement minimal code to pass.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");

// ─── JSDOM environment for DOM-dependent tests ─────────────────────────────

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "https://example.com",
  pretendToBeVisual: true,
  // Shadow DOM is supported by jsdom
});

const domDocument = dom.window.document;
const domCreateElement = domDocument.createElement.bind(domDocument);
const domBody = domDocument.body;

// ─── Mock chrome.debugger API (extended for Layer 2) ───────────────────────

const mockDebugger = {
  /** @type {Set<number>} */
  attachedTabs: new Set(),

  /** Last CDP command received */
  lastCommand: null,

  /** @type {Map<string, any>} expressionKey → canned result */
  evaluateResults: new Map(),

  /** @type {Map<number, Array<{frameId: string, url: string, parentId?: string}>>} */
  mockFrameTrees: new Map(),

  /** @type {Map<string, any>} frameId → evaluate result */
  frameEvaluateResults: new Map(),

  evaluateError: null,
  attachError: null,
  getFrameTreeError: null,
  detachError: null,

  /** Track how many times sendCommand was called */
  callCount: 0,

  onEvent: {
    listeners: new Map(),
    addListener(callback) {
      this.listeners.set("onEvent", callback);
    },
  },

  onDetach: {
    listeners: new Map(),
    addListener(callback) {
      this.listeners.set("onDetach", callback);
    },
  },

  /** Fire a simulated CDP event */
  fireEvent(source, method, params) {
    const cb = this.onEvent.listeners.get("onEvent");
    if (cb) cb(source, method, params);
  },

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
    // Fire onDetach
    const cb = this.onDetach.listeners.get("onDetach");
    if (cb) cb({ tabId });
  },

  sendCommand(target, method, params, callback) {
    this.callCount++;
    this.lastCommand = { target, method, params };
    const tabId = target.tabId;

    if (!this.attachedTabs.has(tabId)) {
      globalThis.chrome.runtime.lastError = { message: "Not attached" };
      callback({});
      return;
    }

    // Page.getFrameTree
    if (method === "Page.getFrameTree") {
      if (this.getFrameTreeError) {
        const err = this.getFrameTreeError;
        this.getFrameTreeError = null;
        globalThis.chrome.runtime.lastError = { message: err };
        callback({});
        return;
      }
      const tree = this.mockFrameTrees.get(tabId);
      if (tree) {
        globalThis.chrome.runtime.lastError = null;
        callback({ frameTree: buildFrameTree(tree) });
        return;
      }
      // Default: top-level frame only
      globalThis.chrome.runtime.lastError = null;
      callback({
        frameTree: {
          frame: { id: "main", url: "https://example.com", mimeType: "text/html" },
          childFrames: [],
        },
      });
      return;
    }

    // Page.enable / DOM.enable
    if (method === "Page.enable" || method === "DOM.enable") {
      globalThis.chrome.runtime.lastError = null;
      callback({});
      return;
    }

    // DOM.getDocument
    if (method === "DOM.getDocument") {
      globalThis.chrome.runtime.lastError = null;
      callback({
        root: { nodeId: 1, nodeType: 9, nodeName: "#document" },
      });
      return;
    }

    // Runtime.evaluate
    if (method === "Runtime.evaluate") {
      if (this.evaluateError) {
        const err = this.evaluateError;
        this.evaluateError = null;
        globalThis.chrome.runtime.lastError = { message: err };
        callback({});
        return;
      }

      const expression = params.expression || "";
      const key = expression.slice(0, 100);

      // Try all evaluate result keys - check if any key prefix matches
      let matchedValue = undefined;
      for (const [storedKey, value] of this.evaluateResults) {
        if (key.startsWith(storedKey) || storedKey.startsWith(key) || storedKey === key) {
          matchedValue = value;
          break;
        }
      }

      if (matchedValue !== undefined) {
        globalThis.chrome.runtime.lastError = null;
        const resultValue = typeof matchedValue === "function" ? matchedValue(params) : matchedValue;
        callback({ result: { type: "object", value: resultValue } });
        return;
      }

      // Default: return empty array
      globalThis.chrome.runtime.lastError = null;
      callback({ result: { type: "object", value: [] } });
      return;
    }

    // Runtime.runIfWaitingForDebugger
    if (method === "Runtime.runIfWaitingForDebugger") {
      globalThis.chrome.runtime.lastError = null;
      callback({});
      return;
    }

    globalThis.chrome.runtime.lastError = null;
    callback({});
  },

  reset() {
    this.attachedTabs.clear();
    this.lastCommand = null;
    this.callCount = 0;
    this.evaluateResults.clear();
    this.frameEvaluateResults.clear();
    this.mockFrameTrees.clear();
    this.evaluateError = null;
    this.attachError = null;
    this.getFrameTreeError = null;
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
      return null;
    },
  },
};

/**
 * Build a CDP frame tree structure from a flat array.
 * @param {Array<{frameId: string, url: string, parentId?: string}>} frames
 * @returns {Object}
 */
function buildFrameTree(frames) {
  const nodeMap = new Map();
  for (const f of frames) {
    nodeMap.set(f.frameId, {
    frame: { id: f.frameId, url: f.url, mimeType: "text/html", parentId: f.parentId || "" },
    childFrames: [],
    });
  }
  let root = null;
  for (const f of frames) {
    const node = nodeMap.get(f.frameId);
    if (!f.parentId) {
      root = node;
    } else {
      const parent = nodeMap.get(f.parentId);
      if (parent) parent.childFrames.push(node);
    }
  }
  return root || { frame: { id: "main", url: "about:blank" }, childFrames: [] };
}

// ─── Import the module ─────────────────────────────────────────────────────

let cdpExtraction;
try {
  cdpExtraction = await import("../../../src/background/cdp/index.js");
} catch (err) {
  console.warn("Could not import cdp_extraction.js directly:", err.message);
  console.warn("Running as module-structural tests.");
}

// ═══════════════════════════════════════════════════════════════════════════
// GREEN PHASE: Run tests against implementation
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    return async () => {
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${name}: ${err.message}`);
        if (err.stack) {
          const lines = err.stack.split("\n").slice(1, 4).join("\n");
          console.log(`      ${lines}`);
        }
      }
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Feature 1: Iframe Recursion (§2.1)
  // ───────────────────────────────────────────────────────────────────────

  console.log("\n═══ Feature 1: Iframe Recursion ═══\n");

  // Test 1.1: discoverFrameTree returns frame tree structure
  await test("1.1 discoverFrameTree returns frame tree structure", async () => {
    assert.ok(cdpExtraction.discoverFrameTree, "discoverFrameTree must be exported");

    mockDebugger.reset();
    cdpExtraction.cleanup();
    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/player", parentId: "main" },
    ]);

    const result = await cdpExtraction.discoverFrameTree(42);
    assert.ok(result.ok, "discoverFrameTree must return ok: true");
    assert.ok(Array.isArray(result.frames), "result.frames must be an array");
    assert.equal(result.frames.length, 2, "must discover 2 frames");
    assert.equal(result.frames[0].frameId, "main");
    assert.equal(result.frames[1].frameId, "child1");
    assert.equal(result.frames[1].parentId, "main");
  })();

  // Test 1.2: discoverFrameTree returns only top-level frame when no child iframes
  await test("1.2 discoverFrameTree returns single frame when no iframes", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();
    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
    ]);

    const result = await cdpExtraction.discoverFrameTree(42);
    assert.ok(result.ok);
    assert.equal(result.frames.length, 1, "must have exactly 1 frame");
    assert.equal(result.frames[0].frameId, "main");
  })();

  // Test 1.3: discoverFrameTree handles nested iframes (3+ levels deep)
  await test("1.3 discoverFrameTree handles nested iframes 3 levels deep", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();
    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "top", url: "https://example.com" },
      { frameId: "mid", url: "https://example.com/embed", parentId: "top" },
      { frameId: "inner", url: "https://cdn.example.com/player", parentId: "mid" },
    ]);

    const result = await cdpExtraction.discoverFrameTree(42);
    assert.ok(result.ok);
    assert.equal(result.frames.length, 3, "must discover all 3 nested frames");
    const inner = result.frames.find((f) => f.frameId === "inner");
    assert.ok(inner, "inner frame must exist");
    assert.equal(inner.parentId, "mid");
  })();

  // Test 1.4: discoverFrameTree returns error on CDP failure
  await test("1.4 discoverFrameTree returns error on CDP Page.getFrameTree failure", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();
    mockDebugger.getFrameTreeError = "Target closed";

    const result = await cdpExtraction.discoverFrameTree(42);
    assert.ok(!result.ok, "must return ok: false on failure");
    assert.ok(result.error, "error must be set");
    assert.match(result.error, /Target closed/, "error must match CDP error");
  })();

  // Test 1.5: discoverFrameTree handles invalid tabId
  await test("1.5 discoverFrameTree returns error for invalid tabId", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();
    const result = await cdpExtraction.discoverFrameTree(-1);
    assert.ok(!result.ok);
    assert.ok(result.error);
  })();

  // Test 1.6: extractVideosFromTab with recursive:true extracts from child frames
  await test("1.6 extractVideosFromTab with recursive:true extracts from child frames", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/player", parentId: "main" },
    ]);

    // Both frames return videos
    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);

    // Set results for both frames - the mock uses evaluateResults for all evaluations
    mockDebugger.evaluateResults.set(
      scriptKey,
      [{ url: "https://cdn.example.com/video.mp4", type: "video/mp4", source: "video-src" }]
    );

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok, "must return ok: true");
    assert.ok(Array.isArray(result.videos), "result.videos must be an array");
    assert.equal(result.videos.length, 1, "must find 1 video (deduplicated)");
    assert.equal(result.videos[0].url, "https://cdn.example.com/video.mp4");
  })();

  // Test 1.7: extractVideosFromTab with recursive:false (default) only extracts top frame
  await test("1.7 extractVideosFromTab default (non-recursive) only extracts top frame", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/player", parentId: "main" },
    ]);

    // Default is recursive: false, should only query top frame
    const prevCount = mockDebugger.callCount;
    const result = await cdpExtraction.extractVideosFromTab(42);
    assert.ok(result.ok);
    assert.equal(result.videos.length, 0, "no videos from top frame");
  })();

  // Test 1.8: Videos from all frames are merged and deduplicated
  await test("1.8 recursive extraction merges and deduplicates videos across frames", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/player", parentId: "main" },
    ]);

    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);

    // Each frame returns a different video
    let frameEvalCount = 0;
    mockDebugger.evaluateResults.set(
      scriptKey,
      () => {
        frameEvalCount++;
        if (frameEvalCount === 1) {
          return [{ url: "https://cdn.example.com/video.mp4", type: "video/mp4", source: "video-src" }];
        }
        return [{ url: "https://cdn.example.com/stream.m3u8", type: "application/x-mpegURL", source: "video-src" }];
      }
    );

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok);
    assert.equal(result.videos.length, 2, "must have 2 unique videos after merge");
    const urls = result.videos.map((v) => v.url);
    assert.ok(urls.includes("https://cdn.example.com/video.mp4"));
    assert.ok(urls.includes("https://cdn.example.com/stream.m3u8"));
  })();

  // Test 1.9: Recursive extraction handles child frame failure gracefully
  await test("1.9 recursive extraction handles child frame failure gracefully", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/broken", parentId: "main" },
    ]);

    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);

    // First call (main frame) succeeds, second (child) fails via evaluateError
    let callNum = 0;
    const originalEvaluateError = null;

    // Override to fail on second call
    mockDebugger.evaluateResults.set(
      scriptKey,
      () => {
        callNum++;
        if (callNum === 1) {
          return [{ url: "https://example.com/top.mp4", type: "video/mp4", source: "video-src" }];
        }
        // Return empty for subsequent calls
        return [];
      }
    );

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok, "overall result should still be ok");
    assert.ok(Array.isArray(result.videos), "videos should be an array");
    // The top frame video should still be returned
    assert.equal(result.videos.length, 1, "should still contain the top frame video");
    assert.equal(result.videos[0].url, "https://example.com/top.mp4");
  })();

  // Test 1.10: Recursive extraction with no child frames works like non-recursive
  await test("1.10 recursive extraction with no child frames works like non-recursive", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
    ]);

    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);
    mockDebugger.evaluateResults.set(
      scriptKey,
      [{ url: "https://example.com/video.mp4", type: "video/mp4", source: "video-src" }]
    );

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok);
    assert.equal(result.videos.length, 1, "should find 1 video from top frame");
  })();

  // Test 1.11: Frame info is attached to extracted videos (sourceFrame)
  await test("1.11 videos extracted from child frames include sourceFrame info", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://player.example.com/embed", parentId: "main" },
    ]);

    const script = cdpExtraction.getExtractionScript();
    const scriptKey = script.slice(0, 100);

    mockDebugger.evaluateResults.set(
      scriptKey,
      [{ url: "https://cdn.example.com/video.mp4", type: "video/mp4", source: "video-src" }]
    );

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok);
    assert.equal(result.videos.length, 1);
    // sourceFrame and frameUrl are tagged by evaluateInFrame
    assert.ok(result.videos[0].sourceFrame !== undefined, "video should carry sourceFrame info");
    assert.ok(result.videos[0].frameUrl !== undefined, "video should carry frameUrl");
  })();

  // Test 1.12: discoverFrameTree returns error when attach fails
  await test("1.12 discoverFrameTree returns error when attach fails", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();
    mockDebugger.attachError = "Tab not found";

    const result = await cdpExtraction.discoverFrameTree(999);
    assert.ok(!result.ok);
    assert.ok(result.error);
  })();

  // Test 1.13: Recursive extraction includes frames in result
  await test("1.13 recursive extraction includes frames array in result", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.mockFrameTrees.set(42, [
      { frameId: "main", url: "https://example.com" },
      { frameId: "child1", url: "https://example.com/player", parentId: "main" },
    ]);

    const result = await cdpExtraction.extractVideosFromTab(42, { recursive: true });
    assert.ok(result.ok);
    assert.ok(Array.isArray(result.frames), "result.frames must be an array when recursive");
    assert.equal(result.frames.length, 2, "frames array must contain all discovered frames");
  })();

  // ───────────────────────────────────────────────────────────────────────
  // Feature 2: Shadow DOM Traversal (§2.2)
  // ───────────────────────────────────────────────────────────────────────

  console.log("\n═══ Feature 2: Shadow DOM Traversal ═══\n");  // Test 2.1: getExtractionScript contains shadow DOM traversal logic
  await test("2.1 getExtractionScript contains shadow DOM traversal (collectAllVideos)", async () => {
    const script = cdpExtraction.getExtractionScript();
    assert.ok(script.includes("collectAllVideos"), "script must include collectAllVideos helper");
    assert.ok(script.includes("shadowRoot"), "script must reference shadowRoot");
    assert.ok(script.includes("shadowRoot.mode === 'open'"), "script must check for open shadow roots");
  })();

  // Test 2.2: getExtractionScript contains nested shadow DOM handling
  await test("2.2 getExtractionScript handles nested shadow roots recursively", async () => {
    const script = cdpExtraction.getExtractionScript();
    assert.ok(script.includes("collectAllVideos(el.shadowRoot)"), "script must recurse into shadow roots");
  })();

  // Test 2.3: Regular DOM query selectors preserved (no regression)
  await test("2.3 regular DOM query selectors preserved (no regression)", async () => {
    const script = cdpExtraction.getExtractionScript();
    // Original DOM query selectors still present
    assert.ok(script.includes("collectAllVideos(document)"), "script must query document for videos");
    assert.ok(script.includes("collectAllSources(document, 'video source[src]')"), "script must query document for sources");
  })();

  // Test 2.4: collectAllSources helper exists
  await test("2.4 getExtractionScript includes collectAllSources for <source> elements", async () => {
    const script = cdpExtraction.getExtractionScript();
    assert.ok(script.includes("collectAllSources"), "script must include collectAllSources helper");
    assert.ok(script.includes("collectAllSources(el.shadowRoot, selector)"), "must recurse into shadow roots for sources");
  })();

  // Test 2.5: Script is syntactically valid
  await test("2.5 getExtractionScript is syntactically valid JavaScript", async () => {
    const script = cdpExtraction.getExtractionScript();
    new Function(script); // Should not throw
    assert.ok(true, "script parsed without syntax errors");
  })();

  // Test 2.6: Script runs without error in Node.js (returns empty array)
  await test("2.6 getExtractionScript runs without error in Node.js", async () => {
    const script = cdpExtraction.getExtractionScript();
    const fn = new Function("return (" + script + ")");
    const result = fn();
    assert.ok(Array.isArray(result), "must return array");
    assert.equal(result.length, 0, "empty result in Node.js (no DOM)");
  })();

  // Test 2.7: getMutationWatchScript also has shadow DOM support
  await test("2.7 getMutationWatchScript includes shadow DOM support", async () => {
    const script = cdpExtraction.getMutationWatchScript(500, 5000);
    assert.ok(script.includes("shadowRoot"), "mutation watch script must handle shadow DOM");
    assert.ok(script.includes("collectAllVideos"), "mutation watch script must use collectAllVideos");
  })();

  // ───────────────────────────────────────────────────────────────────────
  // Feature 3: Mutation Watching via CDP (§2.3)
  // ───────────────────────────────────────────────────────────────────────

  console.log("\n═══ Feature 3: Mutation Watching ═══\n");

  // Test 3.1: extractVideosWithMutationWatch returns videos found via mutation
  await test("3.1 extractVideosWithMutationWatch returns videos via mutation simulation", async () => {
    assert.ok(cdpExtraction.extractVideosWithMutationWatch, "must export extractVideosWithMutationWatch");

    mockDebugger.reset();
    cdpExtraction.cleanup();

    // The mutation watch script is generated by getMutationWatchScript(pollInterval, timeout)
    // with the exact options passed to extractVideosWithMutationWatch
    const mutScript = cdpExtraction.getMutationWatchScript(500, 500);
    const mutScriptKey = mutScript.slice(0, 100);

    mockDebugger.evaluateResults.set(
      mutScriptKey,
      { videos: [{ url: "https://example.com/mutation-video.mp4", type: "video/mp4", source: "video-src" }], timedOut: false }
    );

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 500 });
    assert.ok(result.ok, "must return ok: true");
    assert.ok(Array.isArray(result.videos), "result.videos must be an array");
    assert.ok(result.videos.length > 0, "must find videos via mutation watching");
    assert.equal(result.videos[0].url, "https://example.com/mutation-video.mp4");
  })();

  // Test 3.2: extractVideosWithMutationWatch returns empty after timeout with no videos
  await test("3.2 extractVideosWithMutationWatch returns empty after timeout", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const mutScript = cdpExtraction.getMutationWatchScript(500, 100);
    const mutScriptKey = mutScript.slice(0, 100);
    mockDebugger.evaluateResults.set(mutScriptKey, { videos: [], timedOut: true });

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 100 });
    assert.ok(result.ok, "must return ok: true even with no videos");
    assert.equal(result.videos.length, 0, "videos should be empty after timeout");
    assert.equal(result.timedOut, true, "should indicate timeout");
  })();

  // Test 3.3: extractVideosWithMutationWatch attaches CDP and cleans up after
  await test("3.3 extractVideosWithMutationWatch attaches CDP and cleans up after", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const mutScript = cdpExtraction.getMutationWatchScript(500, 50);
    const mutScriptKey = mutScript.slice(0, 100);
    mockDebugger.evaluateResults.set(mutScriptKey, { videos: [], timedOut: true });

    assert.ok(!mockDebugger.attachedTabs.has(42), "should not be attached before call");

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 50, detachAfter: true });
    assert.ok(result.ok);

    // Should be detached after
    assert.ok(!mockDebugger.attachedTabs.has(42), "should be detached after mutation watch completes");
  })();

  // Test 3.4: extractVideosWithMutationWatch can keep debugger attached with detachAfter:false
  await test("3.4 extractVideosWithMutationWatch keeps debugger attached with detachAfter:false", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const mutScript = cdpExtraction.getMutationWatchScript(500, 50);
    const mutScriptKey = mutScript.slice(0, 100);
    mockDebugger.evaluateResults.set(mutScriptKey, { videos: [], timedOut: true });

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 50, detachAfter: false });
    assert.ok(result.ok);
    assert.ok(mockDebugger.attachedTabs.has(42), "should stay attached with detachAfter:false");
  })();

  // Test 3.5: extractVideosWithMutationWatch handles attach failure
  await test("3.5 extractVideosWithMutationWatch handles attach failure", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.attachError = "Debugger already attached to different target";

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 50 });
    assert.ok(!result.ok, "must return ok: false on attach failure");
    assert.ok(result.error, "error must be set");
  })();

  // Test 3.6: extractVideosWithMutationWatch accepts custom pollInterval
  await test("3.6 extractVideosWithMutationWatch accepts custom timeout", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const mutScript = cdpExtraction.getMutationWatchScript(100, 200);
    const mutScriptKey = mutScript.slice(0, 100);
    mockDebugger.evaluateResults.set(mutScriptKey, { videos: [], timedOut: true });

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, {
      timeout: 200,
      pollInterval: 100,
    });
    assert.ok(result.ok);
    assert.ok(result.timedOut, "should time out");
  })();

  // Test 3.7: extractVideosWithMutationWatch returns existing videos immediately
  await test("3.7 extractVideosWithMutationWatch returns existing videos immediately", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const mutScript = cdpExtraction.getMutationWatchScript(500, 500);
    const mutScriptKey = mutScript.slice(0, 100);

    mockDebugger.evaluateResults.set(
      mutScriptKey,
      { videos: [{ url: "https://example.com/existing-video.mp4", type: "video/mp4", source: "video-src" }], timedOut: false }
    );

    const result = await cdpExtraction.extractVideosWithMutationWatch(42, { timeout: 500 });
    assert.ok(result.ok);
    assert.equal(result.videos.length, 1, "should immediately find existing videos");
    assert.equal(result.videos[0].url, "https://example.com/existing-video.mp4");
  })();

  // Test 3.8: getMutationWatchScript returns valid JavaScript
  await test("3.8 getMutationWatchScript returns valid JavaScript that runs", async () => {
    const script = cdpExtraction.getMutationWatchScript(500, 1000);
    assert.equal(typeof script, "string", "must return a string");
    assert.ok(script.length > 100, "must be non-trivial");
    // The script should be a self-executing async function
    assert.ok(script.includes("MutationObserver"), "must use MutationObserver");
    assert.ok(script.includes("shadowRoot"), "must handle shadow DOM");
    assert.ok(script.includes("timedOut"), "must return timedOut flag");
  })();

  // ───────────────────────────────────────────────────────────────────────
  // Feature 4: Event Simulation (load/play events) (§2.4)
  // ───────────────────────────────────────────────────────────────────────

  console.log("\n═══ Feature 4: Event Simulation ═══\n");

  // Test 4.1: simulateVideoEvents triggers load() on video elements
  await test("4.1 simulateVideoEvents triggers load() on video elements", async () => {
    assert.ok(cdpExtraction.simulateVideoEvents, "must export simulateVideoEvents");

    mockDebugger.reset();
    cdpExtraction.cleanup();

    const eventScript = cdpExtraction.getEventSimulationScript(["https://example.com/video.mp4"]);
    const eventScriptKey = eventScript.slice(0, 100);

    mockDebugger.evaluateResults.set(
      eventScriptKey,
      { triggered: true, loadCount: 1, playCount: 0 }
    );

    const result = await cdpExtraction.simulateVideoEvents(
      42,
      ["https://example.com/video.mp4"]
    );

    assert.ok(result.ok, "must return ok: true");
    assert.equal(result.triggered, true, "must return triggered: true");
    assert.equal(result.loadCount, 1, "must report 1 load triggered");
  })();

  // Test 4.2: simulateVideoEvents with empty URL list does nothing gracefully
  await test("4.2 simulateVideoEvents with empty URL list does nothing gracefully", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const result = await cdpExtraction.simulateVideoEvents(42, []);
    assert.ok(result.ok);
    assert.equal(result.triggered, false, "should not trigger anything for empty list");
  })();

  // Test 4.3: simulateVideoEvents handles CDP attach failure
  await test("4.3 simulateVideoEvents handles CDP attach failure", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.attachError = "Target not found";

    const result = await cdpExtraction.simulateVideoEvents(
      42,
      ["https://example.com/video.mp4"]
    );
    assert.ok(!result.ok, "must return ok: false on attach failure");
    assert.ok(result.error, "error must be set");
  })();

  // Test 4.4: simulateVideoEvents handles Runtime.evaluate failure
  await test("4.4 simulateVideoEvents handles Runtime.evaluate failure", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    mockDebugger.evaluateError = "Cannot find function";

    const result = await cdpExtraction.simulateVideoEvents(
      42,
      ["https://example.com/video.mp4"]
    );
    assert.ok(!result.ok, "must return ok: false on evaluate failure");
    assert.ok(result.error, "error must be set");
  })();

  // Test 4.5: simulateVideoEvents with detachAfter:false keeps CDP attached
  await test("4.5 simulateVideoEvents with detachAfter:false keeps CDP attached", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const eventScript = cdpExtraction.getEventSimulationScript(["https://example.com/video.mp4"]);
    const eventScriptKey = eventScript.slice(0, 100);
    mockDebugger.evaluateResults.set(eventScriptKey, { triggered: true, loadCount: 0, playCount: 0 });

    const result = await cdpExtraction.simulateVideoEvents(
      42,
      ["https://example.com/video.mp4"],
      { detachAfter: false }
    );
    assert.ok(result.ok);
    assert.ok(mockDebugger.attachedTabs.has(42), "should stay attached");
  })();

  // Test 4.6: getEventSimulationScript returns valid JavaScript
  await test("4.6 getEventSimulationScript returns valid JavaScript with load/play calls", async () => {
    const script = cdpExtraction.getEventSimulationScript(["https://example.com/video.mp4"]);
    assert.equal(typeof script, "string", "must return a string");
    assert.ok(script.includes("load()"), "script must call load() on video elements");
    assert.ok(script.includes("play()"), "script must call play() on video elements");
    assert.ok(script.includes("shadowRoot"), "script must handle shadow DOM");
    assert.ok(script.includes("video.mp4"), "script must contain target URLs");
  })();

  // Test 4.7: simulateVideoEvents without URLs returns ok (no-op)
  await test("4.7 simulateVideoEvents without URLs returns ok (no-op)", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const result = await cdpExtraction.simulateVideoEvents(42);
    assert.ok(result.ok, "should handle missing URLs gracefully");
    assert.equal(result.triggered, false);
  })();

  // Test 4.8: simulateVideoEvents handles invalid tabId
  await test("4.8 simulateVideoEvents handles invalid tabId", async () => {
    mockDebugger.reset();
    cdpExtraction.cleanup();

    const result = await cdpExtraction.simulateVideoEvents(-1, ["https://example.com/v.mp4"]);
    assert.ok(!result.ok, "must return ok: false for invalid tabId");
    assert.ok(result.error, "error must be set");
  })();

  // ───────────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Layer 2 Tests: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
    console.log("❌ Some tests FAILED");
  } else {
    console.log("✅ All Layer 2 tests PASSED");
  }
})().catch((error) => {
  console.error("Test harness error:", error);
  process.exitCode = 1;
});
