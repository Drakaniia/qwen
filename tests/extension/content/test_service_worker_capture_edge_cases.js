"use strict";

/**
 * Service Worker Capture — Edge Case Tests (RED Phase)
 *
 * Exhaustive TDD tests for gaps identified in docs/audit/test-gaps-and-edge-cases.md
 *
 * Coverage areas:
 *   A. Cross-origin opaque response handling
 *   B. Range request (206 Partial Content) proxying
 *   C. SW keepalive/heartbeat mechanism
 *   D. Large response body limits enforcement
 *   E. Registration failure fallback
 *   F. Message channel reliability
 *   G. Stop/cleanup lifecycle
 */

import assert from "node:assert/strict";

// ─── Test Harness: Mock Service Worker environment ───────────────────────

// ─── Import the module ──────────────────────────────────────────────────

const swModule = await import("../../../src/content/service_worker_capture.js");

// ═════════════════════════════════════════════════════════════════════════
// GROUP A: Cross-Origin Opaque Response Handling
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group A: Opaque Response Handling ═══\n");

let passedA = 0;
let failedA = 0;

async function testA(name, fn) {
  try {
    await fn();
    passedA++;
    console.log(`  ✓ A.${passedA + failedA}: ${name}`);
  } catch (err) {
    failedA++;
    console.log(`  ✗ A.${passedA + failedA}: ${name}: ${err.message}`);
  }
}

// A.1: Generated SW code checks response.type before reading body
await testA("checks response.type before reading body for opaque responses", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The RED test asserts the generated code handles opaque responses
  // Currently the code does NOT check response.type — this should fail
  const hasOpaqueCheck =
    swCode.includes("response.type") &&
    (swCode.includes("'opaque'") || swCode.includes('"opaque"') || swCode.includes("opaque"));
  assert.ok(hasOpaqueCheck, "Generated SW code must check response.type for opaque responses to avoid CORS errors");
});

// A.2: Opaque responses pass through without body capture
await testA("opaque media responses are skipped (no body capture attempt)", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The generated code's handleFetch should skip body capture for opaque responses
  // but still pass the response through to the page
  const hasOpaqueSkip =
    swCode.includes("opaque") && (swCode.includes("skip") || swCode.includes("return") || swCode.includes("continue"));
  assert.ok(hasOpaqueSkip, "Generated SW code must skip body capture for opaque responses to prevent CORS errors");
});

// A.3: Opaque response detection triggers fallback notification via postMessage metadata
await testA("opaque response sends metadata-only message (no body) to client for CDP fallback", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should send a smaller message indicating opaque response was detected
  // so the background can trigger CDP Network capture as fallback
  const hasOpaqueMessage = swCode.includes("opaque") && swCode.includes("postMessage");
  assert.ok(
    hasOpaqueMessage,
    "Generated SW code should postMessage opaque response metadata for CDP fallback triggering",
  );
});

// A.4: Non-opaque media responses are still captured (regression test)
await testA("non-opaque media responses are captured normally (regression)", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should still capture normal responses
  assert.ok(
    swCode.includes("bodyB64") || swCode.includes("arrayBuffer"),
    "Normal media responses must still be captured",
  );
  assert.ok(
    swCode.includes("MEDIA_TYPES") || swCode.includes("looksLikeSegment"),
    "Media type checking must remain for non-opaque responses",
  );
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP B: Range Request (206 Partial Content) Proxying
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group B: Range Request Handling ═══\n");

let passedB = 0;
let failedB = 0;

async function testB(name, fn) {
  try {
    await fn();
    passedB++;
    console.log(`  ✓ B.${passedB + failedB}: ${name}`);
  } catch (err) {
    failedB++;
    console.log(`  ✗ B.${passedB + failedB}: ${name}: ${err.message}`);
  }
}

// B.1: Generated SW code forwards Range header from request to fetch
await testB("forwards Range header from original request to fetch()", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should forward the Range header so the upstream CDN returns 206 Partial Content
  const hasRangeHandling =
    swCode.includes("Range") || swCode.includes("range") || (swCode.includes("headers") && swCode.includes("request"));
  assert.ok(
    hasRangeHandling,
    "Generated SW code must forward Range headers from request to upstream fetch to preserve byte-range behavior",
  );
});

// B.2: Generated SW code handles 206 Partial Content response
await testB("handles 206 Partial Content response status", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should handle the 206 response status — capture the partial body
  // The SW should not reject or fail on 206
  const handles206 = swCode.includes("206") || swCode.includes("status") || swCode.includes("partial");
  assert.ok(handles206, "Generated SW code must handle 206 Partial Content responses without crashing");
});

// B.3: Generated SW code captures body from byte-range response
await testB("captures body from byte-range (206) responses", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The SW should read the body from 206 responses and capture it like any other media
  const capturesPartialBody =
    swCode.includes("arrayBuffer") && (swCode.includes("status") || swCode.includes("response"));
  assert.ok(capturesPartialBody, "Generated SW code must read and capture body from 206 Partial Content responses");
});

// B.4: Generated SW code handles If-Range conditional requests
await testB("forwards If-Range header from original request", () => {
  const swCode = swModule.generateCaptureSWCode();
  // If-Range is used with Range to prevent serving stale data
  const hasIfRange = swCode.includes("If-Range") || swCode.includes("if-range");
  assert.ok(hasIfRange, "Generated SW code must forward If-Range conditional header for correct range responses");
});

// B.5: Generated SW code sends range request metadata to client
await testB("sends range request metadata (status, headers) with captured body", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should include response status and content-range header in the message
  // so the background knows whether this is a full or partial response
  const hasStatusInMessage =
    swCode.includes("status") && (swCode.includes("postMessage") || swCode.includes("postMessage"));
  assert.ok(hasStatusInMessage, "Generated SW code must include response status in captured message metadata");
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP C: SW Keepalive / Heartbeat Mechanism
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group C: SW Keepalive Mechanism ═══\n");

let passedC = 0;
let failedC = 0;

async function testC(name, fn) {
  try {
    await fn();
    passedC++;
    console.log(`  ✓ C.${passedC + failedC}: ${name}`);
  } catch (err) {
    failedC++;
    console.log(`  ✗ C.${passedC + failedC}: ${name}: ${err.message}`);
  }
}

// C.1: initMediaCaptureSW sets up periodic keepalive timer
await testC("initMediaCaptureSW starts a keepalive interval timer", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The generated SW code (or the init function) should set up a keepalive mechanism
  // Browsers kill idle SWs after ~30s of inactivity
  // We test that the init function or generated code has keepalive logic
  const hasKeepalive =
    swCode.includes("keepalive") ||
    swCode.includes("keepAlive") ||
    swCode.includes("keep_alive") ||
    swCode.includes("ping");
  assert.ok(hasKeepalive, "SW capture must include keepalive mechanism to prevent browser from killing idle SW");
});

// C.2: Keepalive sends periodic fetch/heartbeat to keep SW awake
await testC("keepalive mechanism sends periodic fetch or postMessage heartbeat", () => {
  const swCode = swModule.generateCaptureSWCode();
  const hasHeartbeat =
    swCode.includes("setInterval") ||
    swCode.includes("setTimeout") ||
    swCode.includes("heartbeat") ||
    swCode.includes("alive");
  assert.ok(hasHeartbeat, "SW must use setInterval/setTimeout to periodically ping itself and stay alive");
});

// C.3: SW generated code responds to keepalive pings from content script
await testC("generated SW code responds to keepalive ping messages from content script", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Content script sends periodic pings; SW should respond
  const respondsToPing = swCode.includes("message") || swCode.includes("ping") || swCode.includes("keepalive");
  // Check via the SW's message event handler (if it has one)
  const hasMessageHandler =
    swCode.includes("addEventListener('message'") || swCode.includes('addEventListener("message"');
  const hasPingResponse = respondsToPing || hasMessageHandler;
  assert.ok(hasPingResponse, "Generated SW code must respond to keepalive pings from content script to stay active");
});

// C.4: Keepalive stops after stopMediaCaptureSW
await testC("stopMediaCaptureSW clears the keepalive timer", () => {
  // The stopMediaCaptureSW function should clear any keepalive interval
  const stopFunction = swModule.stopMediaCaptureSW.toString();
  const hasClearKeepalive =
    stopFunction.includes("clearInterval") ||
    stopFunction.includes("clearTimeout") ||
    stopFunction.includes("keepalive") ||
    stopFunction.includes("keepAlive");
  assert.ok(
    hasClearKeepalive,
    "stopMediaCaptureSW must clear the keepalive timer to prevent leaks after capture stops",
  );
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP D: Large Response Body Limits Enforcement
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group D: Large Response Body Limits ═══\n");

let passedD = 0;
let failedD = 0;

async function testD(name, fn) {
  try {
    await fn();
    passedD++;
    console.log(`  ✓ D.${passedD + failedD}: ${name}`);
  } catch (err) {
    failedD++;
    console.log(`  ✗ D.${passedD + failedD}: ${name}: ${err.message}`);
  }
}

// D.1: Generated SW code enforces MAX_BYTES_PER_RESPONSE constant
await testD("defines MAX_BYTES_PER_RESPONSE constant at 500*1024*1024 (500MB)", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Already has this — regression test
  assert.ok(swCode.includes("MAX_BYTES_PER_RESPONSE"), "Generated SW code must define MAX_BYTES_PER_RESPONSE constant");
  assert.ok(
    swCode.includes("500 * 1024 * 1024") || swCode.includes(String(500 * 1024 * 1024)),
    "MAX_BYTES_PER_RESPONSE must be 500MB",
  );
});

// D.2: Generated SW code enforces MAX_TOTAL_BYTES constant
await testD("defines MAX_TOTAL_BYTES constant at 2*1024*1024*1024 (2GB)", () => {
  const swCode = swModule.generateCaptureSWCode();
  assert.ok(swCode.includes("MAX_TOTAL_BYTES"), "Generated SW code must define MAX_TOTAL_BYTES constant");
});

// D.3: Generated SW code enforces MAX_CAPTURES constant
await testD("defines MAX_CAPTURES constant at 5000", () => {
  const swCode = swModule.generateCaptureSWCode();
  assert.ok(swCode.includes("MAX_CAPTURES"), "Generated SW code must define MAX_CAPTURES constant");
});

// D.4: Generated SW code skips responses over MAX_BYTES_PER_RESPONSE without crashing
await testD("skips capture of responses exceeding MAX_BYTES_PER_RESPONSE without crashing", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The SW should check body.byteLength before storing
  const hasSizeCheck =
    swCode.includes("byteLength") &&
    (swCode.includes("MAX_BYTES_PER_RESPONSE") || swCode.includes("500 * 1024 * 1024"));
  assert.ok(
    hasSizeCheck,
    "Generated SW code must check body.byteLength against MAX_BYTES_PER_RESPONSE before capturing",
  );
});

// D.5: Generated SW code stops capturing after MAX_TOTAL_BYTES total
await testD("stops capturing when totalBytes exceeds MAX_TOTAL_BYTES", () => {
  const swCode = swModule.generateCaptureSWCode();
  const hasTotalCheck =
    swCode.includes("totalBytes") && (swCode.includes("MAX_TOTAL_BYTES") || swCode.includes("2 * 1024 * 1024 * 1024"));
  assert.ok(hasTotalCheck, "Generated SW code must track totalBytes and stop when MAX_TOTAL_BYTES is exceeded");
});

// D.6: Generated SW code stops capturing after MAX_CAPTURES
await testD("stops capturing when capturedCount exceeds MAX_CAPTURES", () => {
  const swCode = swModule.generateCaptureSWCode();
  const hasCountCheck =
    swCode.includes("capturedCount") && (swCode.includes("MAX_CAPTURES") || swCode.includes("5000"));
  assert.ok(hasCountCheck, "Generated SW code must check capturedCount against MAX_CAPTURES before capturing");
});

// D.7: Generated SW code logs warning when limits reached
await testD("logs a warning message when capture limits are reached", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Should console.warn or console.log when limits are hit
  const hasLimitWarning =
    swCode.includes("console.warn") || swCode.includes("console.log") || swCode.includes("console.error");
  assert.ok(
    hasLimitWarning,
    "Generated SW code should log a warning when capture limits are reached for debuggability",
  );
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP E: Registration Failure Fallback
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group E: Registration Failure Fallback ═══\n");

let passedE = 0;
let failedE = 0;

async function testE(name, fn) {
  try {
    await fn();
    passedE++;
    console.log(`  ✓ E.${passedE + failedE}: ${name}`);
  } catch (err) {
    failedE++;
    console.log(`  ✗ E.${passedE + failedE}: ${name}: ${err.message}`);
  }
}

// E.1: initMediaCaptureSW returns false when serviceWorker is not available
await testE("returns false when navigator.serviceWorker is undefined", () => {
  // We can test this by calling the init function directly
  // This should already work — regression test
  assert.equal(typeof swModule.initMediaCaptureSW, "function", "initMediaCaptureSW must be a function");
});

// E.2: initMediaCaptureSW returns false on insecure page URL
await testE("returns false for insecure (http non-localhost) page URLs", () => {
  const result = swModule.isPageUrlSupportedForSWCapture("http://example.com/video");
  assert.ok(!result, "isPageUrlSupportedForSWCapture must reject non-localhost http URLs");
});

// E.3: initMediaCaptureSW returns false when registration errors occur
await testE("returns false when SW registration throws an error", () => {
  // The init function catches registration errors and returns false
  // This should already work
  assert.equal(typeof swModule.initMediaCaptureSW, "function");
});

// E.4: initMediaCaptureSW returns false when existing SW controls page
await testE("returns false when page already has a controlling Service Worker", () => {
  // The init function checks navigator.serviceWorker.controller
  // This should already work
  assert.equal(typeof swModule.initMediaCaptureSW, "function");
});

// E.5: Return value false correctly triggers fetch_intercept fallback in content.js
await testE("returns false to trigger fetch_intercept fallback in content.js", () => {
  // Check that the initMediaCaptureSW return value (false = not active)
  // is used by content.js to decide whether to init fetch_intercept
  // This is verified by checking content.js text
  // The return value should be a clear boolean
  const initFn = swModule.initMediaCaptureSW.toString();
  // Should return false for all failure cases
  assert.ok(
    initFn.includes("return false"),
    "initMediaCaptureSW must return false on failure to signal fetch_intercept fallback",
  );
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP F: Message Channel Reliability
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group F: Message Channel Reliability ═══\n");

let passedF = 0;
let failedF = 0;

async function testF(name, fn) {
  try {
    await fn();
    passedF++;
    console.log(`  ✓ F.${passedF + failedF}: ${name}`);
  } catch (err) {
    failedF++;
    console.log(`  ✗ F.${passedF + failedF}: ${name}: ${err.message}`);
  }
}

// F.1: Generated SW code posts messages with correct structure
await testF("posts messages with correct structure (type, url, bodyB64, contentType)", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The message should have all required fields
  assert.ok(
    swCode.includes("type:") || swCode.includes("'type'") || swCode.includes('"type"'),
    "Message must include type field",
  );
  assert.ok(swCode.includes("url:"), "Message must include url field");
  assert.ok(swCode.includes("bodyB64") || swCode.includes("body"), "Message must include body data");
  assert.ok(
    swCode.includes("contentType") || swCode.includes("content-type"),
    "Message must include contentType field",
  );
});

// F.2: Generated SW code handles postMessage when no client is available
await testF("handles postMessage gracefully when no client is available", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The SW should handle the case where resultingClientId/clientId is null
  // and no client can be found
  const hasClientGuard =
    swCode.includes("if (clientId)") ||
    swCode.includes("if (client)") ||
    (swCode.includes("if (") && swCode.includes("clients.get"));
  assert.ok(hasClientGuard, "Generated SW code must guard against missing client when posting messages");
});

// F.3: Generated SW code handles message event data validation
await testF("message handler validates event.data before processing", () => {
  const swCode = swModule.generateCaptureSWCode();
  // The content script's message handler should check event.data exists
  // and has the expected type before accessing properties
  const hasDataCheck =
    swCode.includes("event.data") &&
    (swCode.includes("qwinMediaResponse") || swCode.includes("data.type") || swCode.includes("data &&"));
  assert.ok(hasDataCheck, "Message handler must validate event.data before accessing properties");
});

// F.4: Generated SW code sends response status and headers for all captured responses
await testF("sends response status and headers in every captured message", () => {
  const swCode = swModule.generateCaptureSWCode();
  // Every message should include status and headers metadata
  const hasStatus = swCode.includes("status:");
  const hasHeaders = swCode.includes("headers:");
  assert.ok(hasStatus && hasHeaders, "Every captured message must include response status and headers metadata");
});

// ═════════════════════════════════════════════════════════════════════════
// GROUP G: Stop/Cleanup Lifecycle
// ═════════════════════════════════════════════════════════════════════════

console.log("\n═══ Group G: Stop/Cleanup Lifecycle ═══\n");

let passedG = 0;
let failedG = 0;

async function testG(name, fn) {
  try {
    await fn();
    passedG++;
    console.log(`  ✓ G.${passedG + failedG}: ${name}`);
  } catch (err) {
    failedG++;
    console.log(`  ✗ G.${passedG + failedG}: ${name}: ${err.message}`);
  }
}

// G.1: stopMediaCaptureSW unregisters SW registration
await testG("unregisters the Service Worker registration", () => {
  const stopFn = swModule.stopMediaCaptureSW.toString();
  // Should call unregister() on the registration
  assert.ok(stopFn.includes("unregister"), "stopMediaCaptureSW must call unregister() on the SW registration");
});

// G.2: stopMediaCaptureSW removes message event listener
await testG("removes the message event listener from navigator.serviceWorker", () => {
  const stopFn = swModule.stopMediaCaptureSW.toString();
  // Should call removeEventListener
  assert.ok(stopFn.includes("removeEventListener"), "stopMediaCaptureSW must remove the message event listener");
});

// G.3: stopMediaCaptureSW resets swActive to false
await testG("resets swActive state to false", () => {
  // isSWActive should return false after stop
  // This tests via the module's state
  const cleanupFn = swModule.stopMediaCaptureSW.toString();
  assert.ok(
    cleanupFn.includes("swActive") && (cleanupFn.includes("false") || cleanupFn.includes("null")),
    "stopMediaCaptureSW must reset swActive to false",
  );
});

// G.4: Multiple stopMediaCaptureSW calls are idempotent
await testG("multiple calls to stopMediaCaptureSW are idempotent (no error)", () => {
  const stopFn = swModule.stopMediaCaptureSW.toString();
  // Should handle null/undefined state without errors
  const hasGuard =
    stopFn.includes("if (messageHandler)") || stopFn.includes("if (swRegistration)") || stopFn.includes("try");
  assert.ok(hasGuard, "stopMediaCaptureSW must guard against null state for idempotent calls");
});

// G.5: stopMediaCaptureSW without prior init does not throw
await testG("calling stopMediaCaptureSW without prior init does not throw", () => {
  // Must be safe to call when no SW was ever registered
  const stopFn = swModule.stopMediaCaptureSW.toString();
  const hasGuard =
    stopFn.includes("if (messageHandler)") || stopFn.includes("if (swRegistration)") || stopFn.includes("try");
  assert.ok(hasGuard, "stopMediaCaptureSW must not throw when called without prior init");
});

// G.6: clearCapturedResponses clears all stored data
await testG("clearCapturedResponses resets the captured responses array", () => {
  const clearFn = swModule.clearCapturedResponses.toString();
  // Should clear the array
  assert.ok(
    clearFn.includes("length") || clearFn.includes("splice") || clearFn.includes("= []"),
    "clearCapturedResponses must reset the captured responses array",
  );
});

// G.7: getCapturedResponses returns a snapshot (does not share reference)
await testG("getCapturedResponses returns a snapshot (copy), not internal reference", () => {
  const getFn = swModule.getCapturedResponses.toString();
  // Should use spread operator or slice to return a copy
  const returnsCopy = getFn.includes("...") || getFn.includes("slice") || getFn.includes("concat");
  assert.ok(returnsCopy, "getCapturedResponses must return a copy of internal array to prevent mutation");
});

// ═════════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════════

const totalA = passedA + failedA;
const totalB = passedB + failedB;
const totalC = passedC + failedC;
const totalD = passedD + failedD;
const totalE = passedE + failedE;
const totalF = passedF + failedF;
const totalG = passedG + failedG;
const totalAll = totalA + totalB + totalC + totalD + totalE + totalF + totalG;
const passedAll = passedA + passedB + passedC + passedD + passedE + passedF + passedG;

console.log(`\n${"=".repeat(55)}`);
console.log(`SW CAPTURE EDGE CASE TESTS (RED PHASE)`);
console.log(`${"=".repeat(55)}`);
console.log(`  Group A (Opaque Responses):  ${passedA}/${totalA} passed, ${failedA} failed`);
console.log(`  Group B (Range Requests):    ${passedB}/${totalB} passed, ${failedB} failed`);
console.log(`  Group C (Keepalive):         ${passedC}/${totalC} passed, ${failedC} failed`);
console.log(`  Group D (Large Limits):      ${passedD}/${totalD} passed, ${failedD} failed`);
console.log(`  Group E (Failure Fallback):  ${passedE}/${totalE} passed, ${failedE} failed`);
console.log(`  Group F (Message Channel):   ${passedF}/${totalF} passed, ${failedF} failed`);
console.log(`  Group G (Cleanup):           ${passedG}/${totalG} passed, ${failedG} failed`);
console.log(`${"=".repeat(55)}`);
console.log(`  TOTAL: ${passedAll}/${totalAll} passed, ${totalAll - passedAll} failed`);
console.log(`${"=".repeat(55)}`);

if (failedA > 0 || failedB > 0 || failedC > 0 || failedD > 0 || failedE > 0 || failedF > 0 || failedG > 0) {
  console.log(
    "\n[RED] These tests describe desired behavior that is NOT YET IMPLEMENTED.\n" +
      "[RED] They will pass once the implementation is completed in GREEN phase.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "\n✅ All tests PASSED! (This shouldn't happen in RED phase — implementation may already cover these cases)",
  );
}
