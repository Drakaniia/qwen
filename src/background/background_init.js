"use strict";

import * as tabState from "./tab_state.js";
import * as filterIntegration from "./filter_integration.js";
import { startHelperPing } from "./background_helper_ping.js";

/**
 * Run background service worker initialization.
 *
 * Called once at startup to load persisted state, start periodic
 * processes, and register filter list integration.
 *
 * @param {Object} ctx - Context dependencies from background.js
 * @param {Function} ctx.notifyPopup - Function to notify popup of state changes
 * @param {string} ctx.HOST_NAME - Native messaging host name
 */
export function runInit(ctx) {
  const { notifyPopup, HOST_NAME } = ctx;

  // Load persisted tab state
  tabState.load();

  // Start filter list integration (ad blocking patterns)
  filterIntegration.initFilterIntegration();

  // Start periodic helper ping to maintain native host connection
  startHelperPing(notifyPopup, HOST_NAME);
}
