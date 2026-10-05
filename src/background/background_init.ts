import * as tabState from "./tab_state.js";
import * as filterIntegration from "./filter_integration.js";
import { startHelperPing } from "./background_helper_ping.js";
import type { NotifyPopup } from "./types.js";

/**
 * Run background service worker initialization.
 *
 * Called once at startup to load persisted state, start periodic
 * processes, and register filter list integration.
 *
 * @param ctx - Context dependencies from background.ts
 */
export function runInit(ctx: { notifyPopup: NotifyPopup; HOST_NAME: string }): void {
  const { notifyPopup, HOST_NAME } = ctx;

  // Load persisted tab state
  void tabState.load();

  // Start filter list integration (ad blocking patterns)
  void filterIntegration.initFilterIntegration();

  // Start periodic helper ping to maintain native host connection
  startHelperPing(notifyPopup, HOST_NAME);
}
