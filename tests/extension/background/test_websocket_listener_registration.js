/**
 * Test: WebSocket listener is registered in background.js
 *
 * Verifies that the background script registers a webRequest.onBeforeRequest
 * listener for the "websocket" resource type, which is necessary to detect
 * video streams delivered through WebSocket connections.
 *
 * RED phase: This test fails because the listener has not been registered yet.
 * GREEN phase: After adding the listener, this test passes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WebSocket handlers moved to background_webrequest.js in Phase 2 refactoring
const backgroundWebRequestPath = path.resolve(__dirname, "../../../src/background/background_webrequest.js");

// Read background_webrequest.js to find webRequest listener registrations
const source = fs.readFileSync(backgroundWebRequestPath, "utf8");

// ─── Test 1: handleWebSocketRequest function exists ─────────────────────────

assert.ok(
  source.includes("function handleWebSocketRequest"),
  "handleWebSocketRequest function must be defined in background_webrequest.js",
);
console.log("✓ handleWebSocketRequest function is defined in background_webrequest.js");

// ─── Test 2: A webRequest listener is registered for 'websocket' type ───────

// Look for any addListener call that includes "websocket" in the types array
const websocketListenerPattern = /(?:browserApi|chrome)\.webRequest\.onBeforeRequest\.addListener\s*\([^)]*websocket[^)]*\)/i;
const hasWebsocketListener = websocketListenerPattern.test(source);

// Also check a looser pattern: addListener with types array containing "websocket"
const loosePattern = /types:\s*\[[^\]]*"websocket"[^\]]*\]/;
const hasTypesWebsocket = loosePattern.test(source);

assert.ok(
  hasWebsocketListener || hasTypesWebsocket,
  "A webRequest.onBeforeRequest listener must be registered with types containing 'websocket'. " +
    "Add: browserApi.webRequest.onBeforeRequest.addListener(handleWebSocketRequest, " +
    "{ urls: ['<all_urls>'], types: ['websocket'] });",
);
console.log("✓ webRequest listener for 'websocket' type is registered");

// ─── Test 3: WebSocket listener calls handleWebSocketRequest ────────────────

// Find the addListener call that includes "websocket" to verify it references handleWebSocketRequest
const listenerLines = source.split("\n").filter(
  (line) =>
    line.includes("addListener") &&
    (line.includes("websocket") || line.includes("WebSocket")),
);

if (listenerLines.length > 0) {
  const referencesHandler = listenerLines.some((line) =>
    line.includes("handleWebSocketRequest"),
  );
  assert.ok(
    referencesHandler,
    "The websocket listener must reference handleWebSocketRequest as the handler callback",
  );
} else {
  // This will fail if the listener isn't registered (RED phase)
  assert.fail(
    "No webRequest listener found for 'websocket' type. " +
      "The listener registration has not been added yet.",
  );
}
console.log("✓ WebSocket listener correctly references handleWebSocketRequest");

// ─── Test 4: WebSocket registration uses '<all_urls>' pattern ──────────────

// For websocket type, we must use '<all_urls>' since WebSocket URLs use ws:///wss://
// Use a multi-line aware approach: find the addListener block and check its content
const websocketBlockStart = source.indexOf(`addListener(handleWebSocketRequest`);
if (websocketBlockStart >= 0) {
  // Extract from addListener(handleWebSocketRequest to the closing )
  const blockEnd = source.indexOf(");", websocketBlockStart) + 1;
  if (blockEnd > websocketBlockStart) {
    const websocketBlock = source.slice(websocketBlockStart, blockEnd);
    const hasAllUrls = websocketBlock.includes("<all_urls>") || websocketBlock.includes("all_urls");
    assert.ok(
      hasAllUrls,
      "WebSocket listener should use '<all_urls>' URL pattern since WebSocket URLs have ws:///wss:// scheme",
    );
    console.log("✓ WebSocket listener uses '<all_urls>' URL pattern");
  } else {
    assert.fail("Could not find closing ')' for WebSocket listener registration");
  }
} else {
  assert.fail("Could not find addListener(handleWebSocketRequest in the source");
}

console.log("\nAll WebSocket listener registration tests passed ✓");
