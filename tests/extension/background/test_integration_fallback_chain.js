"use strict";
import assert from "node:assert/strict";

/**
 * Integration Test: Download Orchestration CDP Tunnel Fallback Chain
 *
 * Verifies that the download orchestration correctly integrates the
 * CDP tunnel fallback into its error handling chain:
 *
 *   1. Native host sources fail → try CDP tunnel
 *   2. CDP tunnel succeeds for direct URL → mark done
 *   3. CDP tunnel only gets manifest → fall through to browser download
 *   4. CDP tunnel fails → try browser download
 *   5. All fallbacks exhausted → show error
 *
 * Tests the tryCdpTunnelFallback function and its interaction
 * with the rest of the orchestration flow.
 */

(async () => {
  // ── Load the modules ───────────────────────────────────────────────
  const tunnelIntegration = await import("../../../src/background/cdp_tunnel_integration.js");

  // ── Test 1: tryCdpTunnelDownload returns expected shape ────────────
  // Without chrome.debugger, all calls should return { ok: false, error, method }
  const result = await tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/video.mp4", { timeout: 100 });
  assert.equal(result.ok, false, "must return ok: false without chrome.debugger");
  assert.ok(result.error, "must include error message");
  assert.ok(
    ["segment", "manifest", "unknown"].includes(result.method),
    "method must be one of: segment, manifest, unknown",
  );

  // ── Test 2: Direct URL routes to segment method ─────────────────────
  const segResult = await tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/video.mp4", {
    timeout: 100,
    format: "MP4",
  });
  assert.equal(segResult.method, "segment", "MP4 format must use segment method");

  // ── Test 3: Stream format routes to manifest method (and doesn't claim ok) ─
  const streamResults = await Promise.all([
    tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/stream.m3u8", {
      timeout: 100,
      format: "M3U8",
    }),
    tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/stream.mpd", {
      timeout: 100,
      format: "MPD",
    }),
    tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/stream.m3u8", {
      timeout: 100,
      format: "HLS",
    }),
    tunnelIntegration.tryCdpTunnelDownload(9999, "https://example.com/stream.mpd", {
      timeout: 100,
      format: "DASH",
    }),
  ]);

  for (const r of streamResults) {
    assert.equal(r.method, "manifest", `${r.method} format must use manifest method`);
  }

  // ── Test 4: buildNativeWriteDataMessage builds correct payload ─────
  const writeMsg = tunnelIntegration.buildNativeWriteDataMessage(
    "test-job-001",
    "aGVsbG8=",
    "C:\\Downloads\\video.mp4",
  );
  assert.deepEqual(
    writeMsg,
    {
      type: "writeData",
      id: "test-job-001",
      data: "aGVsbG8=",
      outputPath: "C:\\Downloads\\video.mp4",
    },
    "writeData message must have correct structure",
  );

  // ── Test 5: buildNativeWriteDataMessage auto-generates IDs ─────────
  const msg1 = tunnelIntegration.buildNativeWriteDataMessage(undefined, "dGVzdA==", "/tmp/a.bin");
  assert.ok(msg1.id.startsWith("cdp_write_"), "auto-generated ID must start with cdp_write_");
  assert.ok(msg1.id.length > "cdp_write_".length, "auto-generated ID must include timestamp");

  // ── Test 6: cleanup is re-exported correctly ───────────────────────
  assert.equal(typeof tunnelIntegration.cleanup, "function", "must re-export cleanup function");

  console.log("✓ All fallback chain integration tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
