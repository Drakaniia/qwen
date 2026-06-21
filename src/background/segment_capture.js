"use strict";

/**
 * Segment Capture Pipeline (Phase 1c)
 *
 * Orchestrates the capture of MSE/Blob video segments from the content script
 * and forwards them to the native host for reassembly into a playable file.
 *
 * Flow:
 *   1. startCapture(tabId) → sends mseInitCapture to content script
 *   2. Content captures segments via MediaSource/SourceBuffer interception
 *   3. addSegments(tabId, segments) accumulates segments in memory
 *   4. stopCapture(tabId) → sends assembleSegments to native host → cleanup
 *
 * The actual MSE interception happens in media_source_intercept.js (content script).
 * This module orchestrates the lifecycle and bridges to the native host.
 */

import { browserApi } from "../shared/browser_api.js";

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CaptureSession
 * @property {number} tabId
 * @property {string} title
 * @property {string} url
 * @property {Array<Object>} segments
 * @property {number} startedAt
 * @property {boolean} active
 */

/** @type {Map<number, CaptureSession>} */
const activeCaptures = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateJobId() {
  return `seg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start segment capture on a tab.
 *
 * Initializes capture state and sends a message to the content script
 * to ensure MSE interception is active.
 *
 * @param {number} tabId - The browser tab ID to capture.
 * @param {Object} [options] - Optional capture options.
 * @param {string} [options.title] - Video title for the assembled file.
 * @param {string} [options.url] - Source URL of the video.
 * @returns {Promise<{ok: boolean, tabId?: number, error?: string}>}
 */
async function startCapture(tabId, options = {}) {
  if (!tabId || !Number.isInteger(tabId)) {
    return { ok: false, error: "Invalid tabId: must be a positive integer." };
  }

  if (activeCaptures.has(tabId)) {
    return { ok: false, error: `Segment capture is already active on tab ${tabId}.` };
  }

  // Initialize capture state
  activeCaptures.set(tabId, {
    tabId,
    title: options.title || "Video",
    url: options.url || "",
    segments: [],
    startedAt: Date.now(),
    active: true,
  });

  // Signal the content script to ensure MSE interception is running
  try {
    await browserApi.tabs.sendMessage(tabId, {
      type: "mseInitCapture",
      tabId,
    });
  } catch (_error) {
    // Content script may not be loaded yet or tab may not be ready.
    // MSE interception is initialized on page load, so this is a best-effort signal.
  }

  return { ok: true, tabId };
}

/**
 * Add captured segments to the session for a tab.
 *
 * Called by the mseCapturedSegments message handler in background.js.
 *
 * @param {number} tabId - The tab ID the segments came from.
 * @param {Array<Object>} segments - Array of captured segment objects.
 * @returns {{ok: boolean, error?: string}}
 */
function addSegments(tabId, segments) {
  const session = activeCaptures.get(tabId);
  if (!session || !session.active) {
    return {
      ok: false,
      error: `No active segment capture for tab ${tabId}. Call startCapture() first.`,
    };
  }

  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: true };
  }

  for (const seg of segments) {
    session.segments.push({
      streamId: seg.streamId || "unknown",
      mimeType: seg.mimeType || "",
      data: seg.data || "", // base64-encoded
      index: typeof seg.index === "number" ? seg.index : session.segments.length,
      timestamp: typeof seg.timestamp === "number" ? seg.timestamp : 0,
      isLast: Boolean(seg.isLast),
    });
  }

  return { ok: true };
}

/**
 * Stop segment capture on a tab and forward segments to native host for assembly.
 *
 * Sends an assembleSegments message to the native host with all captured segments.
 * Cleans up capture state after forwarding.
 *
 * @param {number} tabId - The tab ID to stop capture on.
 * @returns {Promise<{ok: boolean, jobId?: string, segmentCount?: number, error?: string}>}
 */
async function stopCapture(tabId) {
  const session = activeCaptures.get(tabId);
  if (!session || !session.active) {
    return { ok: true, jobId: "", segmentCount: 0 };
  }

  const segmentCount = session.segments.length;

  // If no segments were captured, just clean up and return early
  if (segmentCount === 0) {
    activeCaptures.delete(tabId);
    return { ok: true, jobId: "", segmentCount: 0 };
  }

  const jobId = generateJobId();

  try {
    // Send segments to native host for reassembly via background message
    const response = await browserApi.runtime.sendMessage({
      type: "assembleSegments",
      tabId,
      jobId,
      title: session.title,
      url: session.url,
      streams: groupStreams(session.segments),
      segments: session.segments.map((s) => ({
        streamId: s.streamId,
        mimeType: s.mimeType,
        data: s.data,
        index: s.index,
        timestamp: s.timestamp,
        isLast: s.isLast,
      })),
    });

    activeCaptures.delete(tabId);

    if (response && response.ok) {
      return {
        ok: true,
        jobId: response.jobId || jobId,
        segmentCount,
        filepath: response.filepath || "",
      };
    }

    return {
      ok: true,
      jobId,
      segmentCount,
      warning: response?.error || "Assembly request sent but no confirmation received.",
    };
  } catch (error) {
    activeCaptures.delete(tabId);
    return {
      ok: true,
      jobId,
      segmentCount,
      warning: `Assembly request sent but native host communication failed: ${error.message || error}`,
    };
  }
}

/**
 * Group segments by stream ID for reporting.
 *
 * @param {Array<Object>} segments
 * @returns {Object} Map of streamId → count
 */
function groupStreams(segments) {
  const streams = {};
  for (const seg of segments) {
    if (!streams[seg.streamId]) {
      streams[seg.streamId] = 0;
    }
    streams[seg.streamId]++;
  }
  return streams;
}

/**
 * Get the capture status for a tab.
 *
 * @param {number} tabId
 * @returns {{active: boolean, tabId: number, segmentCount: number, streamCount: number, streams: Object, title?: string, startedAt?: number}}
 */
function getStatus(tabId) {
  const session = activeCaptures.get(tabId);
  if (!session || !session.active) {
    return {
      active: false,
      tabId,
      segmentCount: 0,
      streamCount: 0,
      streams: {},
    };
  }

  return {
    active: true,
    tabId: session.tabId,
    title: session.title,
    startedAt: session.startedAt,
    segmentCount: session.segments.length,
    streamCount: Object.keys(groupStreams(session.segments)).length,
    streams: groupStreams(session.segments),
  };
}

/**
 * Stop all active segment captures.
 */
function stopAll() {
  for (const [tabId] of activeCaptures) {
    // Silently clean up — no segments forwarded
    activeCaptures.delete(tabId);
  }
}

export { startCapture, stopCapture, addSegments, getStatus, stopAll };
