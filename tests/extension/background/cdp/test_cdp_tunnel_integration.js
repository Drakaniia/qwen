"use strict";
import assert from "node:assert/strict";

/**
 * Test: CDP Tunnel Integration in Download Orchestration
 *
 * Tests that the CDP tunnel fallback is properly integrated into
 * the download orchestration fallback chain.
 */

(async () => {
  // ── Load the module (fails in RED phase, passes in GREEN) ───────────
  let integration;
  try {
    integration = await import("../../../src/background/cdp_tunnel_integration.js");
  } catch (e) {
    console.error("FAIL: Module not found (expected — RED phase):", e.message);
    process.exit(1);
  }

  // ── Test 1: Module exports tryCdpTunnelDownload function ────────────
  assert.equal(typeof integration.tryCdpTunnelDownload, "function", "tryCdpTunnelDownload should be a function");

  // ── Test 2: Module exports buildNativeWriteDataMessage function ────
  assert.equal(
    typeof integration.buildNativeWriteDataMessage,
    "function",
    "buildNativeWriteDataMessage should be a function",
  );

  // ── Test 3: buildNativeWriteDataMessage generates correct structure ─
  const writeCmd = integration.buildNativeWriteDataMessage(
    "test-id",
    "aGVsbG8=", // base64 "hello"
    "C:\\Downloads\\segment_001.ts",
  );
  assert.equal(writeCmd.type, "writeData", "Message type should be writeData");
  assert.equal(writeCmd.id, "test-id", "Message id should match");
  assert.equal(writeCmd.data, "aGVsbG8=", "Message data should match");
  assert.equal(writeCmd.outputPath, "C:\\Downloads\\segment_001.ts", "Message outputPath should match");

  // ── Test 4: tryCdpTunnelDownload handles missing chrome APIs ───────
  const result = await integration.tryCdpTunnelDownload(9999, "https://example.com/video.mp4", { timeout: 100 });
  assert.equal(result.ok, false, "tryCdpTunnelDownload should return ok: false without chrome.debugger");
  assert.ok(result.error && result.error.length > 0, "tryCdpTunnelDownload should return an error message");
  assert.equal(result.method, "segment", "method should be 'segment' for direct URL");

  // ── Test 5: Stream format uses manifest method ──────────────────────
  const streamResult = await integration.tryCdpTunnelDownload(9999, "https://example.com/stream.m3u8", {
    timeout: 100,
    format: "M3U8",
  });
  assert.equal(streamResult.ok, false, "should fail without chrome APIs");
  assert.equal(streamResult.method, "manifest", "method should be 'manifest' for stream format");

  console.log("PASS: All CDP tunnel integration tests passed.");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
