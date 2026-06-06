(function attachQwinDownloadState(root, factory) {
  const downloadState = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = downloadState;
  }
  root.QwinDownloadState = downloadState;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinDownloadState() {
  "use strict";

  function clampDownloadPercent(percent) {
    const value = Number(percent);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(100, value));
  }

  function normalizeDownloadProgress(existingPercent, percent) {
    const nextPercent = clampDownloadPercent(percent);
    if (nextPercent === null) {
      return null;
    }

    const currentPercent = clampDownloadPercent(existingPercent);
    const previousPercent = currentPercent === null ? 0 : currentPercent;
    const activePercent = nextPercent >= 100 ? 99 : nextPercent;
    return Math.max(previousPercent, activePercent);
  }

  function visibleDownloadProgressPercent(existingPercent, percent, useToolPercent = false) {
    const nextPercent = clampDownloadPercent(percent);
    if (nextPercent === null) {
      return null;
    }
    return useToolPercent ? nextPercent : normalizeDownloadProgress(existingPercent, nextPercent);
  }

  function downloadProgressMessage(percent) {
    const value = clampDownloadPercent(percent) || 0;
    return `${Math.round(value)}% downloaded`;
  }

  function cleanProgressText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > 500 ? text.slice(0, 500) : text;
  }

  function resetDownloadProgressDetails() {
    return {
      rawPercent: null,
      downloadedSize: "",
      totalSize: "",
      speed: "",
      eta: "",
      connections: null,
      fragment: "",
      rawProgressLine: "",
    };
  }

  function progressDetailPatchFromMessage(message) {
    const rawPercent = clampDownloadPercent(message.percent);
    const connections = Number(message.connections || 0);
    const patch = {
      rawPercent,
      downloadedSize: cleanProgressText(message.downloadedSize),
      totalSize: cleanProgressText(message.totalSize),
      speed: cleanProgressText(message.speed),
      eta: cleanProgressText(message.eta),
      connections: Number.isFinite(connections) && connections > 0 ? connections : null,
      fragment: cleanProgressText(message.fragment),
      rawProgressLine: cleanProgressText(message.line),
    };

    return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  }

  return {
    clampDownloadPercent,
    cleanProgressText,
    downloadProgressMessage,
    normalizeDownloadProgress,
    progressDetailPatchFromMessage,
    resetDownloadProgressDetails,
    visibleDownloadProgressPercent,
  };
});
