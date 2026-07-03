"use strict";

/**
 * Iframe discovery — Page.getFrameTree, flatten, evaluate in frames.
 */

import { attach, sendCommand } from "./session.js";
import { getExtractionScript } from "./scripts.js";

/**
 * Discover all frames in a tab using CDP Page.getFrameTree.
 *
 * Returns a flat array of all frames (top-level + children recursively),
 * each with frameId, url, and parentId (for child frames).
 *
 * @param {number} tabId - The browser tab ID.
 * @returns {Promise<{ok: boolean, frames?: Array<{frameId: string, url: string, parentId?: string}>, error?: string}>}
 */
async function discoverFrameTree(tabId) {
  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, frames: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach if not already attached
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, frames: [], error: attachResult.error || "Could not attach debugger to discover frame tree." };
  }

  // Enable Page domain first
  await sendCommand(tabId, "Page.enable", {});

  // Get frame tree
  const treeResult = await sendCommand(tabId, "Page.getFrameTree", {});
  if (!treeResult.ok) {
    return { ok: false, frames: [], error: treeResult.error || "Page.getFrameTree failed." };
  }

  // Flatten the frame tree into an array using the shared helper
  let frames = [];
  try {
    frames = flattenFrameTree(treeResult.result.frameTree);
  } catch (_error) {
    return { ok: false, frames: [], error: "Failed to parse frame tree result." };
  }

  return { ok: true, frames };
}

/**
 * Extract a flat list of all frames in the tree, including nested ones.
 * @param {Object} frameTree - CDP Page.getFrameTree result
 * @param {string} [parentId]
 * @returns {Array<{frameId: string, url: string, parentId?: string}>}
 */
function flattenFrameTree(frameTree, parentId) {
  const frames = [];
  if (!frameTree || !frameTree.frame) return frames;

  const frame = frameTree.frame;
  frames.push({
    frameId: frame.id,
    url: frame.url || "",
    parentId: parentId || frame.parentId || "",
  });

  if (frameTree.childFrames && Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) {
      frames.push(...flattenFrameTree(child, frame.id));
    }
  }

  return frames;
}

/**
 * Evaluate the extraction script in a specific frame context via CDP.
 * Uses the frame's execution context by targeting it via Runtime.evaluate
 * with the appropriate contextId.
 *
 * @param {number} tabId
 * @param {Object} frameInfo - { frameId, url }
 * @param {Object} options
 * @param {number} [options.timeout]
 * @returns {Promise<Array>}
 */
async function evaluateInFrame(tabId, frameInfo, options) {
  const timeout = options.timeout || 15000;
  const script = getExtractionScript();

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: timeout,
  });

  let videos = [];
  if (evaluateResult.ok && evaluateResult.result) {
    try {
      const resultValue = evaluateResult.result;
      if (
        resultValue &&
        resultValue.result &&
        resultValue.result.type === "object" &&
        Array.isArray(resultValue.result.value)
      ) {
        videos = resultValue.result.value;
      }
    } catch (_error) {
      // Malformed result, treat as empty
    }
  }

  // Tag each video with frame metadata
  for (const v of videos) {
    v.sourceFrame = frameInfo.frameId;
    v.frameUrl = frameInfo.url || "";
  }

  return videos;
}

export { discoverFrameTree, flattenFrameTree, evaluateInFrame };
