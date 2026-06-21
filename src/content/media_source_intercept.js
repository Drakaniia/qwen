"use strict";

/**
 * MSE / Blob URL Interception Module
 *
 * Intercepts the MediaSource API and URL.createObjectURL to capture
 * raw video segments from custom HTML5 players (Vimeo OTT, JW Player,
 * Shaka Player, and other MediaSource-based players).
 *
 * Strategy (§5.3):
 * 1. Override MediaSource constructor to wrap SourceBuffer.appendBuffer()
 * 2. Override URL.createObjectURL to track blob → MediaSource mappings
 * 3. Capture raw appended segments as ArrayBuffers
 * 4. Send captured segments to the background script via runtime messages
 *    for re-assembly into a playable file.
 *
 * This runs in-page (content script context), so captured segments are
 * sent via the extension messaging API, not native messaging.
 */

const extensionApi = typeof browser !== "undefined" ? browser : chrome;

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Map<string, { segments: ArrayBuffer[], mimeType: string, duration: number }>} */
const capturedStreams = new Map();

/** @type {Map<string, MediaSource>} */
const blobToMediaSource = new Map();

/** @type {Set<MediaSource>} */
const interceptedSources = new WeakSet();

/** @type {Set<SourceBuffer>} */
const interceptedBuffers = new WeakSet();

let originalCreateObjectURL = null;
let originalMediaSource = null;

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  /** Maximum total bytes to capture per stream before stopping (100 MB). */
  maxBytesPerStream: 100 * 1024 * 1024,

  /** Maximum segments to capture per stream. */
  maxSegmentsPerStream: 500,

  /** Whether to capture audio SourceBuffers (true) or only video (false). */
  captureAudio: true,

  /** Minimum segment size in bytes to consider worth sending (smaller = init segments). */
  minSegmentBytes: 256,

  /** Debounce interval (ms) for batch-sending captured segments to background. */
  batchIntervalMs: 2000,
};

// ─── Batch sender ──────────────────────────────────────────────────────────

let batchSendTimer = null;
const pendingSegments = [];

function scheduleBatchSend() {
  if (batchSendTimer) {
    return;
  }
  batchSendTimer = setTimeout(() => {
    batchSendTimer = null;
    flushPendingSegments();
  }, CONFIG.batchIntervalMs);
}

function flushPendingSegments() {
  if (!pendingSegments.length) {
    return;
  }

  // Send in batches of at most 20 to avoid exceeding Chrome's message size limit
  const BATCH_SIZE = 20;
  const batch = pendingSegments.splice(0, BATCH_SIZE);

  try {
    extensionApi.runtime.sendMessage({
      type: "mseCapturedSegments",
      segments: batch.map((s) => ({
        streamId: s.streamId,
        mimeType: s.mimeType,
        data: s.data, // base64-encoded ArrayBuffer
        index: s.index,
        timestamp: s.timestamp,
        isLast: s.isLast,
      })),
      hasMore: pendingSegments.length > 0,
    });
  } catch (_error) {
    // Extension context may have been destroyed
  }

  // If more segments remain, schedule another flush immediately
  if (pendingSegments.length > 0) {
    scheduleBatchSend();
  }
}

function enqueueSegment(streamId, mimeType, data, index, timestamp, isLast = false) {
  if (pendingSegments.length >= CONFIG.maxSegmentsPerStream * 2) {
    return; // Too many pending, drop
  }

  // Convert ArrayBuffer to base64 for messaging
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  pendingSegments.push({
    streamId,
    mimeType,
    data: base64,
    index,
    timestamp: timestamp || 0,
    isLast,
  });

  scheduleBatchSend();
}

// ─── SourceBuffer interception ──────────────────────────────────────────────

function interceptSourceBuffer(sourceBuffer, streamId, mimeType) {
  if (interceptedBuffers.has(sourceBuffer)) {
    return;
  }
  interceptedBuffers.add(sourceBuffer);

  const originalAppendBuffer = sourceBuffer.appendBuffer.bind(sourceBuffer);
  let segmentIndex = 0;
  let totalBytes = 0;

  sourceBuffer.appendBuffer = function (data) {
    const stream = capturedStreams.get(streamId);
    if (!stream) {
      // Stream was cleaned up
      originalAppendBuffer(data);
      return;
    }

    // Capture the segment
    if (
      data instanceof ArrayBuffer &&
      stream.segments.length < CONFIG.maxSegmentsPerStream &&
      totalBytes < CONFIG.maxBytesPerStream &&
      data.byteLength >= CONFIG.minSegmentBytes
    ) {
      const copy = data.slice(0); // Clone the buffer
      stream.segments.push(copy);
      totalBytes += copy.byteLength;
      enqueueSegment(streamId, mimeType, copy, segmentIndex, sourceBuffer.timestampOffset || 0);
    }

    segmentIndex++;
    originalAppendBuffer(data);
  };

  // Intercept abort to mark as last
  const originalAbort = sourceBuffer.abort.bind(sourceBuffer);
  sourceBuffer.abort = function () {
    enqueueSegment(streamId, mimeType, new ArrayBuffer(0), segmentIndex, 0, true);
    return originalAbort();
  };

  return sourceBuffer;
}

// ─── MediaSource interception ───────────────────────────────────────────────

function createInterceptedMediaSource() {
  const ms = new originalMediaSource();

  if (interceptedSources.has(ms)) {
    return ms;
  }
  interceptedSources.add(ms);

  const streamId = `mse_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  capturedStreams.set(streamId, {
    segments: [],
    mimeType: "",
    duration: 0,
  });

  // Intercept addSourceBuffer
  const originalAddSourceBuffer = ms.addSourceBuffer.bind(ms);
  ms.addSourceBuffer = function (mimeType) {
    const sb = originalAddSourceBuffer(mimeType);

    if (!CONFIG.captureAudio && mimeType.startsWith("audio/")) {
      return sb;
    }

    const stream = capturedStreams.get(streamId);
    if (stream && !stream.mimeType) {
      stream.mimeType = mimeType;
    }

    return interceptSourceBuffer(sb, streamId, mimeType);
  };

  // Intercept duration setter to capture final duration
  const durationDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ms), "duration");
  if (durationDescriptor && durationDescriptor.set) {
    const originalSetDuration = durationDescriptor.set.bind(ms);
    Object.defineProperty(ms, "duration", {
      get() {
        return originalMediaSource.prototype.duration;
      },
      set(value) {
        originalSetDuration(value);
        const stream = capturedStreams.get(streamId);
        if (stream) {
          stream.duration = value;
        }
      },
      configurable: true,
    });
  }

  // Intercept endOfStream to mark completion
  const originalEndOfStream = ms.endOfStream.bind(ms);
  ms.endOfStream = function (reason) {
    enqueueSegment(streamId, "", new ArrayBuffer(0), -1, 0, true);
    return originalEndOfStream(reason);
  };

  return ms;
}

// ─── URL.createObjectURL interception ──────────────────────────────────────

function interceptedCreateObjectURL(obj) {
  if (obj instanceof MediaSource || (obj && obj.toString && obj.toString().includes("MediaSource"))) {
    const blobUrl = originalCreateObjectURL(obj);
    blobToMediaSource.set(blobUrl, obj);
    return blobUrl;
  }

  if (obj && obj.type && obj.type.startsWith("video/")) {
    // Track blob URLs for direct video blobs (not MediaSource-based)
    const blobUrl = originalCreateObjectURL(obj);
    return blobUrl;
  }

  return originalCreateObjectURL(obj);
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Release all captured stream data and restore originals.
 */
function cleanup() {
  capturedStreams.clear();
  blobToMediaSource.clear();

  if (batchSendTimer) {
    clearTimeout(batchSendTimer);
    batchSendTimer = null;
  }
  flushPendingSegments();

  // Restore originals
  if (originalCreateObjectURL && URL.createObjectURL !== interceptedCreateObjectURL) {
    URL.createObjectURL = originalCreateObjectURL;
  }
  if (originalMediaSource && window.MediaSource !== createInterceptedMediaSource) {
    window.MediaSource = originalMediaSource;
  }
}

/**
 * Get a summary of captured streams (for diagnostics).
 * @returns {Array<{streamId: string, mimeType: string, segments: number, totalBytes: number}>}
 */
function getCapturedStreamsSummary() {
  const result = [];
  for (const [streamId, stream] of capturedStreams) {
    result.push({
      streamId,
      mimeType: stream.mimeType,
      segments: stream.segments.length,
      totalBytes: stream.segments.reduce((acc, s) => acc + s.byteLength, 0),
      duration: stream.duration,
    });
  }
  return result;
}

// ─── Init ──────────────────────────────────────────────────────────────────

function init() {
  // Store originals
  originalCreateObjectURL = URL.createObjectURL;
  originalMediaSource = window.MediaSource;

  // Override MediaSource
  if (window.MediaSource && !window.__qwinMseIntercepted) {
    window.MediaSource = createInterceptedMediaSource;
    window.__qwinMseIntercepted = true;
  }

  // Override URL.createObjectURL
  if (URL.createObjectURL !== interceptedCreateObjectURL) {
    URL.createObjectURL = interceptedCreateObjectURL;
  }

  // Listen for messages from background
  extensionApi.runtime.onMessage.addListener((message) => {
    if (message && message.type === "mseCleanupCapture") {
      cleanup();
      return false;
    }
    // Ensure MSE interception is active (best-effort signal from background)
    if (message && message.type === "mseInitCapture") {
      if (!window.__qwinMseIntercepted) {
        init();
      }
      return false;
    }
  });
}

export { init, cleanup, getCapturedStreamsSummary, capturedStreams };

export default { init, cleanup, getCapturedStreamsSummary };
