"use strict";
import assert from "node:assert/strict";

(async () => {
  // Test cookiesToCookieString formatting
  const { cookiesToCookieString } = await import("../../../src/background/cookie_extraction.js");

  const cookies = [
    { name: "session", value: "abc123", domain: ".example.com", path: "/", secure: true, httpOnly: true },
    { name: "pref", value: "lang=en", domain: ".example.com", path: "/", secure: false, httpOnly: false },
  ];
  const cookieStr = cookiesToCookieString(cookies);
  assert.equal(cookieStr, "session=abc123; pref=lang=en", "must format as semicolon-separated name=value pairs");

  // Test with empty array
  assert.equal(cookiesToCookieString([]), "", "empty cookies should return empty string");

  // Test with null/undefined
  assert.equal(cookiesToCookieString(null), "", "null should return empty string");
  assert.equal(cookiesToCookieString(undefined), "", "undefined should return empty string");

  console.log("✓ All cookie_extraction tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
