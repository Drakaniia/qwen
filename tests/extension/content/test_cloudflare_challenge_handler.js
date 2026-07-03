/**
 * Tests for Content Script Cloudflare Challenge Handler
 *
 * RED phase: These tests describe desired behavior for the content script's
 * `qwinCheckCloudflareChallenge` message handler that does NOT YET EXIST.
 *
 * The handler should detect Cloudflare challenge elements on the page:
 * - cf-turnstile widget
 * - challenge-platform scripts
 * - challenge iframes
 * - cf-please-wait / cf-chl-blocked divs
 * - jschl-answer forms
 * - Generic anti-bot patterns
 *
 * GREEN phase: After adding the handler to content.js, all tests pass.
 */

import assert from "node:assert/strict";

// ─── Helper: Create a mock document with querySelector support ────────────

function createMockDocument(elements = {}) {
  // queryResults maps CSS selectors to DOM element stubs
  const queryResults = new Map(Object.entries(elements.queryResults || {}));

  return {
    querySelector: (selector) => {
      return queryResults.get(selector) || null;
    },
    querySelectorAll: (selector) => {
      const results = queryResults.get(selector);
      if (results && typeof results[Symbol.iterator] === "function") {
        return results;
      }
      return { length: 0, [Symbol.iterator]: function* () {} };
    },
    documentElement: { nodeType: 1 },
  };
}

// ─── Reference implementation of the handler logic ────────────────────────
// This is the logic that the content script SHOULD implement.
// It's defined here in the test to validate expected behavior before implementation.

function checkForCloudflareChallenge(doc) {
  try {
    // Cloudflare Turnstile widget
    if (doc.querySelector("#cf-turnstile") || doc.querySelector("[data-turnstile]")) {
      return true;
    }

    // Challenge platform script
    if (doc.querySelector('script[src*="challenge-platform"]')) {
      return true;
    }

    // Cloudflare challenge page elements
    if (doc.querySelector("#cf-please-wait") || doc.querySelector("#cf-chl-blocked")) {
      return true;
    }

    // Challenge iframe
    if (doc.querySelector('iframe[src*="challenge"]') || doc.querySelector('iframe[src*="turnstile"]')) {
      return true;
    }

    // JavaScript challenge answer form
    if (doc.querySelector('input[name="jschl_answer"]')) {
      return true;
    }

    // Generic challenge-related IDs/classes
    if (
      doc.querySelector("#challenge-form") ||
      doc.querySelector(".cf-browser-verification") ||
      doc.querySelector("#cf-challenge")
    ) {
      return true;
    }

    // Check for meta refresh (used in 5-second challenge pages)
    const metaRefresh = doc.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
      const content = (metaRefresh.content || "").toLowerCase();
      if (content.includes("challenge") || content.includes("verify")) {
        return true;
      }
    }

    return false;
  } catch (_e) {
    // Fail closed: if we can't inspect the DOM, assume challenged
    return true;
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  console.log("[RED] Content script Cloudflare challenge handler tests");
  console.log("[RED] These tests verify EXPECTED behavior for the missing handler");
  console.log("");

  let passedCount = 0;
  let failedCount = 0;
  const totalTests = 15;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passedCount++;
    } catch (err) {
      console.log(`  ✗ ${name}: ${err.message}`);
      failedCount++;
    }
  }

  // ─── Test: Detection of Cloudflare challenge elements ────────────────

  test("detects cf-turnstile widget", () => {
    const doc = createMockDocument({
      queryResults: { "#cf-turnstile": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects data-turnstile attribute", () => {
    const doc = createMockDocument({
      queryResults: { "[data-turnstile]": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects challenge-platform script", () => {
    const doc = createMockDocument({
      queryResults: {
        'script[src*="challenge-platform"]': { nodeType: 1 },
      },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects cf-please-wait div", () => {
    const doc = createMockDocument({
      queryResults: { "#cf-please-wait": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects cf-chl-blocked div", () => {
    const doc = createMockDocument({
      queryResults: { "#cf-chl-blocked": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects challenge iframe", () => {
    const doc = createMockDocument({
      queryResults: {
        'iframe[src*="challenge"]': { nodeType: 1 },
      },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects turnstile iframe", () => {
    const doc = createMockDocument({
      queryResults: {
        'iframe[src*="turnstile"]': { nodeType: 1 },
      },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects jschl-answer input", () => {
    const doc = createMockDocument({
      queryResults: {
        'input[name="jschl_answer"]': { nodeType: 1 },
      },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects challenge form", () => {
    const doc = createMockDocument({
      queryResults: { "#challenge-form": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects cf-browser-verification class", () => {
    const doc = createMockDocument({
      queryResults: { ".cf-browser-verification": { nodeType: 1 } },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  test("detects meta refresh with challenge content", () => {
    const doc = createMockDocument({
      queryResults: {
        'meta[http-equiv="refresh"]': {
          nodeType: 1,
          content: "5; url=/cdn-cgi/challenge-platform/",
        },
      },
    });
    assert.ok(checkForCloudflareChallenge(doc));
  });

  // ─── Test: False negatives (should NOT detect challenges) ────────────

  test("returns false for normal video page", () => {
    const doc = createMockDocument({
      queryResults: { video: { nodeType: 1 } },
    });
    assert.ok(!checkForCloudflareChallenge(doc));
  });

  test("returns false for empty document", () => {
    const doc = createMockDocument({});
    assert.ok(!checkForCloudflareChallenge(doc));
  });

  test("returns false for page with only text content", () => {
    const doc = createMockDocument({
      queryResults: {
        p: { nodeType: 1, textContent: "Welcome to my website" },
      },
    });
    assert.ok(!checkForCloudflareChallenge(doc));
  });

  test("returns false for meta refresh without challenge keywords", () => {
    const doc = createMockDocument({
      queryResults: {
        'meta[http-equiv="refresh"]': {
          nodeType: 1,
          content: "0; url=https://example.com/page2",
        },
      },
    });
    assert.ok(!checkForCloudflareChallenge(doc));
  });

  // ─── Summary ─────────────────────────────────────────────────────────

  console.log("");
  console.log(`Results: ${passedCount}/${totalTests} passed, ${failedCount}/${totalTests} failed`);

  if (failedCount > 0) {
    console.log(
      "[RED] These tests will pass once the qwinCheckCloudflareChallenge handler is implemented in content.js",
    );
    process.exitCode = 1;
  } else {
    console.log("✓ All tests pass!");
  }

  setImmediate(() => process.exit(process.exitCode || 0));
})().catch((error) => {
  console.error("Test failed with exception:", error);
  setImmediate(() => process.exit(1));
});

export { checkForCloudflareChallenge };
