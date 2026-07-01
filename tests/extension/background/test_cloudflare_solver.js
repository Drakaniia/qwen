"use strict";
import assert from "node:assert/strict";

(async () => {
  const solver = await import("../../../src/background/cloudflare_solver.js");

  // Verify module exports
  assert.equal(typeof solver.detectAndSolveCloudflare, "function");
  assert.equal(typeof solver.openCloudflarePage, "function");
  assert.equal(typeof solver.waitForChallengeComplete, "function");
  assert.equal(typeof solver.extractCFClearance, "function");

  // Test that extractCFClearance gracefully handles missing cookies
  // (returns null without throwing)
  const result = await solver.extractCFClearance(9999); // bogus tab ID
  assert.equal(result, null, "Should return null for invalid tab without throwing");

  console.log("✓ All Cloudflare solver tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
