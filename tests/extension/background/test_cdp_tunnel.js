"use strict";
import assert from "node:assert/strict";

(async () => {
  const tunnel = await import("../../../src/background/cdp_tunnel_download.js");

  // Test that module exports expected functions
  assert.equal(typeof tunnel.tunnelSegmentDownload, "function", "tunnelSegmentDownload must be a function");
  assert.equal(typeof tunnel.cleanup, "function", "cleanup must be a function");

  // Test buildFetchScript generates valid JS
  const url = "https://cdn.example.com/video/seg-001.m4s";
  const script = tunnel.buildFetchScript(url);
  assert.ok(script, "buildFetchScript must return a string");
  assert.ok(script.includes(url), "buildFetchScript must include the URL");
  assert.ok(script.includes("fetch("), "buildFetchScript must contain a fetch call");
  assert.ok(script.includes("arrayBuffer"), "buildFetchScript must convert to arrayBuffer");

  // Test with headers
  const headers = { Referer: "https://example.com", "User-Agent": "Mozilla/5.0" };
  const scriptWithHeaders = tunnel.buildFetchScript(url, headers);
  assert.ok(scriptWithHeaders.includes("Referer"), "buildFetchScript must include custom headers");

  // Test buildManifestFetchScript
  const manifestScript = tunnel.buildManifestFetchScript("https://cdn.example.com/hls/master.m3u8");
  assert.ok(manifestScript, "buildManifestFetchScript must return a string");
  assert.ok(manifestScript.includes("text"), "manifest fetch should return text, not arrayBuffer");

  console.log("✓ All cdp_tunnel tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
