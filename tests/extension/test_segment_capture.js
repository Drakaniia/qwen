// @ts-check
"use strict";

/**
 * Tests for the segment capture pipeline (Phase 1c).
 *
 * Verifies:
 * 1. Module exports expected interface
 * 2. startCapture(tabId) initializes capture state and sends init to content script
 * 3. stopCapture(tabId) collects segments, sends to native host, cleans up
 * 4. getCaptureStatus(tabId) returns segment counts per stream
 * 5. capture lifecycle events (start → accumulate → stop → cleanup)
 * 6. Error handling when tab doesn't exist
 */

import assert from "node:assert/strict";

// ─── Mock chrome API ───────────────────────────────────────────────────────

const mockTabs = {
  sendMessageCalls: [],
  sendMessageResult: { ok: true },
  sendMessageError: null,
  queryResult: [{ id: 42, url: "https://example.test/video-page" }],

  // browser_api.js uses callback pattern for Chrome
  sendMessage(tabId, message, callback) {
    this.sendMessageCalls.push(message);
    if (this.sendMessageError) {
      if (callback) callback(null);
      return;
    }
    if (callback) callback(this.sendMessageResult);
  },

  async query() {
    return this.queryResult;
  },

  reset() {
    this.sendMessageCalls = [];
    this.sendMessageResult = { ok: true };
    this.sendMessageError = null;
    this.queryResult = [{ id: 42, url: "https://example.test/video-page" }];
  },
};

const mockRuntime = {
  lastError: null,
  sendMessageCalls: [],
  sendMessageResult: null,

  // browser_api.js uses callback pattern for Chrome
  sendMessage(message, callback) {
    this.sendMessageCalls.push(message);
    const result = this.sendMessageResult || { ok: true };
    if (callback) callback(result);
  },

  reset() {
    this.lastError = null;
    this.sendMessageCalls = [];
    this.sendMessageResult = null;
  },
};

const mockNativePort = {
  postMessageCalls: [],
  onMessageListeners: [],
  onDisconnectListeners: [],

  postMessage(message) {
    this.postMessageCalls.push(message);
  },

  disconnect() {},

  reset() {
    this.postMessageCalls = [];
    this.onMessageListeners = [];
    this.onDisconnectListeners = [];
  },
};

// Set up global chrome mock
globalThis.chrome = {
  runtime: mockRuntime,
  tabs: mockTabs,
};

// ─── Import the module ──────────────────────────────────────────────────────

let segmentCapture;
try {
  segmentCapture = await import("../../src/background/segment_capture.js");
} catch (err) {
  console.warn("Could not import segment_capture.js directly:", err.message);
}

// ─── Test helpers ──────────────────────────────────────────────────────────

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createMockSegment(streamId, index, data = "dGVzdF9zZWdtZW50") {
  return {
    streamId,
    mimeType: 'video/mp4; codecs="avc1.64001E"',
    data,
    index,
    timestamp: index * 2,
    isLast: false,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

(async () => {
  // ─── Test 1: Module exports correct interface ─────────────────────────────

  {
    assert.ok(segmentCapture, "segment_capture module should be importable");
    assert.equal(typeof segmentCapture.startCapture, "function", "must export startCapture(tabId)");
    assert.equal(typeof segmentCapture.stopCapture, "function", "must export stopCapture(tabId)");
    assert.equal(typeof segmentCapture.getStatus, "function", "must export getStatus(tabId)");
    assert.equal(typeof segmentCapture.stopAll, "function", "must export stopAll()");
    assert.equal(typeof segmentCapture.addSegments, "function", "must export addSegments(tabId, segments)");
    console.log("✓ Test 1: Module exports correct interface");
  }

  // ─── Test 2: startCapture initializes capture state and sends init msg ────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    const result = await segmentCapture.startCapture(42, {
      title: "Test video",
      url: "https://example.test/video.mp4",
    });

    assert.ok(result.ok, "startCapture must return ok: true");
    assert.equal(result.tabId, 42, "must return tabId");

    // Should have sent a message to the content script to initialize MSE capture
    assert.ok(mockTabs.sendMessageCalls.length >= 1, "must send at least one message to content script");
    const initMsg = mockTabs.sendMessageCalls[0];
    assert.equal(initMsg.type, "mseInitCapture", "first message must be mseInitCapture");
    assert.equal(initMsg.tabId, 42, "mseInitCapture must include tabId");

    // Check that capture state is active
    const status = segmentCapture.getStatus(42);
    assert.ok(status.active, "capture must be active after startCapture");
    assert.equal(status.tabId, 42, "status must report correct tabId");
    assert.equal(status.segmentCount, 0, "no segments captured yet");

    console.log("✓ Test 2: startCapture initializes capture state and sends init message");
  }

  // ─── Test 3: addSegments accumulates captured segments ───────────────────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    await segmentCapture.startCapture(42, { title: "Test video" });

    // Add some segments
    const segments = [
      createMockSegment("stream_1", 0, "c2VnbWVudF8w"),
      createMockSegment("stream_1", 1, "c2VnbWVudF8x"),
      createMockSegment("stream_1", 2, "c2VnbWVudF8y"),
      createMockSegment("stream_2", 0, "YXVkaW9fMA=="),
    ];

    const addResult = segmentCapture.addSegments(42, segments);
    assert.ok(addResult.ok, "addSegments must return ok: true");

    const status = segmentCapture.getStatus(42);
    assert.equal(status.segmentCount, 4, "must report 4 segments");
    assert.equal(status.streamCount, 2, "must report 2 streams");
    assert.equal(status.streams["stream_1"], 3, "stream_1 must have 3 segments");
    assert.equal(status.streams["stream_2"], 1, "stream_2 must have 1 segment");

    console.log("✓ Test 3: addSegments accumulates captured segments");
  }

  // ─── Test 4: stopCapture collects segments and sends to native host ───────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    // Mock nativeRequest for the assembleSegments call
    mockRuntime.sendMessageResult = {
      ok: true,
      jobId: "seg_assembly_001",
      filepath: "C:\\Videos\\assembled_video.mp4",
    };

    await segmentCapture.startCapture(42, { title: "Test video" });

    const segments = [
      createMockSegment("stream_1", 0, "c2VnbWVudF8w"),
      createMockSegment("stream_1", 1, "c2VnbWVudF8x"),
    ];
    segmentCapture.addSegments(42, segments);

    const stopResult = await segmentCapture.stopCapture(42);
    assert.ok(stopResult.ok, "stopCapture must return ok: true");
    assert.ok(stopResult.jobId, "stopCapture must return a jobId");
    assert.equal(stopResult.segmentCount, 2, "stopCapture must report segment count");

    // Should have sent an assembleSegments message to native host
    const assembleMsg = mockRuntime.sendMessageCalls.find((m) => m.type === "assembleSegments");
    assert.ok(assembleMsg, "must send an assembleSegments message to native host");
    assert.equal(assembleMsg.tabId, 42, "assembleSegments must include tabId");
    assert.equal(assembleMsg.title, "Test video", "assembleSegments must include title");
    assert.ok(Array.isArray(assembleMsg.segments), "assembleSegments must include segments array");
    assert.equal(assembleMsg.segments.length, 2, "assembleSegments must include all segments");

    // Capture state should be cleaned up after stop
    const status = segmentCapture.getStatus(42);
    assert.ok(!status.active, "capture must be inactive after stopCapture");

    console.log("✓ Test 4: stopCapture collects segments and sends to native host");
  }

  // ─── Test 5: stopCapture without segments returns early ───────────────────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    await segmentCapture.startCapture(42, { title: "Empty capture" });

    const stopResult = await segmentCapture.stopCapture(42);
    assert.ok(stopResult.ok, "stopCapture with no segments must return ok: true");
    assert.equal(stopResult.segmentCount, 0, "stopCapture must report 0 segments");
    assert.equal(stopResult.jobId, "", "stopCapture with no segments must not create a job");

    // Should NOT have sent assembleSegments message
    const assembleMsg = mockRuntime.sendMessageCalls.find((m) => m.type === "assembleSegments");
    assert.ok(!assembleMsg, "stopCapture with no segments must not send assembleSegments");

    console.log("✓ Test 5: stopCapture without segments returns early");
  }

  // ─── Test 6: getStatus returns inactive state for unknown tab ────────────

  {
    segmentCapture.stopAll();

    const status = segmentCapture.getStatus(999);
    assert.ok(!status.active, "unknown tab must report inactive");
    assert.equal(status.segmentCount, 0, "unknown tab must report 0 segments");

    console.log("✓ Test 6: getStatus returns inactive state for unknown tab");
  }

  // ─── Test 7: startCapture on already-capturing tab returns error ──────────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    await segmentCapture.startCapture(42, {});
    const second = await segmentCapture.startCapture(42, {});
    assert.ok(!second.ok, "second startCapture on same tab must return ok: false");
    assert.ok(second.error, "must include error message for duplicate start");

    console.log("✓ Test 7: startCapture on already-capturing tab returns error");
  }

  // ─── Test 8: stopAll cleans up all active captures ────────────────────────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    await segmentCapture.startCapture(42, {});
    await segmentCapture.startCapture(99, {});

    const seg42 = [createMockSegment("s1", 0)];
    const seg99 = [createMockSegment("s2", 0)];
    segmentCapture.addSegments(42, seg42);
    segmentCapture.addSegments(99, seg99);

    assert.ok(segmentCapture.getStatus(42).active, "tab 42 should be active");
    assert.ok(segmentCapture.getStatus(99).active, "tab 99 should be active");

    segmentCapture.stopAll();

    assert.ok(!segmentCapture.getStatus(42).active, "tab 42 should be inactive after stopAll");
    assert.ok(!segmentCapture.getStatus(99).active, "tab 99 should be inactive after stopAll");

    console.log("✓ Test 8: stopAll cleans up all active captures");
  }

  // ─── Test 9: addSegments to non-capturing tab returns error ──────────────

  {
    segmentCapture.stopAll();

    const result = segmentCapture.addSegments(999, [createMockSegment("s1", 0)]);
    assert.ok(!result.ok, "addSegments to non-capturing tab must return ok: false");
    assert.ok(result.error, "must include error message");

    console.log("✓ Test 9: addSegments to non-capturing tab returns error");
  }

  // ─── Test 10: Captured segments metadata is preserved ─────────────────────

  {
    mockTabs.reset();
    mockRuntime.reset();
    segmentCapture.stopAll();

    await segmentCapture.startCapture(42, {});

    const segments = [
      {
        streamId: "video",
        mimeType: 'video/mp4; codecs="avc1"',
        data: "dmlkZW8w",
        index: 0,
        timestamp: 0,
        isLast: false,
      },
      {
        streamId: "video",
        mimeType: 'video/mp4; codecs="avc1"',
        data: "dmlkZW8x",
        index: 1,
        timestamp: 2,
        isLast: false,
      },
      {
        streamId: "video",
        mimeType: 'video/mp4; codecs="avc1"',
        data: "dmlkZW8y",
        index: 2,
        timestamp: 4,
        isLast: true,
      },
    ];

    segmentCapture.addSegments(42, segments);

    const status = segmentCapture.getStatus(42);
    assert.equal(status.segmentCount, 3, "must report 3 segments");

    // Stop and verify the data is forwarded
    mockRuntime.sendMessageResult = { ok: true, jobId: "seg_job" };
    const stopResult = await segmentCapture.stopCapture(42);

    const assembleMsg = mockRuntime.sendMessageCalls.find((m) => m.type === "assembleSegments");
    assert.ok(assembleMsg, "assembleSegments must be called");
    assert.equal(assembleMsg.segments.length, 3, "all 3 segments must be forwarded");

    // Check that metadata is preserved in each segment
    for (let i = 0; i < 3; i++) {
      assert.equal(assembleMsg.segments[i].streamId, segments[i].streamId, `segment ${i} streamId must match`);
      assert.equal(assembleMsg.segments[i].mimeType, segments[i].mimeType, `segment ${i} mimeType must match`);
      assert.equal(assembleMsg.segments[i].index, segments[i].index, `segment ${i} index must match`);
    }

    // Last segment should be flagged
    const lastSeg = assembleMsg.segments[2];
    assert.ok(lastSeg.isLast, "last segment must be flagged as isLast");

    console.log("✓ Test 10: Captured segments metadata is preserved through stopCapture");
  }

  console.log("\nAll segment capture pipeline tests passed ✓");
})().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
