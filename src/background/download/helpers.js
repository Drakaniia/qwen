"use strict";

/**
 * Debug log helper — sends a debug entry to the popup via notifyPopup.
 * @param {Object} deps - Dependency object with notifyPopup
 * @param {string} level - "info", "warn", "error", "debug"
 * @param {string} message - Log message
 * @param {string|Object} [details] - Optional details
 */
export function dlDebug(deps, level, message, details) {
  try {
    deps.notifyPopup({ type: "downloadDebugLog", level, message, details: details || "" });
  } catch (_e) {
    // best-effort
  }
}

/**
 * Check if an error message indicates a Cloudflare anti-bot block.
 * @param {string} errorText
 * @returns {boolean}
 */
export function isCloudflareBlockError(errorText) {
  if (!errorText) return false;
  const text = String(errorText).toLowerCase();
  return (
    text.includes("cloudflare") ||
    text.includes("cf-ray") ||
    (text.includes("anti-bot") && text.includes("protection")) ||
    (text.includes("challenge") && (text.includes("blocked") || text.includes("protection")))
  );
}
