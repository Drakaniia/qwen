"use strict";
import assert from "node:assert/strict";

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

  // Test attach to bogus tab returns error (no chrome API in Node)
  const result = await helpers.attach(9999);
  assert.ok(!result.ok, "attach to invalid tab should return ok: false");
  assert.ok(result.error, "should include error message");

  console.log("✓ All cdp_helpers tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
