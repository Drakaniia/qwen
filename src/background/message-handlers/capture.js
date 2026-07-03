"use strict";

/**
 * Recording and segment capture message handlers.
 */

export function registerCaptureHandlers(messageRouter, ctx) {
  const { recording, segmentCapture, tabState, nativeRequest, notifyPopup } = ctx;

  // ── Recording handlers ─────────────────────────────────────────────────

  messageRouter.handle("startRecording", async (message) => {
    const tabId = Number(message.tabId) || 0;
    const options = message.options || {};
    const jobId = options.jobId || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    if (!tabId) {
      return { ok: false, error: "No tab ID provided for recording." };
    }

    const recordingJob = {
      id: jobId,
      tabId,
      title: options.title || "Screen recording",
      format: "RECORDING",
      status: "connecting",
      message: "Starting screen recording...",
      url: options.url || "",
      videoId: jobId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stage: "recording",
      isRecording: true,
      recordingDuration: 0,
      recordingSizeBytes: 0,
      recordingFps: 0,
      recordingDroppedFrames: 0,
      percent: null,
    };

    tabState.updateDownload(jobId, recordingJob);

    try {
      const nativeResponse = await nativeRequest(
        {
          type: "startRecording",
          id: `rec_start_${Date.now()}`,
          tabId,
          jobId,
          outputPath: "",
          quality: "best",
        },
        15000,
      );

      if (nativeResponse && nativeResponse.ok) {
        recording.addActiveRecording(jobId, tabId, nativeResponse.filepath || "");
        tabState.updateDownload(jobId, {
          status: "running",
          message: nativeResponse.message || "Recording started.",
          filepath: nativeResponse.filepath || "",
        });
        return { ok: true, jobId };
      }

      recording.addActiveRecording(jobId, tabId, "");
      tabState.updateDownload(jobId, {
        status: "running",
        message: "Recording... (native capture not yet available, placeholder mode)",
      });
      return { ok: true, jobId };
    } catch (_error) {
      tabState.updateDownload(jobId, {
        status: "running",
        message: "Recording... (native capture not yet available, placeholder mode)",
      });
      return { ok: true, jobId };
    }
  });

  messageRouter.handle("stopRecording", async (message) => {
    const jobId = message.jobId;
    const rec = recording.removeActiveRecording(jobId);

    if (!rec) {
      return { ok: false, error: "Recording job not found." };
    }

    try {
      await nativeRequest(
        {
          type: "stopRecording",
          id: `rec_stop_${Date.now()}`,
          jobId,
        },
        10000,
      );
    } catch (_error) {}

    const durationSec = Math.round((Date.now() - rec.startTime) / 1000);
    const durationStr = recording.formatDuration(durationSec);

    tabState.updateDownload(jobId, {
      status: "done",
      stage: "done",
      isRecording: false,
      recordingDuration: durationSec,
      message: `Recording complete. Duration: ${durationStr}.`,
      percent: 100,
    });

    return { ok: true, jobId };
  });

  messageRouter.handle("getRecordingStatus", async () => {
    const jobs = recording.getActiveRecordings().map((rec) => ({
      jobId: rec.jobId,
      tabId: rec.tabId,
      elapsedSec: rec.elapsedSec,
      elapsedFormatted: rec.elapsedFormatted,
    }));
    return { ok: true, activeRecordings: jobs };
  });

  // ── Segment capture handlers ──────────────────────────────────────────

  messageRouter.handle("startSegmentCapture", async (message) => {
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided for segment capture." };
    }
    return segmentCapture.startCapture(tabId, {
      title: message.title || "Video",
      url: message.url || "",
    });
  });

  messageRouter.handle("stopSegmentCapture", async (message) => {
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    return segmentCapture.stopCapture(tabId);
  });

  messageRouter.handle("getSegmentCaptureStatus", async (message) => {
    const tabId = Number(message.tabId) || 0;
    return { ok: true, status: segmentCapture.getStatus(tabId) };
  });

  messageRouter.handle("assembleSegments", async (message) => {
    const segments = Array.isArray(message.segments) ? message.segments : [];
    if (!segments.length) {
      return { ok: true, jobId: message.jobId || "", warning: "No segments to assemble." };
    }

    const requestId = `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const response = await nativeRequest(
        {
          type: "assembleSegments",
          id: requestId,
          tabId: message.tabId || 0,
          jobId: message.jobId || "",
          title: message.title || "Video",
          url: message.url || "",
          streams: message.streams || {},
          segments: segments.map((s) => ({
            streamId: s.streamId || "unknown",
            mimeType: s.mimeType || "",
            data: s.data || "",
            index: typeof s.index === "number" ? s.index : 0,
            timestamp: typeof s.timestamp === "number" ? s.timestamp : 0,
            isLast: Boolean(s.isLast),
          })),
        },
        120000,
      );
      return {
        ok: response && response.ok !== false,
        jobId: message.jobId || "",
        filepath: response?.filepath || "",
        error: response?.error || "",
      };
    } catch (error) {
      return {
        ok: false,
        jobId: message.jobId || "",
        error: `Native host assembly failed: ${error.message || error}`,
      };
    }
  });
}
