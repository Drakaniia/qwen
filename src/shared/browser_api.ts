/**
 * The `browser`/`chrome` shim every layer talks through.
 *
 * There is no `webextension-polyfill` and there must never be one — it is frozen, and
 * this file is the whole replacement. That is also why the three runtime lines below
 * are kept exactly as the JS they replaced: the shim *is* the contract.
 *
 * Everything under the shim exists because the promise and callback spellings of the
 * same chrome call are different functions. Each wrapper picks the right one from
 * `isPromiseApi` once, so no caller has to.
 */

// Chrome 148+ ships the `browser` namespace natively, including promise-returning
// `runtime.onMessage`. `??=` is the deliberate safety net: if a browser fork does not
// honour `minimum_chrome_version`, every consumer degrades to callback-style `chrome`
// instead of throwing. Captured before the assignment, so the shim itself does not
// masquerade as a promise API.
const isPromiseApi = typeof globalThis.browser !== "undefined";
globalThis.browser ??= globalThis.chrome;
const api = globalThis.browser;

/**
 * What a message call resolves to.
 *
 * ponytail: `any` on purpose. `contracts.ts` documents that response types are
 * deliberately not enumerated — `message_router.ts` normalizes every handler result
 * to `{ ok: true }` or `{ ok: false, error }` and nothing more. Narrowing here would
 * push a cast into ~30 call sites in popup/content instead of the two that read
 * fields off the envelope.
 */
export type MessageResult = any;

/**
 * Any `chrome` event listener.
 *
 * ponytail: `(...args: any[]) => unknown` because the real arity differs per event
 * (`tabs.onRemoved` sends `(tabId, removeInfo)`, `runtime.onMessage` sends
 * `(message, sender, sendResponse)`) and every consumer already passes its own
 * narrowed closure. Naming the union would mean a cast at each registration.
 */
type AnyListener = (...args: any[]) => unknown;

/** Anything with an `addListener` — the only method this wrapper's events expose. */
export interface ListenerTarget {
  addListener(listener: AnyListener, ...rest: any[]): void;
}

/** `event.message || String(event)` — chrome rejects with both shapes. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : String(error);
}

function noop(): void {}

/**
 * Send a runtime message and surface a failure as { ok: false, error }.
 * Shared by popup_api.runtimeMessage and the content script's message bridge.
 */
function sendMessage(message: unknown): Promise<MessageResult> {
  if (isPromiseApi) {
    // `try`, not just `.catch`: a content script outlives the extension that
    // injected it, and once the context is invalidated (an extension reload, an
    // update, a disable) the promise-based binding **throws**
    // `"Extension context invalidated."` synchronously instead of rejecting — so
    // the `.catch` below never runs and the error escapes uncaught from whichever
    // 3s scan tick called it. Both spellings therefore need the guard.
    try {
      return api.runtime.sendMessage(message).catch((error: unknown) => ({ ok: false, error: errorMessage(error) }));
    } catch (error) {
      return Promise.resolve({ ok: false, error: errorMessage(error) });
    }
  }
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage(message, (response: MessageResult) => {
        const error = api.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        resolve(response);
      });
    } catch (error) {
      resolve({ ok: false, error: errorMessage(error) });
    }
  });
}

/** Query active tabs in the current window. */
function queryActiveTabs(): Promise<chrome.tabs.Tab[]> {
  const queryInfo = { active: true, currentWindow: true };
  if (isPromiseApi) {
    return api.tabs.query(queryInfo);
  }
  return new Promise((resolve) => api.tabs.query(queryInfo, resolve));
}

/**
 * Wraps a callback-or-promise chrome call, resolving `fallback` on any failure.
 *
 * ponytail: the callback is `any` so each call site below can pass chrome's own
 * overload without restating its response type (chrome's `get(keys, callback)` has no
 * `undefined`-callback spelling, and the promise path deliberately passes none). The
 * returned promise is typed by the caller naming `T`.
 */
function invokeAsync<T>(call: (callback?: any) => unknown, fallback: T): Promise<T> {
  if (isPromiseApi) {
    // `call()` with no callback is what makes the promise overload fire.
    // Wrapped for the same reason as `sendMessage`: an invalidated extension
    // context throws out of the binding synchronously, so evaluating `call()` as
    // this promise's argument is the throw site, not a rejection to `.catch`.
    try {
      return Promise.resolve(call()).catch(() => fallback) as Promise<T>;
    } catch (_error) {
      return Promise.resolve(fallback);
    }
  }
  return new Promise((resolve) => {
    try {
      call((response: T) => {
        void api.runtime.lastError;
        resolve(response == null ? fallback : response);
      });
    } catch (_error) {
      resolve(fallback);
    }
  });
}

/** For methods that return a value synchronously (e.g. connectNative). */
function callSync<T>(method: (...args: any[]) => T, ...args: any[]): T | null {
  try {
    return method(...args);
  } catch (_error) {
    return null;
  }
}

/** Safe listener registration with optional extra spec args. */
function registerListener(
  target: ListenerTarget,
  handler: AnyListener,
  filter?: chrome.webRequest.RequestFilter,
  extras?: readonly string[],
): void {
  const requestFilter = filter || { urls: ["<all_urls>"] };
  try {
    if (extras && extras.length) {
      target.addListener(handler, requestFilter, extras);
      return;
    }
    target.addListener(handler, requestFilter);
  } catch (_error) {
    // Fallback without extras for Firefox compatibility.
    target.addListener(handler, requestFilter);
  }
}

/** `chrome.storage.local` reads as a plain bag; values are whatever the writer stored. */
type StorageItems = Record<string, unknown>;

function storageGet(keys: string | string[] | null): Promise<StorageItems | null> {
  return invokeAsync<StorageItems | null>((cb) => api.storage.local.get(keys, cb), null);
}

function storageSet(items: StorageItems): Promise<null> {
  return invokeAsync<null>((cb) => api.storage.local.set(items, cb), null);
}

function storageRemove(keys: string | string[]): Promise<null> {
  return invokeAsync<null>((cb) => api.storage.local.remove(keys, cb), null);
}

// --- Storage (sync) ---
function storageSyncGet(keys: string | string[] | null): Promise<StorageItems> {
  if (!api.storage.sync) {
    return Promise.resolve({});
  }
  return invokeAsync<StorageItems>((cb) => api.storage.sync.get(keys, cb), {});
}

function storageSyncSet(items: StorageItems): Promise<void> {
  if (!api.storage.sync) {
    return Promise.resolve();
  }
  return invokeAsync<void>((cb) => api.storage.sync.set(items, cb), undefined);
}

function storageSyncRemove(keys: string | string[]): Promise<void> {
  if (!api.storage.sync) {
    return Promise.resolve();
  }
  return invokeAsync<void>((cb) => api.storage.sync.remove(keys, cb), undefined);
}

// --- Tabs ---
function tabsQuery(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[] | null> {
  return invokeAsync<chrome.tabs.Tab[] | null>((cb) => api.tabs.query(queryInfo, cb), null);
}

function tabsSendMessage(tabId: number, message: unknown): Promise<MessageResult | null> {
  return invokeAsync<MessageResult | null>((cb) => api.tabs.sendMessage(tabId, message, cb), null);
}

// --- Cookies ---
function cookiesGetAll(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.Cookie[]> {
  if (!api.cookies || !api.cookies.getAll) {
    return Promise.resolve([]);
  }
  return invokeAsync<chrome.cookies.Cookie[]>((cb) => api.cookies.getAll(details, cb), []);
}

// --- Scripting ---
/**
 * A `scripting.executeScript` request. `never[]` args and an unknown result: the only
 * caller injects a zero-argument function into a tab, and chrome's own alias is
 * generic over both.
 */
type ScriptInjectionRequest = chrome.scripting.ScriptInjection<never[], unknown>;

function scriptingExecuteScript(details: ScriptInjectionRequest): Promise<chrome.scripting.InjectionResult[] | null> {
  if (!api.scripting || !api.scripting.executeScript) {
    return Promise.resolve(null);
  }
  return invokeAsync<chrome.scripting.InjectionResult[] | null>((cb) => api.scripting.executeScript(details, cb), null);
}

// --- Runtime ---
function runtimeSendMessage(message: unknown): Promise<MessageResult | null> {
  return invokeAsync<MessageResult | null>((cb) => api.runtime.sendMessage(message, cb), null);
}

function runtimeConnectNative(hostName: string): chrome.runtime.Port | null {
  return callSync((name: string) => api.runtime.connectNative(name), hostName);
}

// --- Action / BrowserAction ---
/** `chrome.action` on MV3, `chrome.browserAction` on anything older. Only `openPopup` is read. */
type PopupOpener = { openPopup?: () => Promise<void> | void };

async function actionOpenPopup(): Promise<void> {
  const target = (api.action && typeof api.action.openPopup === "function" ? api.action : api.browserAction) as
    | PopupOpener
    | undefined;
  if (!target || typeof target.openPopup !== "function") {
    return;
  }
  try {
    await target.openPopup();
  } catch (_error) {
    // Already open, or no popup attached.
  }
}

/**
 * The chrome event behind a wrapper entry, or a no-op stand-in.
 *
 * The `? :` guards predate the 148 floor and are kept: an event that is missing must
 * not take the whole service worker down at import time.
 */
function listenerTarget(event: unknown): ListenerTarget {
  return (event ?? { addListener: noop }) as ListenerTarget;
}

/**
 * A `webRequest` event, as {@link ListenerTarget}. Its own `addListener` requires a
 * filter, which is why this is a cast rather than an assignment.
 */
function requestTarget(event: unknown): ListenerTarget {
  return event as ListenerTarget;
}

const browserApi = {
  /** The underlying browser API object (chrome or browser). */
  raw: api,

  /** True if the environment natively provides the promise-based `browser` namespace. */
  isFirefox: isPromiseApi,

  /** True if falling back to callback-style chrome (pre-148, or a fork ignoring the floor). */
  isChrome: !isPromiseApi,

  storage: {
    get: storageGet,
    set: storageSet,
    remove: storageRemove,
    sync: {
      get: storageSyncGet,
      set: storageSyncSet,
      remove: storageSyncRemove,
    },
  },

  tabs: {
    query: tabsQuery,
    sendMessage: tabsSendMessage,
    onRemoved: listenerTarget(api.tabs && api.tabs.onRemoved),
    onUpdated: listenerTarget(api.tabs && api.tabs.onUpdated),
  },

  cookies: {
    getAll: cookiesGetAll,
  },

  scripting: {
    executeScript: scriptingExecuteScript,
  },

  runtime: {
    sendMessage: runtimeSendMessage,
    connectNative: runtimeConnectNative,
    onMessage: listenerTarget(api.runtime && api.runtime.onMessage),
  },

  webRequest: {
    onBeforeRequest: listenerTarget(api.webRequest && api.webRequest.onBeforeRequest),
    onBeforeSendHeaders: listenerTarget(api.webRequest && api.webRequest.onBeforeSendHeaders),
    onHeadersReceived: listenerTarget(api.webRequest && api.webRequest.onHeadersReceived),
  },

  action: {
    openPopup: actionOpenPopup,
  },

  /** Register a tab lifecycle listener. */
  onTabRemoved(handler: AnyListener): void {
    if (api.tabs && api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener(handler as (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void);
    }
  },

  onTabUpdated(handler: AnyListener): void {
    if (api.tabs && api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener(
        handler as (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
      );
    }
  },

  onMessage(handler: AnyListener): void {
    if (api.runtime && api.runtime.onMessage) {
      api.runtime.onMessage.addListener(
        handler as (
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | undefined,
      );
    }
  },

  onBeforeRequest(handler: AnyListener, filter?: chrome.webRequest.RequestFilter): void {
    registerListener(requestTarget(api.webRequest && api.webRequest.onBeforeRequest), handler, filter);
  },

  onBeforeSendHeaders(
    handler: AnyListener,
    filter?: chrome.webRequest.RequestFilter,
    extras?: readonly string[],
  ): void {
    registerListener(requestTarget(api.webRequest && api.webRequest.onBeforeSendHeaders), handler, filter, extras);
  },

  onHeadersReceived(handler: AnyListener, filter?: chrome.webRequest.RequestFilter): void {
    registerListener(requestTarget(api.webRequest && api.webRequest.onHeadersReceived), handler, filter);
  },
};

export { browserApi, api, isPromiseApi, sendMessage, queryActiveTabs };
