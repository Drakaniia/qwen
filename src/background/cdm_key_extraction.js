"use strict";

/**
 * CDM Key Extraction Pipeline
 *
 * Captured license exchange → native host → Go binary key extraction.
 * Extracted from cdm_network_intercept.js.
 */

/**
 * Send a captured license exchange through the Go binary's key extraction pipeline.
 *
 * This should be called after a license exchange is completed (response received).
 * It sends the request through: extension → native host → Go binary for key extraction.
 *
 * @param {Object} exchange - A completed exchange from getCapturedExchanges().
 * @param {Function} nativeRequestFn - Function to send native messaging requests.
 * @returns {Promise<{ok: boolean, keys?: Array, l1Only?: boolean, error?: string}>}
 */
async function extractKeysFromExchange(exchange, nativeRequestFn) {
  if (!exchange || !exchange.responseBody) {
    return { ok: false, error: "Completed license exchange with responseBody required." };
  }

  const sessionId = `${exchange.tabId || 0}_${exchange.requestId || Date.now()}`;

  try {
    const response = await nativeRequestFn(
      {
        type: "extractKeys",
        id: `extract_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        sessionId,
        responseB64: exchange.responseBody,
        challengeB64: exchange.postData || "",
        initDataB64: "",
      },
      60000,
    );

    return {
      ok: response?.ok !== false,
      sessionId: response?.sessionId || sessionId,
      keys: response?.keys || [],
      l1Only: Boolean(response?.l1Only),
      error: response?.error || "",
    };
  } catch (error) {
    return { ok: false, error: `Key extraction failed: ${error.message || error}` };
  }
}

/**
 * Extract keys from ALL completed exchanges.
 *
 * @param {Function} nativeRequestFn - Function to send native messaging requests.
 * @param {Function} getCapturedExchangesFn - Function to get captured exchanges.
 * @param {Function} clearCapturedExchangesFn - Function to clear captured exchanges.
 * @returns {Promise<Array<{exchange: Object, result: Object}>>}
 */
async function extractKeysFromAllExchanges(nativeRequestFn, getCapturedExchangesFn, clearCapturedExchangesFn) {
  const exchanges = getCapturedExchangesFn();
  const completed = exchanges.filter((ex) => ex.status === "completed" && ex.responseBody);

  const results = [];
  for (const exchange of completed) {
    const result = await extractKeysFromExchange(exchange, nativeRequestFn);
    results.push({ exchange, result });
  }

  // Auto-clear after extraction to minimize the window during which
  // DRM key material exists in memory. Once keys are extracted, the
  // raw license responses are no longer needed.
  clearCapturedExchangesFn();

  return results;
}

export { extractKeysFromExchange, extractKeysFromAllExchanges };
