"use strict";
import assert from "node:assert/strict";

(async () => {
  const mp = await import("../../../src/shared/media_protocols.js");

  // Test MEDIA_CONTENT_TYPE_RE
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("video/mp4"), "Must match video/mp4");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("audio/mp4"), "Must match audio/mp4");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("application/x-mpegURL"), "Must match HLS");
  assert.ok(mp.MEDIA_CONTENT_TYPE_RE.test("application/dash+xml"), "Must match DASH");
  assert.ok(!mp.MEDIA_CONTENT_TYPE_RE.test("text/html"), "Must NOT match text/html");

  // Test classifyUrl
  assert.equal(mp.classifyUrl("https://cdn.example.com/video.mp4").type, "direct");
  assert.equal(mp.classifyUrl("https://cdn.example.com/master.m3u8").type, "manifest");
  assert.equal(mp.classifyUrl("https://cdn.example.com/seg-001.ts").type, "segment");
  assert.equal(mp.classifyUrl("https://www.youtube.com/watch?v=abc").type, "page");

  // Test hasMediaContentType
  assert.ok(mp.hasMediaContentType("video/mp4"));
  assert.ok(mp.hasMediaContentType("application/x-mpegURL; charset=utf-8"));
  assert.ok(!mp.hasMediaContentType("text/html"));

  // Test CMS pattern detection
  const jwUrl = "https://content.jwplatform.com/videos/abc123.mp4";
  assert.equal(mp.classifyUrl(jwUrl).cms, "jwplayer");

  // Test SEGMENT_URL_RE
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/video.m4s"));
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/segment-123.ts"));
  assert.ok(mp.SEGMENT_URL_RE.test("https://cdn.example.com/file.cmfv"));
  assert.ok(!mp.SEGMENT_URL_RE.test("https://cdn.example.com/master.m3u8"));

  // Test SIGNED_URL_RE
  assert.ok(mp.SIGNED_URL_RE.test("https://cdn.example.com/video.mp4?token=abc&expires=1700000000"));
  assert.ok(!mp.SIGNED_URL_RE.test("https://cdn.example.com/video.mp4"));

  // Test TRANSFER_MODE_RE
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode: 'stream'"));
  assert.ok(mp.TRANSFER_MODE_RE.test('transferMode: "stream"'));

  // Test WebSocket URL classification
  assert.equal(mp.classifyUrl("wss://cdn.example.com/stream").type, "websocket");
  assert.equal(mp.classifyUrl("ws://cdn.example.com/stream").type, "websocket");

  // Test blob and data URLs
  assert.equal(mp.classifyUrl("blob:https://example.com/uuid").type, "blob");
  assert.equal(mp.classifyUrl("data:video/mp4;base64,AAAA").type, "data");

  // Test null/undefined/empty input
  assert.equal(mp.classifyUrl(null).type, "unknown");
  assert.equal(mp.classifyUrl(undefined).type, "unknown");
  assert.equal(mp.classifyUrl("").type, "unknown");

  console.log("✓ All media_protocols tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
