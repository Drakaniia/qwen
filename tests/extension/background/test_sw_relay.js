"use strict";
import assert from "node:assert/strict";

(async () => {
  const swRelay = await import("../../../src/background/sw_relay.js");

  // Verify initial state
  assert.equal(swRelay.getAllSegments().length, 0, "initial state should be empty");

  // Test clearSegments
  swRelay.clearSegments();
  assert.equal(swRelay.getAllSegments().length, 0, "after clear, segments should be empty");

  console.log("✓ All sw_relay tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
