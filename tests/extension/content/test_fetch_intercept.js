"use strict";
import assert from "node:assert/strict";

(async () => {
  const fi = await import("../../../src/content/fetch_intercept.js");

  // Test module exports
  assert.equal(typeof fi.initFetchIntercept, "function", "Must export initFetchIntercept");
  assert.equal(typeof fi.stopFetchIntercept, "function", "Must export stopFetchIntercept");
  assert.equal(typeof fi.getCapturedResponses, "function", "Must export getCapturedResponses");
  assert.equal(typeof fi.clearCapturedResponses, "function", "Must export clearCapturedResponses");
  assert.equal(typeof fi.isActive, "function", "Must export isActive");

  // Test generateInterceptCode returns valid JS
  const code = fi.generateInterceptCode();
  assert.ok(code, "generateInterceptCode must return a string");
  assert.ok(code.length > 100, "Intercept code must be substantial");
  assert.ok(code.includes("window.fetch"), "Intercept code must override window.fetch");
  assert.ok(code.includes("XMLHttpRequest"), "Intercept code must override XMLHttpRequest");
  assert.ok(code.includes("dispatchEvent") || code.includes("postMessage"),
    "Intercept code must dispatch a DOM event or postMessage captured data");

  // Test MEDIA_TYPE_REGEX matches known media types
  assert.ok(fi.MEDIA_TYPE_REGEX && fi.MEDIA_TYPE_REGEX.test("video/mp4"), "Must match video/mp4");
  assert.ok(fi.MEDIA_TYPE_REGEX && fi.MEDIA_TYPE_REGEX.test("application/x-mpegURL"), "Must match HLS");
  assert.ok(fi.MEDIA_TYPE_REGEX && fi.MEDIA_TYPE_REGEX.test("application/dash+xml"), "Must match DASH");
  assert.ok(!fi.MEDIA_TYPE_REGEX || !fi.MEDIA_TYPE_REGEX.test("text/html"), "Must NOT match text/html");

  // Test looksLikeMediaUrl
  assert.ok(fi.looksLikeMediaUrl("https://cdn.example.com/video.mp4"), "Must detect .mp4");
  assert.ok(fi.looksLikeMediaUrl("https://cdn.example.com/master.m3u8"), "Must detect .m3u8");
  assert.ok(fi.looksLikeMediaUrl("https://cdn.example.com/seg-001.ts"), "Must detect .ts");
  assert.ok(fi.looksLikeMediaUrl("https://cdn.example.com/video.m4s"), "Must detect .m4s");
  assert.ok(!fi.looksLikeMediaUrl("https://cdn.example.com/page.html"), "Must NOT match .html");

  // Test bufferToBase64
  const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
  const b64 = fi.bufferToBase64(buffer);
  assert.equal(b64, "SGVsbG8=", "Must correctly encode ArrayBuffer to base64");

  // Test initial state is empty
  assert.equal(fi.getCapturedResponses().length, 0, "initial captured responses should be empty");
  assert.equal(fi.isActive(), false, "initial state should be inactive");

  console.log("✓ All fetch_intercept tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
