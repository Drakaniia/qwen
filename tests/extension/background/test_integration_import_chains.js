"use strict";
import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────
// Required by: cdp_helpers → cookie_extraction → cloudflare_solver chain

const mockDebugger = {
  attachedTabs: new Set(),
  cookiesResult: [],

  attach(target, _version, callback) {
    this.attachedTabs.add(target.tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  detach(target, callback) {
    this.attachedTabs.delete(target.tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, _params, callback) {
    globalThis.chrome.runtime.lastError = null;
    if (method === "Network.getAllCookies") {
      callback({ cookies: this.cookiesResult });
    } else {
      callback({});
    }
  },

  onEvent: { addListener() {} },
  onDetach: { addListener() {} },
};

globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
  },
  tabs: {
    update: () => Promise.resolve(),
    sendMessage: () => Promise.resolve(null),
  },
};

/**
 * Integration Test: Cross-Module Import Chains
 *
 * Verifies that all the dependency chains between our new modules
 * resolve correctly at import time:
 *
 *   cdp_tunnel_integration → cdp_tunnel_download → (cdp_helpers, cloudflare_solver)
 *   cloudflare_solver → cookie_extraction → cdp_helpers
 *   download_orchestration → cdp_tunnel_integration
 */

(async () => {
  // ── Chain 1: cdp_tunnel_integration → cdp_tunnel_download → cdp_helpers ─
  const tunnelIntegration = await import("../../../src/background/cdp_tunnel_integration.js");

  // Must export from its own module
  assert.equal(typeof tunnelIntegration.tryCdpTunnelDownload, "function",
    "cdp_tunnel_integration must export tryCdpTunnelDownload");

  // Must re-export cleanup from cdp_tunnel_download (which imports from cdp_helpers)
  assert.equal(typeof tunnelIntegration.cleanup, "function",
    "cdp_tunnel_integration must re-export cleanup from cdp_tunnel_download");

  // Chain 1b: Direct import of cdp_tunnel_download to verify cdp_helpers dependency
  const cdpTunnel = await import("../../../src/background/cdp_tunnel_download.js");
  assert.equal(typeof cdpTunnel.tunnelSegmentDownload, "function",
    "cdp_tunnel_download must export tunnelSegmentDownload");
  assert.equal(typeof cdpTunnel.tunnelManifestDownload, "function",
    "cdp_tunnel_download must export tunnelManifestDownload");
  assert.equal(typeof cdpTunnel.cleanup, "function",
    "cdp_tunnel_download must export cleanup (from cdp_helpers)");
  assert.equal(typeof cdpTunnel.buildFetchScript, "function",
    "cdp_tunnel_download must export buildFetchScript");
  assert.equal(typeof cdpTunnel.buildManifestFetchScript, "function",
    "cdp_tunnel_download must export buildManifestFetchScript");

  // Chain 1c: cdp_helpers directly
  const cdpHelpers = await import("../../../src/background/cdp_helpers.js");
  assert.equal(typeof cdpHelpers.attach, "function",
    "cdp_helpers must export attach");
  assert.equal(typeof cdpHelpers.sendCommand, "function",
    "cdp_helpers must export sendCommand");
  assert.equal(typeof cdpHelpers.cleanup, "function",
    "cdp_helpers must export cleanup");
  assert.equal(cdpHelpers.activeSessions instanceof Map, true,
    "cdp_helpers must export activeSessions Map");

  // ── Chain 2: cloudflare_solver → cookie_extraction → cdp_helpers ────────
  const cfSolver = await import("../../../src/background/cloudflare_solver.js");
  assert.equal(typeof cfSolver.detectAndSolveCloudflare, "function",
    "cloudflare_solver must export detectAndSolveCloudflare");
  assert.equal(typeof cfSolver.extractCFClearance, "function",
    "cloudflare_solver must export extractCFClearance");

  // Cloudflare solver's extractCFClearance delegates to cookie_extraction.extractCookies.
  // With proper chrome.debugger mock, should return null (no cf_clearance cookie set)
  const cfResult = await cfSolver.extractCFClearance(42);
  assert.equal(cfResult, null,
    "extractCFClearance(42) must return null when no cf_clearance cookie");

  // Chain 2b: cookie_extraction directly
  const cookieExtraction = await import("../../../src/background/cookie_extraction.js");
  assert.equal(typeof cookieExtraction.extractCookies, "function",
    "cookie_extraction must export extractCookies");
  assert.equal(typeof cookieExtraction.cookiesToCookieString, "function",
    "cookie_extraction must export cookiesToCookieString");
  assert.equal(typeof cookieExtraction.cleanup, "function",
    "cookie_extraction must export cleanup (from cdp_helpers)");

  // ── Chain 3: cdp_tunnel_download → cloudflare_solver ──────────────────
  // cdp_tunnel_download imports extractCFClearance from cloudflare_solver
  // and re-exports it as extractCfClearanceCookie
  assert.equal(typeof cdpTunnel.extractCfClearanceCookie, "function",
    "cdp_tunnel_download must export extractCfClearanceCookie (from cloudflare_solver)");

  console.log("✓ All cross-module import chain tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
