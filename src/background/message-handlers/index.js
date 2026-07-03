"use strict";

/**
 * Message handlers barrel module.
 *
 * Re-exports all handler registration functions and provides a single
 * registerAll() call that wires every handler into the given router.
 */

export { registerTabHandlers } from "./tab.js";
export { registerDownloadHandlers } from "./download.js";
export { registerCdpHandlers } from "./cdp.js";
export { registerCdmHandlers } from "./cdm.js";
export { registerSettingsHandlers } from "./settings.js";
export { registerCaptureHandlers } from "./capture.js";
export { registerBatchHandlers } from "./batch.js";

/**
 * Register ALL message handlers into the given router.
 * @param {import("../message_router.js").MessageRouter} messageRouter
 * @param {object} ctx - shared extension context object
 */
export function registerAllHandlers(messageRouter, ctx) {
  registerTabHandlers(messageRouter, ctx);
  registerDownloadHandlers(messageRouter, ctx);
  registerCdpHandlers(messageRouter, ctx);
  registerCdmHandlers(messageRouter, ctx);
  registerSettingsHandlers(messageRouter, ctx);
  registerCaptureHandlers(messageRouter, ctx);
  registerBatchHandlers(messageRouter, ctx);
}
