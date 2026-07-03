/**
 * Test: transferMode: "stream" Detection in Content Script
 *
 * Tests that the content script can detect fetch/XHR requests using
 * transferMode: "stream" which indicates streaming video responses
 * even when URLs don't match typical media patterns.
 *
 * Edge Case from audit: §4.1 transferMode stream detection (HIGH)
 */

import assert from "node:assert/strict";
import * as filters from "../../../src/shared/video_filters.js";
import * as pageDetectionModule from "../../../src/content/page_detection.js";
import * as mp from "../../../src/shared/media_protocols.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

function createDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Test Page",
    baseURI: options.url || "https://example.com/player",
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
  const loc = new URL(options.url || "https://example.com/player");
  return pageDetectionModule.create({
    document: doc,
    location: loc,
    videoFilters: filters,
    seenUrls: options.seenUrls || new Map(),
  });
}

// ─── 1. TRANSFER_MODE_RE regex patterns - edge cases ───────────────────

{
  console.log("--- Test 1: TRANSFER_MODE_RE regex edge cases ---");

  // Basic patterns - should match
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode: 'stream'"),
    "Must match single-quoted stream");
  assert.ok(mp.TRANSFER_MODE_RE.test('transferMode: "stream"'),
    'Must match double-quoted stream');
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode:'stream'"),
    "Must match without space after colon");
  assert.ok(mp.TRANSFER_MODE_RE.test("transferMode= 'stream'"),
    "Must match with assignment operator");

  // Variable assignment patterns used in real code
  assert.ok(mp.TRANSFER_MODE_RE.test('{ transferMode: "stream" }'),
    "Must match inside object literal");
  assert.ok(mp.TRANSFER_MODE_RE.test('fetch(url, { transferMode: "stream" })'),
    "Must match inside fetch call");
  assert.ok(mp.TRANSFER_MODE_RE.test('xhr.transferMode = "stream"'),
    "Must match XHR assignment");

  // Should NOT match non-stream values
  assert.ok(!mp.TRANSFER_MODE_RE.test('transferMode: "cors"'),
    'Must NOT match transferMode cors');
  assert.ok(!mp.TRANSFER_MODE_RE.test('transferMode: "same-origin"'),
    'Must NOT match transferMode same-origin');
  assert.ok(!mp.TRANSFER_MODE_RE.test('transferMode: "no-cors"'),
    'Must NOT match transferMode no-cors');

  // Should NOT match empty or null
  assert.ok(!mp.TRANSFER_MODE_RE.test(""),
    "Must NOT match empty string");
  assert.ok(!mp.TRANSFER_MODE_RE.test(null),
    "Must NOT match null");

  console.log("  ✓ TRANSFER_MODE_RE handles all edge cases");
}

// ─── 2. Detect transferMode: 'stream' in inline scripts ────────────────
// Tests that page_detection.js can identify transferMode: 'stream'
// patterns in inline script content.

{
  console.log("\n--- Test 2: Detect streaming patterns via scanForStreamingPatterns ---");

  const detection = createDetection({
    url: "https://example.com/player",
    docTitle: "Custom Video Player",
  });

  // Simulate inline script with fetch using transferMode: 'stream'
  const scriptText = `
    async function loadVideo() {
      const response = await fetch("https://cdn.example.com/stream", {
        method: "GET",
        transferMode: "stream"
      });
      const reader = response.body.getReader();
      // process streaming data
    }
  `;

  const streamingPatterns = detection.scanForStreamingPatterns(scriptText);

  assert.ok(Array.isArray(streamingPatterns),
    "scanForStreamingPatterns should return an array");
  assert.ok(streamingPatterns.length > 0,
    "Should detect at least one streaming pattern");
  assert.equal(streamingPatterns[0].type, "transferMode-stream",
    "Should identify pattern type as transferMode-stream");

  console.log("  ✓ transferMode: 'stream' pattern detected in script text");
  console.log("  Patterns found:", streamingPatterns.length);
}

// ─── 3. No false positives on regular scripts ──────────────────────────

{
  console.log("\n--- Test 3: No false positives on non-streaming scripts ---");

  const detection = createDetection({
    url: "https://example.com/page",
    docTitle: "Regular Page",
  });

  const normalScript = `
    const data = await fetch("/api/users", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    const users = await data.json();
  `;

  const patterns = detection.scanForStreamingPatterns(normalScript);
  assert.equal(patterns.length, 0,
    "Should NOT detect streaming patterns in regular fetch calls");

  console.log("  ✓ No false positives for regular non-streaming scripts");
}

// ─── 4. Multiple patterns in one script ────────────────────────────────

{
  console.log("\n--- Test 4: Multiple streaming patterns in same script ---");

  const detection = createDetection({
    url: "https://example.com/player",
    docTitle: "Streaming Player",
  });

  const scriptText = `
    // Video segment loader
    function loadSegment(url) {
      return fetch(url, { transferMode: "stream" });
    }

    // Audio segment loader
    function loadAudio(url) {
      return fetch(url, { transferMode: "stream" });
    }
  `;

  const patterns = detection.scanForStreamingPatterns(scriptText);
  assert.ok(patterns.length >= 2,
    "Should detect multiple streaming patterns in same script (found " + patterns.length + ")");

  console.log("  ✓ Multiple streaming patterns detected:", patterns.length);
}

// ─── 5. Integration with inline script scanning ────────────────────────

{
  console.log("\n--- Test 5: Streaming candidates integration ---");

  const detection = createDetection({
    url: "https://example.com/player",
    docTitle: "Custom Player",
  });

  // Script with both a video URL and transferMode: 'stream'
  const scriptText = `
    const videoUrl = "https://cdn.example.com/stream/playlist.m3u8";
    const response = await fetch(videoUrl, {
      method: "GET",
      transferMode: "stream"
    });
  `;

  // Regular scanTextForMediaUrls should still find the .m3u8 URL
  const urlCandidates = detection.scanTextForMediaUrls(scriptText, "script-config");
  assert.ok(urlCandidates.some((c) => c.url.includes(".m3u8")),
    "Should detect .m3u8 playlist URL in same script");

  // scanForStreamingPatterns should find the transferMode pattern
  const patterns = detection.scanForStreamingPatterns(scriptText);
  assert.ok(patterns.length > 0,
    "Should detect transferMode: 'stream' alongside the media URL");

  console.log("  ✓ .m3u8 URL detected:", urlCandidates.some((c) => c.url.includes(".m3u8")));
  console.log("  ✓ Streaming patterns detected:", patterns.length);
}

console.log("\n✓ All transferMode: 'stream' detection tests completed");
