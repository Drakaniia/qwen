"use strict";

/**
 * Message handlers barrel module.
 *
 * Re-exports all handler registration functions and provides a single
 * registerAll() call that wires every handler into the given router.
 */

import { registerTabHandlers } from "./tab.js";
import { registerDownloadHandlers } from "./download.js";
import { registerCdpHandlers } from "./cdp.js";
import { registerCdmHandlers } from "./cdm.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerCaptureHandlers } from "./capture.js";
import { registerBatchHandlers } from "./batch.js";

export {
  registerTabHandlers,
  registerDownloadHandlers,
  registerCdpHandlers,
  registerCdmHandlers,
  registerSettingsHandlers,
  registerCaptureHandlers,
  registerBatchHandlers,
};

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
