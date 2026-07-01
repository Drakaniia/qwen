"use strict";

/**
 * CDP Tunnel Integration Module
 *
 * Integrates the CDP browser tunnel into the download orchestration
 * fallback chain. When native host sources are exhausted (e.g., due
 * to Cloudflare blocks, 403s, or DRM restrictions), this module
 * provides a last-resort download method that tunnels requests
 * through the browser's authenticated network stack.
 *
 * Flow:
 * 1. Receive a URL from the download orchestration fallback chain
 * 2. Download the full resource via CDP tunnel (tunnelSegmentDownload)
 * 3. Convert base64 response back to binary and send to native host
 * 4. Native host writes the data to disk at the specified output path
 *
 * For stream formats (HLS/DASH), individual segments are downloaded
 * sequentially and written to disk, then assembled by the native host.
 */

import { tunnelSegmentDownload, tunnelManifestDownload, cleanup } from "./cdp_tunnel_download.js";

// ─── Native Host Message Builder ───────────────────────────────────────

/**
 * Build a native host message payload for writing base64-encoded data to disk.
 * @param {string} requestId
 * @param {string} base64Data
 * @param {string} outputPath
 * @returns {{ type: string, id: string, data: string, outputPath: string }}
 */
function buildNativeWriteDataMessage(requestId, base64Data, outputPath) {
  return {
    type: "writeData",
    id: requestId || `cdp_write_${Date.now()}`,
    data: base64Data,
    outputPath: outputPath,
  };
}

// ─── CDP Tunnel Download ─────────────────────────────────────────────

/**
 * Attempt to download a media resource through the CDP browser tunnel.
 * This is a last-resort fallback when all other download methods fail.
 *
 * @param {number} tabId - The tab ID to attach debugger to
 * @param {string} url - The media URL to download
 * @param {Object} [options]
 * @param {Object} [options.requestHeaders] - Headers to include in the fetch
 * @param {number} [options.timeout=60000] - Timeout per download in ms
 * @param {string} [options.format] - Media format (hls, dash, mp4, etc.)
 * @returns {Promise<{ok: boolean, data?: string, byteLength?: number, contentType?: string, error?: string, method: string}>}
 */
async function tryCdpTunnelDownload(tabId, url, options = {}) {
  const requestHeaders = options.requestHeaders || {};
  const timeout = options.timeout || 60000;
  const format = (options.format || "").toUpperCase();

  try {
    // Determine whether to use segment or manifest download
    const isStreamFormat = format === "M3U8" || format === "HLS" || format === "MPD" || format === "DASH";

    let result;
    if (isStreamFormat) {
      result = await tunnelManifestDownload(tabId, url, requestHeaders);
    } else {
      result = await tunnelSegmentDownload(tabId, url, requestHeaders, { timeout });
    }

    if (!result.ok) {
      return {
        ok: false,
        error: result.error || `CDP tunnel download failed for ${url}`,
        method: isStreamFormat ? "manifest" : "segment",
      };
    }

    return {
      ok: true,
      data: result.data,
      byteLength: result.byteLength,
      contentType: result.contentType,
      method: isStreamFormat ? "manifest" : "segment",
    };
  } catch (err) {
    return {
      ok: false,
      error: `CDP tunnel error: ${err.message || err}`,
      method: "unknown",
    };
  }
}

export {
  tryCdpTunnelDownload,
  buildNativeWriteDataMessage,
  cleanup,
};
