"use strict";

import * as tabState from "./tab_state.js";
import * as downloadHelpers from "./download_helpers.js";
import * as downloadState from "./download_state.js";

// ─── Recording Progress Updates ──────────────────────────────────────────

let recordingUpdateTimer = null;

/** Update recording progress for all active recordings every 5 seconds. */
function startRecordingProgressUpdates(activeRecordingsRef) {
  if (recordingUpdateTimer) {
    return;
  }
  recordingUpdateTimer = setInterval(() => {
    const activeRecJobs = Object.keys(activeRecordingsRef);
    if (!activeRecJobs.length) {
      return;
    }

    const now = Date.now();
    for (const jobId of activeRecJobs) {
      const rec = activeRecordingsRef[jobId];
      const durationSec = Math.round((now - rec.startTime) / 1000);
      const sizeGuess = durationSec * 2.5 * 1024 * 1024; // ~2.5 MB per second estimate

      tabState.updateDownload(jobId, {
        recordingDuration: durationSec,
        recordingSizeBytes: sizeGuess,
        message: `Recording... ${formatDuration(durationSec)}, ${formatFileSize(sizeGuess)}`,
      });
    }
  }, 5000);
}

function stopRecordingProgressUpdates() {
  if (recordingUpdateTimer) {
    clearInterval(recordingUpdateTimer);
    recordingUpdateTimer = null;
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── MSE Segment Capture ─────────────────────────────────────────────────

// ─── Recording State ────────────────────────────────────────────────────────

/** Map of recording jobId → { tabId, port, startTime, filepath } */
const activeRecordings = {};

function getActiveRecordingsRef() {
  return activeRecordings;
}

function addActiveRecording(jobId, tabId, filepath) {
  activeRecordings[jobId] = {
    tabId,
    startTime: Date.now(),
    filepath: filepath || "",
  };
}

function removeActiveRecording(jobId) {
  const rec = activeRecordings[jobId];
  if (rec) {
    delete activeRecordings[jobId];
  }
  return rec || null;
}

function getActiveRecordings() {
  return Object.keys(activeRecordings).map((jobId) => {
    const rec = activeRecordings[jobId];
    const elapsedSec = Math.round((Date.now() - rec.startTime) / 1000);
    return {
      jobId,
      tabId: rec.tabId,
      startTime: rec.startTime,
      elapsedSec,
      elapsedFormatted: formatDuration(elapsedSec),
    };
  });
}

const mseSegmentsByTab = {};

function handleMseCapturedSegments(message, sender, senderTabIdFn) {
  const tabId = senderTabIdFn(message, sender);
  if (!tabId || !Array.isArray(message.segments)) {
    return;
  }

  if (!mseSegmentsByTab[tabId]) {
    mseSegmentsByTab[tabId] = [];
  }

  for (const segment of message.segments) {
    mseSegmentsByTab[tabId].push({
      streamId: segment.streamId,
      mimeType: segment.mimeType,
      data: segment.data,
      index: segment.index,
      timestamp: segment.timestamp,
      isLast: segment.isLast,
    });
  }

  const hasLast = message.segments.some((s) => s.isLast);
  return hasLast
    ? {
        tabId,
        totalSegments: mseSegmentsByTab[tabId].length,
        streams: groupMseStreams(tabId),
      }
    : null;
}

function groupMseStreams(tabId) {
  const segments = mseSegmentsByTab[tabId] || [];
  const streams = {};
  for (const seg of segments) {
    if (!streams[seg.streamId]) {
      streams[seg.streamId] = { mimeType: seg.mimeType, count: 0, hasLast: false };
    }
    streams[seg.streamId].count++;
    if (seg.isLast) {
      streams[seg.streamId].hasLast = true;
    }
  }
  return streams;
}

function getMseSegments(tabId) {
  return mseSegmentsByTab[tabId] || [];
}

function clearMseSegments(tabId) {
  delete mseSegmentsByTab[tabId];
}

// ─── Magnet Link Download ────────────────────────────────────────────────

async function downloadMagnet(
  message,
  notifyPopupFn,
  nativeRequestFn,
  connectNativeFn,
) {
  const magnetUrl = String(message.url || "").trim();
  if (!magnetUrl.startsWith("magnet:?")) {
    throw new Error("Invalid magnet link format.");
  }

  const jobId = `magnet_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const downloadFolder = String(message.downloadFolder || tabState.getSettings().downloadFolder || "");

  tabState.updateDownload(jobId, {
    id: jobId,
    url: magnetUrl,
    title: "Magnet link",
    format: "TORRENT",
    status: "connecting",
    message: "Connecting to BitTorrent network via aria2c...",
    downloadFolder,
    createdAt: Date.now(),
    ...downloadState.resetDownloadProgressDetails(),
    percent: null,
  });

  let port;
  let finished = false;

  try {
    port = connectNativeFn();
  } catch (error) {
    tabState.updateDownload(jobId, {
      status: "error",
      error: `Native messaging is not connected: ${error.message || error}`,
    });
    return { ok: true, jobId };
  }
  downloadHelpers.downloadPortsById[jobId] = port;

  port.onMessage.addListener((portMessage) => {
    if (!portMessage || portMessage.id !== jobId) {
      return;
    }

    if (portMessage.type === "started") {
      tabState.updateDownload(jobId, { status: "running", message: "Downloading via aria2c..." });
      return;
    }

    if (portMessage.type === "progress") {
      const patch = {
        status: "running",
        stage: portMessage.stage,
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
        ...downloadHelpers.progressDetailPatchFromMessage(portMessage),
      };
      if (typeof portMessage.percent === "number") {
        patch.percent = downloadHelpers.normalizeDownloadProgress(jobId, portMessage.percent);
        patch.message = downloadHelpers.downloadProgressMessage(patch.percent);
      }
      tabState.updateDownload(jobId, patch);
      return;
    }

    if (portMessage.type === "done") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      tabState.updateDownload(jobId, {
        status: "done",
        percent: 100,
        speed: "",
        eta: "",
        stage: "done",
        filepath: portMessage.filepath || "",
        artifactRoot: portMessage.artifactRoot || "",
        message: portMessage.message || "Magnet download complete.",
      });
      try { port.disconnect(); } catch (_error) {}
      return;
    }

    if (portMessage.type === "error") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      try { port.disconnect(); } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "error",
        error: portMessage.error || "aria2c failed to download the magnet link.",
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
      });
      return;
    }

    if (portMessage.type === "canceled") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      try { port.disconnect(); } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "canceled",
        message: portMessage.message || "Download canceled.",
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
      });
    }
  });

  port.onDisconnect.addListener(() => {
    delete downloadHelpers.downloadPortsById[jobId];
    if (!finished) {
      tabState.updateDownload(jobId, {
        status: "error",
        error: "Native messaging helper disconnected while downloading magnet link.",
      });
    }
  });

  port.postMessage({
    type: "magnet",
    id: jobId,
    url: magnetUrl,
    downloadFolder,
  });

  tabState.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper for magnet download.",
  });

  return { ok: true, jobId };
}

// ─── Torrent File Download ───────────────────────────────────────────────

async function downloadTorrent(
  message,
  connectNativeFn,
) {
  const torrentPath = String(message.path || "").trim();
  if (!torrentPath || !/\.torrent$/i.test(torrentPath)) {
    throw new Error("Select a valid .torrent file.");
  }

  const jobId = `torrent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const downloadFolder = String(message.downloadFolder || tabState.getSettings().downloadFolder || "");
  const torrentName = torrentPath.split(/[\\/]/).pop() || "Torrent file";

  tabState.updateDownload(jobId, {
    id: jobId,
    url: torrentPath,
    title: torrentName,
    format: "TORRENT",
    status: "connecting",
    message: "Connecting to BitTorrent network via aria2c...",
    downloadFolder,
    createdAt: Date.now(),
    ...downloadState.resetDownloadProgressDetails(),
    percent: null,
  });

  let port;
  let finished = false;

  try {
    port = connectNativeFn();
  } catch (error) {
    tabState.updateDownload(jobId, {
      status: "error",
      error: `Native messaging is not connected: ${error.message || error}`,
    });
    return { ok: true, jobId };
  }
  downloadHelpers.downloadPortsById[jobId] = port;

  port.onMessage.addListener((portMessage) => {
    if (!portMessage || portMessage.id !== jobId) {
      return;
    }

    if (portMessage.type === "started") {
      tabState.updateDownload(jobId, { status: "running", message: "Downloading via aria2c..." });
      return;
    }

    if (portMessage.type === "progress") {
      const patch = {
        status: "running",
        stage: portMessage.stage,
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
        ...downloadHelpers.progressDetailPatchFromMessage(portMessage),
      };
      if (typeof portMessage.percent === "number") {
        patch.percent = downloadHelpers.normalizeDownloadProgress(jobId, portMessage.percent);
        patch.message = downloadHelpers.downloadProgressMessage(patch.percent);
      }
      tabState.updateDownload(jobId, patch);
      return;
    }

    if (portMessage.type === "done") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      tabState.updateDownload(jobId, {
        status: "done",
        percent: 100,
        speed: "",
        eta: "",
        stage: "done",
        filepath: portMessage.filepath || "",
        artifactRoot: portMessage.artifactRoot || "",
        message: portMessage.message || "Torrent download complete.",
      });
      try { port.disconnect(); } catch (_error) {}
      return;
    }

    if (portMessage.type === "error") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      try { port.disconnect(); } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "error",
        error: portMessage.error || "aria2c failed to download the .torrent file.",
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
      });
      return;
    }

    if (portMessage.type === "canceled") {
      finished = true;
      delete downloadHelpers.downloadPortsById[jobId];
      try { port.disconnect(); } catch (_error) {}
      tabState.updateDownload(jobId, {
        status: "canceled",
        message: portMessage.message || "Download canceled.",
        ...downloadHelpers.artifactPatchFromMessage(portMessage),
      });
    }
  });

  port.onDisconnect.addListener(() => {
    delete downloadHelpers.downloadPortsById[jobId];
    if (!finished) {
      tabState.updateDownload(jobId, {
        status: "error",
        error: "Native messaging helper disconnected while downloading the .torrent file.",
      });
    }
  });

  port.postMessage({
    type: "torrentFile",
    id: jobId,
    path: torrentPath,
    downloadFolder,
  });

  tabState.updateDownload(jobId, {
    status: "queued",
    message: "Sent to native helper for .torrent download.",
  });

  return { ok: true, jobId };
}

export {
  startRecordingProgressUpdates,
  stopRecordingProgressUpdates,
  formatFileSize,
  formatDuration,

  activeRecordings,
  getActiveRecordingsRef,
  addActiveRecording,
  removeActiveRecording,
  getActiveRecordings,

  mseSegmentsByTab,
  handleMseCapturedSegments,
  groupMseStreams,
  getMseSegments,
  clearMseSegments,

  downloadMagnet,
  downloadTorrent,
};
