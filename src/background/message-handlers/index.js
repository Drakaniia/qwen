"use strict";

/**
 * Message handlers barrel module.
 *
 * Re-exports all handler registration functions and provides a single
 * registerAll() call that wires every handler into the given router.
 */

import { registerTabHandlers } from "./tab.js";
import { registerDownloadHandlers } from "./download.js";
import { registerSettingsHandlers } from "./settings.js";

export { registerTabHandlers, registerDownloadHandlers, registerSettingsHandlers };

/**
 * Register ALL message handlers into the given router.
 * @param {import("../message_router.js").MessageRouter} messageRouter
 * @param {object} ctx - shared extension context object
 */
export function registerAllHandlers(messageRouter, ctx) {
  registerTabHandlers(messageRouter, ctx);
  registerDownloadHandlers(messageRouter, ctx);
  registerSettingsHandlers(messageRouter, ctx);
}
