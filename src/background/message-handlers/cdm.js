"use strict";

/**
 * CDM key extraction and capture message handlers.
 */

export function registerCdmHandlers(messageRouter, ctx) {
  const { cdmNetworkIntercept, isExtensionPageSender, nativeRequest } = ctx;

  // ── CDM capture handlers (sender-restricted) ────────────────────────────

  messageRouter.handle("startCdmCapture", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may start CDM capture." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided for CDM capture." };
    }
    return cdmNetworkIntercept.initIntercept(tabId);
  });

  messageRouter.handle("stopCdmCapture", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may stop CDM capture." };
    }
    const tabId = Number(message.tabId) || 0;
    if (!tabId) {
      return { ok: false, error: "No tabId provided." };
    }
    const exchanges = cdmNetworkIntercept.getCapturedExchanges();
    const result = await cdmNetworkIntercept.stopIntercept(tabId);
    if (result.ok) {
      cdmNetworkIntercept.clearCapturedExchanges();
    }
    return { ok: result.ok, exchanges, error: result.error };
  });

  messageRouter.handle("getCdmCaptures", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may access CDM captures." };
    }
    return {
      ok: true,
      exchanges: cdmNetworkIntercept.getCapturedExchanges(),
      status: cdmNetworkIntercept.getStatus(),
    };
  });

  messageRouter.handle("cdmStatus", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized." };
    }
    return { ok: true, status: cdmNetworkIntercept.getStatus() };
  });

  // ── CDM key extraction pipeline (sender-restricted) ──────────────────────

  messageRouter.handle("cdmInit", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may initialize CDM." };
    }
    const cdmPath = message.cdmPath || "";
    if (!cdmPath) {
      return { ok: false, error: "cdmPath is required." };
    }
    try {
      const response = await nativeRequest({ type: "cdmInit", id: `cdm_init_${Date.now()}`, cdmPath }, 30000);
      return {
        ok: response?.ok !== false,
        cdmVersion: response?.cdmVersion || "",
        l1Only: Boolean(response?.l1Only),
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `CDM init failed: ${error.message || error}` };
    }
  });

  messageRouter.handle("extractCdmKeys", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may extract CDM keys." };
    }
    const exchange = message.exchange;
    if (!exchange || !exchange.responseBody) {
      return { ok: false, error: "A completed license exchange with responseBody is required." };
    }

    const sessionId = `${exchange.tabId || 0}_${exchange.requestId || Date.now()}`;

    try {
      const response = await nativeRequest(
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
  });

  messageRouter.handle("decryptCdmSegments", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may decrypt segments." };
    }
    if (!message.jobId) {
      return { ok: false, error: "jobId is required." };
    }
    if (!Array.isArray(message.segments) || !message.segments.length) {
      return { ok: false, error: "At least one encrypted segment is required." };
    }
    if (!Array.isArray(message.keys) || !message.keys.length) {
      return { ok: false, error: "At least one decryption key is required." };
    }

    try {
      const response = await nativeRequest(
        {
          type: "decryptSegments",
          id: `decrypt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          jobId: message.jobId,
          segments: message.segments,
          keys: message.keys,
          outputDir: message.outputDir || "",
        },
        120000,
      );

      return {
        ok: response?.ok !== false,
        jobId: response?.jobId || message.jobId,
        decrypted: response?.decrypted || 0,
        segmentPaths: response?.segmentPaths || [],
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `Segment decryption failed: ${error.message || error}` };
    }
  });

  messageRouter.handle("assembleDecryptedSegments", async (message, sender) => {
    if (!isExtensionPageSender(sender)) {
      return { ok: false, error: "Unauthorized: only the extension popup may assemble segments." };
    }
    if (!message.jobId) {
      return { ok: false, error: "jobId is required." };
    }
    if (!Array.isArray(message.filePaths) || !message.filePaths.length) {
      return { ok: false, error: "At least one segment file path is required." };
    }

    try {
      const response = await nativeRequest(
        {
          type: "assembleSegments",
          id: `assemble_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          jobId: message.jobId,
          filePaths: message.filePaths,
          outputPath: message.outputPath || "",
        },
        120000,
      );

      return {
        ok: response?.ok !== false,
        jobId: response?.jobId || message.jobId,
        filePath: response?.filePath || "",
        error: response?.error || "",
      };
    } catch (error) {
      return { ok: false, error: `Segment assembly failed: ${error.message || error}` };
    }
  });
}
