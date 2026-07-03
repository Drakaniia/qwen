"use strict";

/**
 * CDP event simulation — simulateVideoEvents.
 */

import { attach, detach, sendCommand } from "./session.js";
import { getEventSimulationScript } from "./scripts.js";

/**
 * Simulate load() and play() events on video elements matching the given URLs.
 * This triggers lazy-loaded players to initialize and start streaming.
 *
 * Some sites (e.g., custom video players) defer loading until the user interacts
 * or the video element explicitly receives a load/play call. By simulating these
 * events via CDP, we force the player to initialize its media pipeline so that
 * subsequent extraction can detect the video sources.
 *
 * @param {number} tabId - The browser tab ID.
 * @param {string[]} [videoUrls] - Array of video URLs to target. If empty or omitted, a no-op is returned.
 * @param {Object} [options]
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after simulation.
 * @returns {Promise<{ok: boolean, triggered?: boolean, loadCount?: number, playCount?: number, error?: string}>}
 */
async function simulateVideoEvents(tabId, videoUrls, options = {}) {
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, triggered: false, error: "Invalid tabId: must be a positive integer." };
  }

  // If no URLs provided, nothing to simulate
  if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
    return { ok: true, triggered: false, loadCount: 0, playCount: 0 };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, triggered: false, error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Inject the event simulation script via Runtime.evaluate
  const simulationScript = getEventSimulationScript(videoUrls);

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: simulationScript,
    returnByValue: true,
    awaitPromise: false,
    timeout: 10000,
  });

  if (!evaluateResult.ok) {
    if (detachAfter) {
      await detach(tabId);
    }
    return { ok: false, triggered: false, error: evaluateResult.error || "Event simulation script evaluation failed." };
  }

  // Parse the simulation result
  let triggered = false;
  let loadCount = 0;
  let playCount = 0;

  try {
    const resultValue = evaluateResult.result;
    if (resultValue && resultValue.result && resultValue.result.type === "object" && resultValue.result.value) {
      const value = resultValue.result.value;
      triggered = value.triggered === true;
      loadCount = typeof value.loadCount === "number" ? value.loadCount : 0;
      playCount = typeof value.playCount === "number" ? value.playCount : 0;
    }
  } catch (_error) {
    // Malformed result
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true, triggered, loadCount, playCount };
}

export { simulateVideoEvents };
