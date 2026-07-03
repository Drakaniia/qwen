"use strict";

/**
 * Settings, helper status, and utility message handlers.
 */

export function registerSettingsHandlers(messageRouter, ctx) {
  const {
    tabState,
    browserApi,
    notifyPopup,
    HOST_NAME,
    cachedHelperStatus,
    HELPER_PING_INTERVAL_MS,
    refreshCachedHelperStatus,
    pingNativeHost,
  } = ctx;

  // ── Save/get settings ──────────────────────────────────────────────────

  messageRouter.handle("saveSettings", async (message) => {
    await tabState.updateSettings(message.settings || {});
    return { ok: true, settings: tabState.getSettings() };
  });

  messageRouter.handle("getSettings", async () => {
    return { ok: true, settings: tabState.getSettings() };
  });

  // ── Open popup ───────────────────────────────────────────────────────

  messageRouter.handle("openPopup", async () => {
    await browserApi.action.openPopup();
    return { ok: true };
  });

  // ── Helper status ─────────────────────────────────────────────────────

  messageRouter.handle("pingNativeHost", async () => {
    return pingNativeHost();
  });

  messageRouter.handle("getHelperStatus", async () => {
    const age = Date.now() - cachedHelperStatus.lastChecked;
    if (age > HELPER_PING_INTERVAL_MS || !cachedHelperStatus.lastChecked) {
      await refreshCachedHelperStatus(notifyPopup, HOST_NAME);
    }

    return {
      ok: true,
      connected: cachedHelperStatus.connected,
      version: cachedHelperStatus.version,
      dependencies: { ...cachedHelperStatus.dependencies },
      lastChecked: cachedHelperStatus.lastChecked,
      error: cachedHelperStatus.error || "",
    };
  });
}
