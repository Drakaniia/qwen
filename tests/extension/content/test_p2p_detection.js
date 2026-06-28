/**
 * Tests for P2P / WebRTC Stream Detection Module
 *
 * RED phase: Tests will fail until the module is implemented.
 * GREEN phase: After implementation, all tests pass.
 */

import assert from "node:assert/strict";

// ─── Set up global mocks ───────────────────────────────────────────────────

// We can't import the full module in Node (it references browser APIs),
// so we test the pure logic functions and the interception interface.

// Set up window with RTCPeerConnection (for p2p_detection.js which reads window.RTCPeerConnection)
globalThis.window = {};
globalThis.window.RTCPeerConnection = function MockRTCPeerConnection() {
  this.createOffer = async () => ({ sdp: "" });
  this.createAnswer = async () => ({ sdp: "" });
  this.setLocalDescription = async (_desc) => {};
  this.setRemoteDescription = async (_desc) => {};
};
// Also set global RTCPeerConnection for `typeof RTCPeerConnection` check
globalThis.RTCPeerConnection = globalThis.window.RTCPeerConnection;
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

let p2pModule;
try {
  p2pModule = await import("../../../src/content/p2p_detection.js");
} catch (err) {
  console.warn("Could not import p2p_detection.js:", err.message);
  p2pModule = null;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  // ─── Test: Module exports the expected interface ───────────────────────────

  {
    if (!p2pModule) {
      // RED phase - module doesn't exist yet
      assert.ok(false, "p2p_detection.js module should be importable. RED phase: expected to fail.");
    } else {
      assert.equal(typeof p2pModule.init, "function", "module must export init()");
      assert.equal(typeof p2pModule.cleanup, "function", "module must export cleanup()");
      assert.equal(typeof p2pModule.getDetectedUrls, "function", "module must export getDetectedUrls()");
      assert.equal(typeof p2pModule.isLikelyP2pMediaUrl, "function", "module must export isLikelyP2pMediaUrl()");
      assert.equal(typeof p2pModule.hasWebTorrent, "function", "module must export hasWebTorrent()");
      assert.equal(typeof p2pModule.hasP2pFramework, "function", "module must export hasP2pFramework()");
      assert.equal(typeof p2pModule.extractUrlsFromSdp, "function", "module must export extractUrlsFromSdp()");
      console.log("✓ Module exports correct interface");
    }
  }

  // ─── Test: isLikelyP2pMediaUrl detection ──────────────────────────────────

  {
    if (p2pModule) {
      assert.ok(p2pModule.isLikelyP2pMediaUrl("magnet:?xt=urn:btih:ABC123"), "magnet: URLs should be detected as P2P");
      assert.ok(p2pModule.isLikelyP2pMediaUrl("torrent:ABC123"), "torrent: URLs should be detected as P2P");
      assert.ok(p2pModule.isLikelyP2pMediaUrl("https://example.com/file.torrent"), ".torrent URLs should be detected as P2P");
      assert.ok(p2pModule.isLikelyP2pMediaUrl("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"), "40-char hex should be detected as P2P");
      assert.ok(!p2pModule.isLikelyP2pMediaUrl("https://example.com/video.mp4"), "normal video URLs should NOT be detected as P2P");
      assert.ok(!p2pModule.isLikelyP2pMediaUrl(""), "empty string should NOT be detected as P2P");
      console.log("✓ isLikelyP2pMediaUrl correctly identifies P2P URLs");
    }
  }

  // ─── Test: extractUrlsFromSdp ─────────────────────────────────────────────

  {
    if (p2pModule) {
      const sdpExample = `v=0
o=- 123456 2 IN IP4 0.0.0.0
s=-
t=0 0
a=msid:video-stream-id-123
a=msid:audio-stream-id-456
a=candidate:1 1 UDP 2122252543 192.168.1.1 53471 typ host
a=candidate:2 1 UDP 1686052607 203.0.113.1 3478 typ srflx raddr 0.0.0.0 rport 0
a=candidate:3 1 TCP 2105524479 192.168.1.1 9 typ host tcptype active`;

      const urls = p2pModule.extractUrlsFromSdp(sdpExample);
      assert.ok(urls.length > 0, "SDP extraction should return URLs");
      assert.ok(urls.some((u) => u.includes("video-stream-id-123")), "should extract msid for video stream");
      assert.ok(urls.some((u) => u.includes("audio-stream-id-456")), "should extract msid for audio stream");
      console.log("✓ extractUrlsFromSdp extracts media stream IDs from SDP");
    }
  }

  // ─── Test: extractUrlsFromSdp with invalid input ──────────────────────────

  {
    if (p2pModule) {
      assert.deepEqual(p2pModule.extractUrlsFromSdp(""), [], "empty SDP should return empty array");
      assert.deepEqual(p2pModule.extractUrlsFromSdp(null), [], "null SDP should return empty array");
      assert.deepEqual(p2pModule.extractUrlsFromSdp(undefined), [], "undefined SDP should return empty array");
      console.log("✓ extractUrlsFromSdp handles invalid input gracefully");
    }
  }

  // ─── Test: hasWebTorrent detection ────────────────────────────────────────

  {
    if (p2pModule) {
      // Without WebTorrent
      globalThis.window.WebTorrent = undefined;
      assert.ok(!p2pModule.hasWebTorrent(), "hasWebTorrent should return false when no WebTorrent");

      // With WebTorrent
      globalThis.window.WebTorrent = {};
      assert.ok(p2pModule.hasWebTorrent(), "hasWebTorrent should return true when WebTorrent exists");
      delete globalThis.window.WebTorrent;
      console.log("✓ hasWebTorrent correctly detects WebTorrent presence");
    }
  }

  // ─── Test: hasP2pFramework detection ──────────────────────────────────────

  {
    if (p2pModule) {
      // Without any framework
      globalThis.window.peertube = undefined;
      globalThis.window.WebTorrent = undefined;
      globalThis.window.P2PMediaLoader = undefined;
      assert.ok(!p2pModule.hasP2pFramework(), "hasP2pFramework should return false when no frameworks");

      // With PeerTube
      globalThis.window.peertube = {};
      assert.ok(p2pModule.hasP2pFramework(), "hasP2pFramework should detect PeerTube");
      delete globalThis.window.peertube;

      // With P2P Media Loader
      globalThis.window.P2PMediaLoader = {};
      assert.ok(p2pModule.hasP2pFramework(), "hasP2pFramework should detect P2PMediaLoader");
      delete globalThis.window.P2PMediaLoader;
      console.log("✓ hasP2pFramework correctly detects P2P frameworks");
    }
  }

  // ─── Test: init() and cleanup() lifecycle ─────────────────────────────────

  {
    if (p2pModule) {
      const origName = globalThis.window.RTCPeerConnection.name;

      p2pModule.init();
      // After init, window.RTCPeerConnection should be overridden
      const afterInit = globalThis.window.RTCPeerConnection;
      assert.ok(
        afterInit !== globalThis.RTCPeerConnection,
        "init should override window.RTCPeerConnection",
      );
      assert.equal(afterInit.name, "InterceptedRTCPeerConnection", "init should set InterceptedRTCPeerConnection");
      console.log("✓ init() overrides window.RTCPeerConnection");

      p2pModule.cleanup();
      // After cleanup, original should be restored
      assert.notEqual(
        globalThis.window.RTCPeerConnection.name,
        "InterceptedRTCPeerConnection",
        "cleanup should restore original RTCPeerConnection",
      );
      assert.equal(
        globalThis.window.RTCPeerConnection.name,
        origName,
        "cleanup should restore original RTCPeerConnection name",
      );
      console.log("✓ cleanup() restores original RTCPeerConnection");
    }
  }

  console.log("\nAll P2P/WebRTC detection tests completed ✓");
  // Force exit to stop active intervals from keeping the process alive
  setImmediate(() => process.exit(0));
})().catch((error) => {
  console.error("Test failed:", error);
  // Force exit to stop active intervals
  setImmediate(() => process.exit(1));
});
