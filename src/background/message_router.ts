/**
 * The service worker's message entry point: validate the sender, look the message
 * type up in the dispatch map, run it, and answer on the channel.
 *
 * Spec D4 replaced the old `router.handle("type", fn)`-plus-`handlers` object with a
 * single `Map` filled at module-init time. Nothing in this file names a message type —
 * a handler registers itself from its own module, so adding one means writing one
 * file, never editing the router (a spec success criterion).
 *
 * The map used to live in `shared/registry.ts`, a "generic plugin registry" that
 * nothing but these four modules ever touched and whose `Handler<T>` generic was only
 * ever instantiated at `unknown`. The plugin shape (a name, a handle function, a Map)
 * *is* the router's own shape, so the map lives here now and `register` is exported
 * alongside `create`.
 *
 * Two behaviours here are load-bearing and are *not* part of the dispatch table:
 *
 *   - **sender validation.** Only `sender.id === runtime.id` may invoke a handler.
 *     Without it any extension, or any compromised content script on a page we are
 *     injected into, could drive `downloadVideo` / `chooseDownloadFolder`.
 *   - **the sendResponse lifecycle.** `dispatch` must return `true` to keep the
 *     channel open, because every handler is async and answers later.
 */

import type { ResponseEnvelope } from "../shared/contracts.js";

/**
 * A registered handler. `name` is the dispatch key — the wire `message.type` string,
 * so a handler's name is part of its public contract and is declared in `contracts.ts`.
 */
interface Handler {
  readonly name: string;
  handle(message: unknown): Promise<unknown> | unknown;
}

/**
 * The dispatch table. Module-level, so it is per-bundle-instance — correct, because
 * only the service worker has handlers; nothing else shares this instance.
 */
const handlers = new Map<string, Handler>();

/** Register (or replace) the handler for `handler.name`. */
export function register(handler: Handler): void {
  handlers.set(handler.name, handler);
}

/** Look up a handler by dispatch key. `undefined` = no handler, caller decides. */
function getHandler(name: string): Handler | undefined {
  return handlers.get(name);
}

/**
 * The router's public surface. `create()` stays a factory so the background can
 * build one instance and wire it to `runtime.onMessage`; the dispatch map it reads
 * from is the module-level singleton above.
 */
export interface MessageRouter {
  dispatch(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: SendResponse): boolean;
}

export type SendResponse = (response?: unknown) => void;

/** Reply shape for a handler that threw. Matches the envelope `contracts.ts` declares. */
function errorResponse(error: string): ResponseEnvelope {
  return { ok: false, error };
}

function create(): MessageRouter {
  /**
   * Get the current extension's runtime ID in a cross-browser way.
   */
  function getExtensionId(): string {
    // The runtime shim (`shared/browser_api.ts`) publishes the namespace as
    // `globalThis.browser`; it has no ambient declaration, so it is read via a cast
    // rather than a bare `browser` identifier.
    const shimmed = (globalThis as { browser?: typeof chrome }).browser;
    return (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || shimmed?.runtime?.id || "";
  }

  /**
   * Dispatch a message. Returns true (keep channel open for async response).
   * Compatible with Chrome's onMessage.addListener contract.
   */
  function dispatch(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: SendResponse): boolean {
    const payload = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
    const type = payload && typeof payload.type === "string" ? payload.type : "";
    if (!payload || !type) {
      // Unknown message shape — let it fall through.
      if (sendResponse) {
        sendResponse(errorResponse("Missing message type."));
      }
      return false;
    }

    // CRITICAL: Validate sender origin.
    // Only allow messages from the extension's own runtime context.
    // This prevents external extensions or compromised contexts from
    // invoking any message handler (download, settings, etc.).
    if (!sender || sender.id !== getExtensionId()) {
      if (sendResponse) {
        sendResponse(errorResponse("Unauthorized sender."));
      }
      return false;
    }

    const handler = getHandler(type);
    if (!handler) {
      if (sendResponse) {
        sendResponse(errorResponse("Unknown message type: " + type));
      }
      return false;
    }

    // Run handler and send response.
    //
    // The sender is merged into the message rather than passed as a second argument:
    // `Handler.handle` takes one argument, and the only other option — a module-level
    // "current sender" — is wrong as soon as two dispatches interleave across an
    // `await`. This spread is the single place that happens; handlers destructure
    // `message.sender`.
    Promise.resolve()
      .then(function () {
        return handler.handle({ ...payload, sender });
      })
      .then(function (result) {
        if (sendResponse) {
          sendResponse(result || { ok: true });
        }
      })
      .catch(function (error) {
        if (sendResponse) {
          sendResponse(errorResponse(error && error.message ? error.message : String(error)));
        }
      });

    // Return true to keep the message channel open for async sendResponse.
    return true;
  }

  return { dispatch };
}

export { create };
