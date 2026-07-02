"use strict";
import assert from "node:assert/strict";

(async () => {
  // Import the module (functions are exported but work in non-SW contexts for testing)
  const swModule = await import("../../../src/content/service_worker_capture.js");

  // Test generateCaptureSWCode returns valid JS
  const swCode = swModule.generateCaptureSWCode();
  assert.ok(swCode, "generateCaptureSWCode must return a string");
  assert.ok(swCode.length > 100, "SW code must be substantial");
  assert.ok(swCode.includes("self.addEventListener"), "SW code must register a fetch listener");
  assert.ok(swCode.includes("MEDIA_TYPES"), "SW code must define MEDIA_TYPES regex");
  assert.ok(swCode.includes("postMessage"), "SW code must postMessage captured data");

  // Test MEDIA_TYPE_REGEX pattern matches known media types
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("video/mp4"), "Must match video/mp4");
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("application/x-mpegURL"), "Must match HLS");
  assert.ok(swModule.MEDIA_TYPE_REGEX && swModule.MEDIA_TYPE_REGEX.test("application/dash+xml"), "Must match DASH");
  assert.ok(!swModule.MEDIA_TYPE_REGEX || !swModule.MEDIA_TYPE_REGEX.test("text/html"), "Must NOT match text/html");

  // Test looksLikeSegment
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/seg-001.ts"), "Must detect .ts segments");
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/video.m4s"), "Must detect .m4s segments");
  assert.ok(swModule.looksLikeSegment("https://cdn.example.com/segment_123"), "Must detect segment in path");
  assert.ok(!swModule.looksLikeSegment("https://cdn.example.com/master.m3u8"), "Must NOT match manifests");

  // Test bufferToBase64
  const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
  const b64 = swModule.bufferToBase64(buffer);
  assert.equal(b64, "SGVsbG8=", "Must correctly encode ArrayBuffer to base64");

  // Test isPageUrlSupportedForSWCapture
  assert.ok(typeof swModule.isPageUrlSupportedForSWCapture === "function", "isPageUrlSupportedForSWCapture must be exported");
  assert.ok(swModule.isPageUrlSupportedForSWCapture("https://example.com/video"), "Must accept https URLs");
  assert.ok(swModule.isPageUrlSupportedForSWCapture("https://meet.google.com/abc-def-ghi"), "Must accept https URLs");
  assert.ok(swModule.isPageUrlSupportedForSWCapture("http://localhost:8080/video"), "Must accept http://localhost");
  assert.ok(swModule.isPageUrlSupportedForSWCapture("http://127.0.0.1/video"), "Must accept http://127.0.0.1");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("blob:https://example.com/uuid"), "Must reject blob: URLs");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("blob:https://meet.google.com/uuid"), "Must reject blob: URLs");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("about:blank"), "Must reject about:blank");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("data:text/html,<html></html>"), "Must reject data: URLs");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("file:///C:/page.html"), "Must reject file: URLs");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("chrome-extension://abc123/page.html"), "Must reject chrome-extension: URLs");
  assert.ok(!swModule.isPageUrlSupportedForSWCapture("http://example.com/video"), "Must reject non-localhost http URLs");

  // Blob SW script injection is unsupported in Chromium/Firefox — skip doomed registration.
  assert.ok(typeof swModule.isCaptureServiceWorkerRegistrationSupported === "function",
    "isCaptureServiceWorkerRegistrationSupported must be exported");
  assert.ok(!swModule.isCaptureServiceWorkerRegistrationSupported(),
    "Blob-injected capture SW registration must be disabled");

  console.log("✓ All service_worker_capture tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
