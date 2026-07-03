"use strict";
import assert from "node:assert/strict";

// ─── Mock chrome.debugger API ──────────────────────────────────────────────

const mockDebugger = {
  attachedTabs: new Set(),
  lastCommand: null,
  cookiesResult: [],
  evalResult: null,
  attachErrors: new Map(),
  commandErrors: new Map(),

  attach(target, _version, callback) {
    const tabId = target.tabId;
    if (this.attachErrors.has(tabId)) {
      globalThis.chrome.runtime.lastError = { message: this.attachErrors.get(tabId) };
      this.attachErrors.delete(tabId);
      callback();
      return;
    }
    this.attachedTabs.add(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  detach(target, callback) {
    const tabId = target.tabId;
    this.attachedTabs.delete(tabId);
    globalThis.chrome.runtime.lastError = null;
    callback();
  },

  sendCommand(target, method, params, callback) {
    this.lastCommand = { method, params };
    if (this.commandErrors.has(method)) {
      globalThis.chrome.runtime.lastError = { message: this.commandErrors.get(method) };
      this.commandErrors.delete(method);
      callback(null);
      return;
    }
    globalThis.chrome.runtime.lastError = null;

    if (method === "Network.getAllCookies") {
      callback({ cookies: this.cookiesResult });
    } else if (method === "Runtime.evaluate") {
      callback({ result: { type: "object", value: this.evalResult } });
    } else {
      callback({});
    }
  },
};

globalThis.chrome = {
  debugger: mockDebugger,
  runtime: {
    lastError: null,
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  const { extractCookies, extractHeaders, extractLocalStorage, cookiesToCookieString, cleanup } =
    await import("../../../src/background/cookie_extraction.js");

  // ── Module exports ──────────────────────────────────────────────────
  assert.equal(typeof extractCookies, "function", "must export extractCookies");
  assert.equal(typeof extractHeaders, "function", "must export extractHeaders");
  assert.equal(typeof extractLocalStorage, "function", "must export extractLocalStorage");
  assert.equal(typeof cookiesToCookieString, "function", "must export cookiesToCookieString");
  assert.equal(typeof cleanup, "function", "must export cleanup");

  // ── cookiesToCookieString formatting ────────────────────────────────
  {
    const cookies = [
      { name: "session", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
      { name: "pref", value: "lang=en", domain: ".example.com", path: "/", secure: false, httpOnly: false },
    ];
    const cookieStr = cookiesToCookieString(cookies);
    assert.equal(cookieStr, "session=abc123; pref=lang=en", "must format as semicolon-separated name=value pairs");
  }

  // empty array
  assert.equal(cookiesToCookieString([]), "", "empty cookies should return empty string");
  // null/undefined
  assert.equal(cookiesToCookieString(null), "", "null should return empty string");
  assert.equal(cookiesToCookieString(undefined), "", "undefined should return empty string");
  // filters out entries missing name or value
  assert.equal(
    cookiesToCookieString([{ name: "", value: "x" }, { name: "a", value: "b" }, {}]),
    "a=b",
    "must filter out cookies missing name or value",
  );

  // ── extractCookies with chrome.debugger mocked ──────────────────────
  {
    mockDebugger.cookiesResult = [
      { name: "session", value: "s123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
      { name: "cf_clearance", value: "cf_abc", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    ];
    const cookies = await extractCookies(42);
    assert.equal(Array.isArray(cookies), true, "must return an array");
    assert.equal(cookies.length, 2, "must return 2 cookies");
    assert.equal(cookies[0].name, "session", "first cookie name");
    assert.equal(cookies[0].value, "s123", "first cookie value");
    assert.equal(cookies[1].name, "cf_clearance", "second cookie name");
    assert.equal(cookies[1].domain, ".example.com", "cookie domain");
    assert.equal(cookies[1].httpOnly, true, "cookie httpOnly");
  }

  // ── extractCookies debugger attach failure ──────────────────────────
  {
    mockDebugger.attachErrors.set(999, "Tab is not found");
    const cookies = await extractCookies(999);
    assert.equal(Array.isArray(cookies), true, "must return array on attach failure");
    assert.equal(cookies.length, 0, "must return empty array on attach failure");
  }

  // ── extractCookies CDP command failure ──────────────────────────────
  {
    mockDebugger.commandErrors.set("Network.getAllCookies", "Internal error");
    const cookies = await extractCookies(42);
    assert.equal(Array.isArray(cookies), true, "must return array on CDP failure");
    assert.equal(cookies.length, 0, "must return empty array on CDP failure");
  }

  // ── extractCookies no cookies in result ─────────────────────────────
  {
    mockDebugger.cookiesResult = null;
    const cookies = await extractCookies(42);
    assert.equal(Array.isArray(cookies), true, "must return array when no cookies field");
    assert.equal(cookies.length, 0, "must return empty array when no cookies");
  }

  // ── extractHeaders with mocked evaluator ────────────────────────────
  {
    mockDebugger.evalResult = [
      { name: "Referer", value: "https://example.com/page" },
      { name: "User-Agent", value: "Mozilla/5.0" },
    ];
    const headers = await extractHeaders(42);
    assert.equal(Array.isArray(headers), true, "must return an array");
    assert.equal(headers.length, 2, "must return 2 headers");
    assert.equal(headers[0].name, "Referer", "first header name");
    assert.equal(headers[0].value, "https://example.com/page", "first header value");
  }

  // ── extractHeaders attach failure returns empty array ───────────────
  {
    // Remove debugger to simulate attach failure
    const savedDebugger = globalThis.chrome.debugger;
    globalThis.chrome.debugger = null;
    const headers = await extractHeaders(42);
    assert.equal(Array.isArray(headers), true, "must return array on attach failure");
    assert.equal(headers.length, 0, "must return empty array on attach failure");
    globalThis.chrome.debugger = savedDebugger;
  }

  // ── extractHeaders failed Runtime.evaluate returns empty array ──────
  {
    mockDebugger.commandErrors.set("Runtime.evaluate", "Eval failed");
    const headers = await extractHeaders(42);
    assert.equal(Array.isArray(headers), true, "must return array on eval failure");
    assert.equal(headers.length, 0, "must return empty array on eval failure");
  }

  // ── extractLocalStorage with mocked evaluator ───────────────────────
  {
    mockDebugger.evalResult = { token: "abc", refresh: "xyz" };
    const storage = await extractLocalStorage(42);
    assert.equal(typeof storage, "object", "must return an object");
    assert.equal(storage.token, "abc", "localStorage token value");
    assert.equal(storage.refresh, "xyz", "localStorage refresh value");
  }

  // ── extractLocalStorage attach failure returns empty object ─────────
  {
    const savedDebugger = globalThis.chrome.debugger;
    globalThis.chrome.debugger = null;
    const storage = await extractLocalStorage(42);
    assert.equal(typeof storage, "object", "must return object on attach failure");
    assert.deepEqual(storage, {}, "must return empty object on attach failure");
    globalThis.chrome.debugger = savedDebugger;
  }

  // ── extractLocalStorage eval failure returns empty object ───────────
  {
    mockDebugger.commandErrors.set("Runtime.evaluate", "Eval failed");
    const storage = await extractLocalStorage(42);
    assert.equal(typeof storage, "object", "must return object on eval failure");
    assert.deepEqual(storage, {}, "must return empty object on eval failure");
  }

  // ── cleanup does not throw ──────────────────────────────────────────
  {
    await cleanup();
    // If we reach here, cleanup succeeded
    assert.ok(true, "cleanup must not throw");
  }

  // ── Without chrome.debugger, all functions handle gracefully ────────
  {
    const savedDebugger = globalThis.chrome.debugger;
    globalThis.chrome.debugger = undefined;

    const cookies = await extractCookies(1);
    assert.deepEqual(cookies, [], "extractCookies must return [] when chrome.debugger is undefined");

    const headers = await extractHeaders(1);
    assert.deepEqual(headers, [], "extractHeaders must return [] when chrome.debugger is undefined");

    const storage = await extractLocalStorage(1);
    assert.deepEqual(storage, {}, "extractLocalStorage must return {} when chrome.debugger is undefined");

    await cleanup();

    globalThis.chrome.debugger = savedDebugger;
  }

  console.log("✓ All cookie_extraction tests passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
