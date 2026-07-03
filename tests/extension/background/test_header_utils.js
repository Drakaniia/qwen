"use strict";
import assert from "node:assert/strict";

// ─── Mock chrome.cookies API ──────────────────────────────────────────────

const mockCookieStore = [];

globalThis.chrome = {
  runtime: { lastError: null },
  cookies: {
    getAll(details, callback) {
      // Filter by URL (basic simulation)
      const result = mockCookieStore.filter((c) => {
        if (!details.url) return true;
        try {
          const urlHost = new URL(details.url).hostname;
          return c.domain && urlHost.endsWith(c.domain.replace(/^\./, ""));
        } catch {
          return true;
        }
      });
      callback(result);
    },
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  const headerUtils = await import("../../../src/background/header_utils.js");

  // ── Constants ────────────────────────────────────────────────────────
  assert.equal(
    typeof headerUtils.MAX_COOKIE_HEADER_LENGTH,
    "number",
    "must export MAX_COOKIE_HEADER_LENGTH constant",
  );
  assert.ok(
    headerUtils.MAX_COOKIE_HEADER_LENGTH > 0,
    "MAX_COOKIE_HEADER_LENGTH must be positive",
  );

  // ── cookieHeaderForUrl: truncates oversized cookie strings ──────────
  {
    // Create enough cookies to exceed the limit
    const limit = headerUtils.MAX_COOKIE_HEADER_LENGTH;
    const longValue = "x".repeat(500);
    const cookies = Array.from({ length: 20 }, (_, i) => ({
      name: `cookie_${i}`,
      value: longValue,
      domain: ".youtube.com",
      path: "/",
    }));
    mockCookieStore.length = 0;
    mockCookieStore.push(...cookies);

    const cookieStr = await headerUtils.cookieHeaderForUrl("https://www.youtube.com/watch?v=test");

    // Must be truncated to at most MAX_COOKIE_HEADER_LENGTH
    assert.ok(
      cookieStr.length <= limit,
      `Cookie header (${cookieStr.length}) must not exceed MAX_COOKIE_HEADER_LENGTH (${limit})`,
    );
    // Must still contain some cookies
    assert.ok(cookieStr.length > 0, "Cookie header must not be empty");
    // Should end mid-value rather than corrupting
    const lastEq = cookieStr.lastIndexOf("=");
    if (lastEq > 0) {
      const lastVal = cookieStr.slice(lastEq + 1);
      // If truncated mid-value, the value should still be a prefix of original
      assert.ok(
        lastVal.length <= longValue.length,
        "Truncated cookie value must not exceed original value length",
      );
    }
  }

  // ── cookieHeaderForUrl: short cookies pass through unchanged ────────
  {
    mockCookieStore.length = 0;
    mockCookieStore.push(
      { name: "session", value: "abc123", domain: ".youtube.com", path: "/" },
      { name: "pref", value: "lang=en", domain: ".youtube.com", path: "/" },
    );

    const cookieStr = await headerUtils.cookieHeaderForUrl("https://www.youtube.com/watch?v=test");
    assert.ok(cookieStr.includes("session=abc123"), "Must include session cookie");
    assert.ok(cookieStr.includes("pref=lang=en"), "Must include pref cookie");
    assert.ok(cookieStr.length < 100, "Short cookie string should stay small");
  }

  // ── cookieHeaderForUrl: protocols other than http/https return '' ──
  {
    const result = await headerUtils.cookieHeaderForUrl("file:///C:/test.html");
    assert.equal(result, "", "Non-http/https URLs should return empty string");
  }

  // ── cookieHeaderForUrl: invalid URL returns '' ──────────────────────
  {
    const result = await headerUtils.cookieHeaderForUrl("");
    assert.equal(result, "", "Empty URL should return empty string");
  }

  console.log("✓ All header_utils tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
