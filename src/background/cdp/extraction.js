"use strict";

/**
 * CDP video extraction — extractVideosFromTab, extractVideosWithMutationWatch.
 */

import { attach, detach, sendCommand } from "./session.js";
import { getExtractionScript, getMutationWatchScript } from "./scripts.js";
import { flattenFrameTree, evaluateInFrame } from "./iframe.js";

/**
 * Extract video sources from a tab using CDP.
 *
 * Flow:
 * 1. Attach CDP to the tab
 * 2. Inject the extraction script via Runtime.evaluate
 * 3. Parse the returned video sources
 * 4. If recursive: discover child frames and extract from each too
 * 5. Optionally detach (or keep attached for future use)
 *
 * @param {number} tabId - The browser tab ID to extract from.
 * @param {Object} [options]
 * @param {boolean} [options.recursive=false] - Whether to recursively search child frames/iframes.
 * @param {number} [options.timeout=15000] - Maximum time to wait for extraction (ms).
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after extraction.
 * @returns {Promise<{ok: boolean, videos: Array, error?: string, frames?: Array}>}
 */
async function extractVideosFromTab(tabId, options = {}) {
  const recursive = options.recursive === true;
  const timeout = options.timeout || 15000;
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, videos: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, videos: [], error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Track all unique videos across all frames
  const allVideos = [];
  const seenUrls = new Set();
  const allFrames = [];

  /**
   * Add video results, deduplicating by URL.
   * @param {Array} videos
   */
  function addVideos(videos) {
    if (!Array.isArray(videos)) return;
    for (const v of videos) {
      if (v && v.url && !seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        allVideos.push(v);
      }
    }
  }

  // Extract from the top-level frame
  const script = getExtractionScript();
  let mainFrameResult;

  if (recursive) {
    // Enable Page domain to get frame tree
    await sendCommand(tabId, "Page.enable", {}).catch(() => {});
    const treeResult = await sendCommand(tabId, "Page.getFrameTree", {});

    if (treeResult.ok && treeResult.result && treeResult.result.frameTree) {
      const frames = flattenFrameTree(treeResult.result.frameTree);

      // Extract from each frame
      for (const frameInfo of frames) {
        // Tag the frame as browsed
        allFrames.push(frameInfo);

        const frameVideos = await evaluateInFrame(tabId, frameInfo, { timeout });
        addVideos(frameVideos);
      }
    } else {
      // Fallback to main frame only if frame tree fails
      mainFrameResult = await sendCommand(tabId, "Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: false,
        timeout: timeout,
      });

      if (mainFrameResult.ok && mainFrameResult.result) {
        try {
          const resultValue = mainFrameResult.result;
          if (
            resultValue &&
            resultValue.result &&
            resultValue.result.type === "object" &&
            Array.isArray(resultValue.result.value)
          ) {
            addVideos(resultValue.result.value);
          }
        } catch (_error) {}
      }
    }
  } else {
    // Non-recursive: extract from top frame only (original behavior)
    const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: false,
      timeout: timeout,
    });

    if (!evaluateResult.ok) {
      if (detachAfter) {
        await detach(tabId);
      }
      return { ok: false, videos: [], error: evaluateResult.error || "Runtime.evaluate failed." };
    }

    // Parse the extraction result
    const resultValue = evaluateResult.result;
    try {
      if (
        resultValue &&
        resultValue.result &&
        resultValue.result.type === "object" &&
        Array.isArray(resultValue.result.value)
      ) {
        addVideos(resultValue.result.value);
      }
    } catch (_error) {
      // Malformed result, treat as empty
    }
  }

  if (detachAfter) {
    await detach(tabId);
  }

  const result = { ok: true, videos: allVideos };

  if (recursive && allFrames.length > 0) {
    result.frames = allFrames;
  }

  return result;
}

/**
 * Extract videos from a tab while watching for mutations (dynamically-added
 * video elements). Injects a MutationObserver via CDP and waits for videos
 * to appear or until the timeout expires.
 *
 * Strategy:
 * 1. Attach CDP to the tab
 * 2. Inject a script that sets up a MutationObserver on the document
 * 3. The script performs an initial scan and then watches for changes
 * 4. Returns videos as soon as any are found, or after timeout
 *
 * @param {number} tabId - The browser tab ID.
 * @param {Object} [options]
 * @param {number} [options.timeout=10000] - Maximum time to watch for mutations (ms).
 * @param {number} [options.pollInterval=500] - How often to re-scan for videos (ms).
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after watching.
 * @returns {Promise<{ok: boolean, videos: Array, timedOut?: boolean, error?: string}>}
 */
async function extractVideosWithMutationWatch(tabId, options = {}) {
  const timeout = options.timeout || 10000;
  const pollInterval = options.pollInterval || 500;
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, videos: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, videos: [], error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Inject the mutation watch script via Runtime.evaluate
  // The script is async (returns a Promise), so we need awaitPromise: true
  const watchScript = getMutationWatchScript(pollInterval, timeout);

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: watchScript,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeout + 2000, // Allow some buffer for script execution
  });

  if (!evaluateResult.ok) {
    if (detachAfter) {
      await detach(tabId);
    }
    return { ok: false, videos: [], error: evaluateResult.error || "Mutation watch script evaluation failed." };
  }

  // Parse the mutation watch result
  let videos = [];
  let timedOut = false;

  try {
    const resultValue = evaluateResult.result;
    if (
      resultValue &&
      resultValue.result &&
      resultValue.result.type === "object" &&
      resultValue.result.value
    ) {
      const value = resultValue.result.value;
      if (Array.isArray(value.videos)) {
        videos = value.videos;
      }
      if (typeof value.timedOut === "boolean") {
        timedOut = value.timedOut;
      }
    }
  } catch (_error) {
    // Malformed result, treat as empty
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true, videos, timedOut };
}

export { extractVideosFromTab, extractVideosWithMutationWatch };
