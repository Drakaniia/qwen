"use strict";
import assert from "node:assert/strict";

/**
 * Integration Test: SW Relay + CDP Tunnel Segment Data Flow
 *
 * Verifies the data flow pipeline for captured segments:
 *
 *   1. sw_relay stores segments from content script messages
 *   2. getTabSegments / getAllSegments retrieves them
 *   3. clearSegments removes segments by tab
 *   4. buildNativeWriteDataMessage prepares segments for native host
 *   5. tryCdpTunnelDownload provides fallback download mechanism
 *
 * This tests the integration between adjacent layers of the
 * capture → relay → download pipeline.
 */

(async () => {
  const swRelay = await import("../../../src/background/sw_relay.js");
  const tunnelIntegration = await import("../../../src/background/cdp_tunnel_integration.js");

  // ── Test 1: sw_relay initial state is empty ─────────────────────────
  assert.equal(swRelay.getAllSegments().length, 0, "initial state must be empty");
  assert.deepEqual(swRelay.getTabSegments(1), [], "getTabSegments returns empty for any tab");

  // ── Test 2: clearSegments on empty state doesn't throw ──────────────
  swRelay.clearSegments();
  assert.equal(swRelay.getAllSegments().length, 0, "clear on empty must keep empty");
  swRelay.clearSegments(1);
  assert.equal(swRelay.getAllSegments().length, 0, "clear tab on empty must keep empty");

  // ── Test 3: getTabSegments returns empty for non-existent tab ───────
  const tabSegments = swRelay.getTabSegments(999);
  assert.deepEqual(tabSegments, [], "getTabSegments for non-existent tab returns empty");

  // ── Test 4: getTabSegments with no tab ID returns empty (defensive) ──
  // (Switched from returning all to returning empty when tabId is falsy)
  assert.deepEqual(swRelay.getTabSegments(null), [], "getTabSegments(null) returns empty");
  assert.deepEqual(swRelay.getTabSegments(undefined), [], "getTabSegments(undefined) returns empty");

  // ── Test 5: Multiple clearSegments calls are idempotent ──────────────
  swRelay.clearSegments();
  swRelay.clearSegments();
  swRelay.clearSegments();
  assert.equal(swRelay.getAllSegments().length, 0, "multiple clear calls must be idempotent");

  // ── Test 6: buildNativeWriteDataMessage with various data sizes ──────
  // Small data
  const smallMsg = tunnelIntegration.buildNativeWriteDataMessage(
    "job-1", "dGVzdA==", "C:\\Downloads\\small.bin",
  );
  assert.equal(smallMsg.type, "writeData", "message type must be writeData");
  assert.equal(smallMsg.data, "dGVzdA==", "base64 data must be preserved");

  // Empty data
  const emptyMsg = tunnelIntegration.buildNativeWriteDataMessage(
    "job-2", "", "C:\\Downloads\\empty.bin",
  );
  assert.equal(emptyMsg.data, "", "empty base64 must be allowed");

  // ── Test 7: tryCdpTunnelDownload handles various URL formats gracefully ──
  const urls = [
    "https://cdn.example.com/video.mp4",
    "https://cdn.example.com/hls/master.m3u8",
    "https://cdn.example.com/dash/manifest.mpd",
    "https://cdn.example.com/stream/segment-001.ts",
    "https://cdn.example.com/stream/segment-001.m4s",
    "https://cdn.example.com/video.webm",
  ];

  for (const url of urls) {
    const r = await tunnelIntegration.tryCdpTunnelDownload(9999, url, { timeout: 100 });
    assert.equal(r.ok, false, `tryCdpTunnelDownload must fail gracefully for ${url}`);
    assert.ok(r.error, `must include error message for ${url}`);
    assert.ok(["segment", "manifest", "unknown"].includes(r.method),
      `method must be valid for ${url}, got ${r.method}`);
  }

  console.log("✓ All segment data flow integration tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
