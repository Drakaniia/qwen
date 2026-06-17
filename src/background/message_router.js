"use strict";

/**
 * Creates a message router that replaces the monolithic onMessage if-chain.
 *
 * Usage:
 *   var router = MessageRouter.create();
 *   router.handle("getVideos", handlerFn);
 *   router.handle("downloadVideo", handlerFn);
 *   api.runtime.onMessage.addListener(router.dispatch);
 *
 * Each handler receives (message, sender) and must return a value or Promise.
 * The router wraps the response in the standard sendResponse lifecycle.
 */
function create() {
  const handlers = {};

  /**
   * Register a handler for a message type.
   * handler(message, sender) → value or Promise<value>
   */
  function handle(messageType, handler) {
    if (typeof handler !== "function") {
      throw new Error("MessageRouter: handler must be a function");
    }
    handlers[messageType] = handler;
  }

  /**
   * Remove a registered handler.
   */
  function unhandle(messageType) {
    delete handlers[messageType];
  }

  /**
   * Dispatch a message. Returns true (keep channel open for async response).
   * Compatible with Chrome's onMessage.addListener contract.
   */
  function dispatch(message, sender, sendResponse) {
    if (!message || !message.type) {
      // Unknown message shape — let it fall through.
      if (sendResponse) {
        sendResponse({ ok: false, error: "Missing message type." });
      }
      return false;
    }

    const handler = handlers[message.type];
    if (!handler) {
      if (sendResponse) {
        sendResponse({ ok: false, error: "Unknown message type: " + message.type });
      }
      return false;
    }

    // Run handler and send response.
    Promise.resolve()
      .then(function () {
        return handler(message, sender);
      })
      .then(function (result) {
        if (sendResponse) {
          sendResponse(result || { ok: true });
        }
      })
      .catch(function (error) {
        if (sendResponse) {
          sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
        }
      });

    // Return true to keep the message channel open for async sendResponse.
    return true;
  }

  return {
    handle: handle,
    unhandle: unhandle,
    dispatch: dispatch,
  };
}

export { create };
