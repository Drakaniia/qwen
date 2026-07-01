"use strict";

/**
 * Cloudflare Interactive Solver
 *
 * Implements spec §5.3: when Turnstile/CAPTCHA is detected, navigate
 * the current tab to the CF-protected URL, wait for the user to manually
 * solve the challenge, extract the cf_clearance cookie, and inject it
 * into download backends.
 */

import * as cookieExtraction from "./cookie_extraction.js";

const CHECK_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes for user to solve
const CF_CLEARANCE_COOKIE = "cf_clearance";

/**
 * Full solver flow: navigate tab to URL, wait for user to solve,
 * extract cf_clearance cookie.
 *
 * @param {number} tabId
 * @param {string} url - The Cloudflare-protected URL to navigate to.
 * @param {Object} [options]
 * @param {number} [options.timeout=120000]
 * @returns {Promise<{solved: boolean, cfClearance?: string, error?: string}>}
 */
async function detectAndSolveCloudflare(tabId, url, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  // Step 1: Check if already solved (cf_clearance exists)
  let cfClearance = await extractCFClearance(tabId);
  if (cfClearance) {
    return { solved: true, cfClearance };
  }

  // Step 2: Navigate tab to the CF-protected URL to trigger challenge
  const navResult = await openCloudflarePage(tabId, url);
  if (!navResult.ok) {
    return { solved: false, error: `Could not navigate to ${url}` };
  }

  // Step 3: Wait for user to solve the challenge
  const waitResult = await waitForChallengeComplete(tabId, timeout);
  if (!waitResult.solved) {
    return { solved: false, error: "User did not complete the Cloudflare challenge within the timeout." };
  }

  // Step 4: Extract the cf_clearance cookie
  cfClearance = await extractCFClearance(tabId);
  if (!cfClearance) {
    return { solved: false, error: "Challenge appeared solved but cf_clearance cookie not found." };
  }

  return { solved: true, cfClearance };
}

/**
 * Navigate the tab to a Cloudflare-protected URL.
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<{ok: boolean}>}
 */
async function openCloudflarePage(tabId, url) {
  try {
    const api = typeof browser !== "undefined" ? browser : chrome;
    await api.tabs.update(tabId, { url });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * Poll for the cf_clearance cookie to appear, indicating the user solved
 * the Cloudflare challenge.
 *
 * @param {number} tabId
 * @param {number} timeoutMs - Max time to wait in ms.
 * @returns {Promise<{solved: boolean}>}
 */
async function waitForChallengeComplete(tabId, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const cfClearance = await extractCFClearance(tabId);
    if (cfClearance) {
      // Also verify the page is no longer showing a challenge
      const isChallenged = await isPageShowingChallenge(tabId);
      if (!isChallenged) {
        return { solved: true };
      }
    }
    await sleep(CHECK_INTERVAL_MS);
  }

  return { solved: false };
}

/**
 * Check if the page is still showing a Cloudflare challenge.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isPageShowingChallenge(tabId) {
  try {
    const api = typeof browser !== "undefined" ? browser : chrome;
    const result = await api.tabs.sendMessage(tabId, {
      type: "qwinCheckCloudflareChallenge",
    }).catch(() => null);
    if (result && result.hasChallenge === false) {
      return false;
    }
    // Fallback: assume still challenged if we can't verify
    return true;
  } catch (_e) {
    return true;
  }
}

/**
 * Extract cf_clearance cookie from the tab.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function extractCFClearance(tabId) {
  try {
    const cookies = await cookieExtraction.extractCookies(tabId);
    const cf = cookies.find((c) => c.name === CF_CLEARANCE_COOKIE);
    return cf ? cf.value : null;
  } catch (_e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  detectAndSolveCloudflare,
  openCloudflarePage,
  waitForChallengeComplete,
  extractCFClearance,
};
