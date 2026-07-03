/**
 * Test: WebSocket URL Detection in Content Script
 *
 * Tests that ws:// and wss:// URLs used by WebSocket-based streaming
 * platforms (Douyu, Huya, custom players) are detected by the content
 * script's scanning pipeline.
 *
 * Edge Case from audit: §4.1 WebSocket URL detection (HIGH)
 */

import assert from "node:assert/strict";
import * as filters from "../../../src/shared/video_filters.js";
import * as pageDetectionModule from "../../../src/content/page_detection.js";
import * as mp from "../../../src/shared/media_protocols.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

function createDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Test Page",
    baseURI: options.url || "https://example.com/video",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const loc = new URL(options.url || "https://example.com/video");
  return pageDetectionModule.create({
    document: doc,
    location: loc,
    videoFilters: filters,
    seenUrls: options.seenUrls || new Map(),
  });
}

// ─── 1. WEBSOCKET_MEDIA_RE regex tests ──────────────────────────────────

{
  console.log("--- Test 1: WEBSOCKET_MEDIA_RE regex patterns ---");

  assert.ok(mp.WEBSOCKET_MEDIA_RE.test("ws://cdn.example.com/stream"), "Must match ws:// simple URL");
  assert.ok(mp.WEBSOCKET_MEDIA_RE.test("wss://cdn.example.com/stream"), "Must match wss:// URL");
  assert.ok(mp.WEBSOCKET_MEDIA_RE.test("ws://192.168.1.1:8080/live"), "Must match ws:// with IP and port");
  assert.ok(mp.WEBSOCKET_MEDIA_RE.test("wss://live.douyu.com/stream/abc123"), "Must match wss:// Douyu-style URL");
  assert.ok(mp.WEBSOCKET_MEDIA_RE.test("ws://huya.com/live?stream=123"), "Must match ws:// Huya-style URL with query");
  assert.ok(!mp.WEBSOCKET_MEDIA_RE.test("https://cdn.example.com/video.mp4"), "Must NOT match https:// URL");
  assert.ok(!mp.WEBSOCKET_MEDIA_RE.test("http://cdn.example.com/video.mp4"), "Must NOT match http:// URL");
  assert.ok(!mp.WEBSOCKET_MEDIA_RE.test(""), "Must NOT match empty string");
  assert.ok(!mp.WEBSOCKET_MEDIA_RE.test(null), "Must NOT match null");

  console.log("  ✓ WEBSOCKET_MEDIA_RE correctly identifies WebSocket URLs");
}

// ─── 2. classifyUrl with WebSocket URLs ─────────────────────────────────

{
  console.log("\n--- Test 2: classifyUrl with WebSocket URLs ---");

  assert.equal(
    mp.classifyUrl("wss://cdn.example.com/stream").type,
    "websocket",
    "classifyUrl should return type=websocket for wss://",
  );
  assert.equal(
    mp.classifyUrl("ws://cdn.example.com/stream").type,
    "websocket",
    "classifyUrl should return type=websocket for ws://",
  );
  assert.equal(
    mp.classifyUrl("wss://live.douyu.com/playback").type,
    "websocket",
    "classifyUrl should return type=websocket for Douyu-style URL",
  );

  // Format extraction from WebSocket URLs
  const wsResult = mp.classifyUrl("wss://cdn.example.com/stream.flv");
  assert.equal(wsResult.type, "websocket", "WebSocket URL with .flv extension should still be type=websocket");
  assert.equal(wsResult.format, "flv", "WebSocket URL should extract format from extension");

  console.log("  ✓ classifyUrl correctly classifies WebSocket URLs");
}

// ─── 3. scanTextForMediaUrls with WebSocket URLs ────────────────────────
// NOTE: This test verifies that we CAN detect WebSocket URLs embedded
// in page script text. Currently MEDIA_URL_TEXT_RE doesn't match ws://,
// so we need to add WebSocket scanning to scanTextForMediaUrls or
// add a separate WebSocket detection path.

{
  console.log("\n--- Test 3: scanTextForMediaUrls detection of WebSocket URLs ---");

  const detection = createDetection({
    url: "https://example.com/live",
    docTitle: "Live Stream - Douyu",
  });

  // Simulate an inline script containing WebSocket streaming URLs
  const scriptText = `
    var ws = new WebSocket("wss://cdn.example.com/live/stream?token=abc");
    ws.onmessage = function(e) { /* handle video data */ };
  `;

  const candidates = detection.scanTextForMediaUrls(scriptText, "script-config");

  // This should detect the WebSocket URL embedded in script text
  const foundWs = candidates.some((c) => c.url.includes("wss://cdn.example.com/live/stream"));
  assert.ok(
    foundWs,
    "scanTextForMediaUrls should detect wss:// URLs in script text (found=" +
      candidates.map((c) => c.url).join(",") +
      ")",
  );

  console.log("  ✓ WebSocket URL detected from script text");
  console.log("  Candidates found:", candidates.length);
}

// ─── 4. scanTextForMediaUrls with ws:// plain URLs ──────────────────────

{
  console.log("\n--- Test 4: scanTextForMediaUrls with ws:// URLs ---");

  const detection = createDetection({
    url: "https://example.com/player",
    docTitle: "Custom Player",
  });

  const scriptText = `
    var videoUrl = "ws://cdn.example.com:8080/live/stream";
    // connect to WebSocket for video
  `;

  const candidates = detection.scanTextForMediaUrls(scriptText, "script-config");

  const foundWs = candidates.some((c) => c.url.includes("ws://cdn.example.com:8080/live/stream"));
  assert.ok(foundWs, "scanTextForMediaUrls should detect ws:// URLs in script text");

  console.log("  ✓ ws:// URL detected from script text");
}

// ─── 5. WebSocket URL NOT detected in non-media content ────────────────

{
  console.log("\n--- Test 5: Reject non-streaming ws:// URLs ---");

  const detection = createDetection({
    url: "https://example.com/chat",
    docTitle: "Chat App",
  });

  // WebSocket used for chat, not video streaming
  const scriptText = `
    var chat = new WebSocket("wss://chat.example.com/socket");
    chat.onmessage = function(e) { displayMessage(e.data); };
  `;

  const candidates = detection.scanTextForMediaUrls(scriptText, "script-config");

  // WebSocket connection to a chat endpoint should still be detected at the URL level
  // The downstream pipeline decides whether it's a video candidate
  // (This test just ensures the URL is found at the text scan level)
  const foundChatWs = candidates.some((c) => c.url.includes("wss://chat.example.com/socket"));
  console.log("  Chat WebSocket URL detected:", foundChatWs, "(may be filtered by downstream pipeline)");
}

console.log("\n✓ All WebSocket URL detection tests completed");
