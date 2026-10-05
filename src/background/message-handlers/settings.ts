import { register } from "../message_router.js";
// `cachedHelperStatus` is imported rather than taken from `ctx`, and that is the fix
// for a bug this file shipped for its whole life. It is a mutable `let` in
// `background_helper_ping.ts`, reassigned wholesale on every probe. Reading it into
// the `handlerContext` object literal snapshotted its value at construction, and
// destructuring that snapshot into a `const` made it permanent: `getHelperStatus` then
// returned the module initialiser forever, so Options rendered "not connected" with all
// five tools "missing" while the host answered every ping. A live ES module binding
// cannot be snapshotted this way, so importing it is the whole fix - and keeping it out
// of `BackgroundContext` means no future `let` can be reintroduced into that trap.
// See native-helper-status-spec.md §2.5.
import { cachedHelperStatus } from "../background_helper_ping.js";
import type { BackgroundContext, MessageOf } from "../types.js";

/**
 * Settings, helper status, and utility message handlers.
 */
export function registerSettingsHandlers(ctx: BackgroundContext): void {
  const {
    tabState,
    browserApi,
    notifyPopup,
    HOST_NAME,
    HELPER_PING_INTERVAL_MS,
    refreshCachedHelperStatus,
    pingNativeHost,
  } = ctx;

  // ── Save/get settings ──────────────────────────────────────────────────

  register({
    name: "saveSettings",
    async handle(message: MessageOf<"saveSettings">) {
      await tabState.updateSettings(message.settings || {});
      return { ok: true, settings: tabState.getSettings() };
    },
  });

  register({
    name: "getSettings",
    handle() {
      return { ok: true, settings: tabState.getSettings() };
    },
  });

  // ── Open popup ───────────────────────────────────────────────────────

  register({
    name: "openPopup",
    async handle() {
      await browserApi.action.openPopup();
      return { ok: true };
    },
  });

  // ── Helper status ─────────────────────────────────────────────────────

  register({
    name: "pingNativeHost",
    handle() {
      return pingNativeHost(HOST_NAME);
    },
  });

  register({
    name: "getHelperStatus",
    async handle() {
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
    },
  });
}
