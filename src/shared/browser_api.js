"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;
const isPromiseApi = typeof browser !== "undefined";

/**
 * Wraps a callback-based chrome API call into a promise.
 * Detects the Chrome (callback) vs Firefox (promise) idiom once.
 */
function promisify(method, ...args) {
  if (isPromiseApi) {
    return method(...args);
  }
  return new Promise((resolve) => {
    try {
      method(...args, (result) => {
        void chrome.runtime.lastError;
        resolve(result);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

function noop() {}

/** For methods that return a value synchronously (e.g. connectNative). */
function callSync(method, ...args) {
  try {
    return method(...args);
  } catch (_error) {
    return null;
  }
}

/** Safe listener registration with optional extra spec args. */
function registerListener(target, handler, filter, extras) {
  try {
    const args = [handler, filter || { urls: ["<all_urls>"] }];
    if (extras && extras.length) {
      args.push(extras);
    }
    target.addListener(...args);
  } catch (_error) {
    // Fallback without extras for Firefox compatibility.
    target.addListener(handler, filter || { urls: ["<all_urls>"] });
  }
}

// --- Storage (local) ---
function storageGet(keys) {
  return promisify((cb) => api.storage.local.get(keys, cb));
}

function storageSet(items) {
  return promisify((cb) => api.storage.local.set(items, cb));
}

function storageRemove(keys) {
  return promisify((cb) => api.storage.local.remove(keys, cb));
}

// --- Storage (sync) ---
function storageSyncGet(keys) {
  if (!api.storage.sync) {
    return Promise.resolve({});
  }
  return promisify((cb) => api.storage.sync.get(keys, cb));
}

function storageSyncSet(items) {
  if (!api.storage.sync) {
    return Promise.resolve();
  }
  return promisify((cb) => api.storage.sync.set(items, cb));
}

function storageSyncRemove(keys) {
  if (!api.storage.sync) {
    return Promise.resolve();
  }
  return promisify((cb) => api.storage.sync.remove(keys, cb));
}

// --- Tabs ---
function tabsQuery(queryInfo) {
  return promisify((cb) => api.tabs.query(queryInfo, cb));
}

function tabsSendMessage(tabId, message) {
  if (isPromiseApi) {
    return api.tabs.sendMessage(tabId, message).catch(() => null);
  }
  return new Promise((resolve) => {
    try {
      api.tabs.sendMessage(tabId, message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

// --- Cookies ---
function cookiesGetAll(details) {
  if (!api.cookies || !api.cookies.getAll) {
    return Promise.resolve([]);
  }
  if (isPromiseApi) {
    return api.cookies.getAll(details).catch(() => []);
  }
  return new Promise((resolve) => {
    try {
      api.cookies.getAll(details, (cookies) => {
        void chrome.runtime.lastError;
        resolve(cookies || []);
      });
    } catch (_error) {
      resolve([]);
    }
  });
}

// --- Scripting ---
function scriptingExecuteScript(details) {
  if (!api.scripting || !api.scripting.executeScript) {
    return Promise.resolve(null);
  }
  if (isPromiseApi) {
    return api.scripting.executeScript(details).catch(() => null);
  }
  return new Promise((resolve) => {
    try {
      api.scripting.executeScript(details, (result) => {
        void chrome.runtime.lastError;
        resolve(result || null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

// --- Runtime ---
function runtimeSendMessage(message) {
  if (isPromiseApi) {
    return api.runtime.sendMessage(message).catch(() => null);
  }
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (_error) {
      resolve(null);
    }
  });
}

function runtimeConnectNative(hostName) {
  return callSync(() => api.runtime.connectNative(hostName));
}

// --- Action / BrowserAction ---
async function actionOpenPopup() {
  if (api.action && typeof api.action.openPopup === "function") {
    if (isPromiseApi) {
      await api.action.openPopup().catch(noop);
    } else {
      await new Promise((resolve) => {
        try {
          api.action.openPopup(resolve);
        } catch (_error) {
          resolve();
        }
      });
    }
  } else if (api.browserAction && typeof api.browserAction.openPopup === "function") {
    if (isPromiseApi) {
      await api.browserAction.openPopup().catch(noop);
    } else {
      await new Promise((resolve) => {
        try {
          api.browserAction.openPopup(resolve);
        } catch (_error) {
          resolve();
        }
      });
    }
  }
}

const browserApi = {
  /** The underlying browser API object (chrome or browser). */
  raw: api,

  /** True if the environment is Firefox (promise-based API). */
  isFirefox: isPromiseApi && typeof browser !== "undefined",

  /** True if the environment is Chrome/Chromium (callback-based API). */
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
    onRemoved: api.tabs && api.tabs.onRemoved ? api.tabs.onRemoved : { addListener: noop },
    onUpdated: api.tabs && api.tabs.onUpdated ? api.tabs.onUpdated : { addListener: noop },
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
    onMessage: api.runtime && api.runtime.onMessage ? api.runtime.onMessage : { addListener: noop },
  },

  webRequest: {
    onBeforeRequest:
      api.webRequest && api.webRequest.onBeforeRequest
        ? {
            addListener: (handler, filter, extras) =>
              registerListener(api.webRequest.onBeforeRequest, handler, filter, extras),
          }
        : { addListener: noop },
    onBeforeSendHeaders:
      api.webRequest && api.webRequest.onBeforeSendHeaders
        ? {
            addListener: (handler, filter, extras) =>
              registerListener(api.webRequest.onBeforeSendHeaders, handler, filter, extras),
          }
        : { addListener: noop },
    onHeadersReceived:
      api.webRequest && api.webRequest.onHeadersReceived
        ? {
            addListener: (handler, filter, extras) =>
              registerListener(api.webRequest.onHeadersReceived, handler, filter, extras),
          }
        : { addListener: noop },
  },

  action: {
    openPopup: actionOpenPopup,
  },

  /** Register a tab lifecycle listener. */
  onTabRemoved(handler) {
    if (api.tabs && api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener(handler);
    }
  },

  onTabUpdated(handler) {
    if (api.tabs && api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener(handler);
    }
  },

  onMessage(handler) {
    if (api.runtime && api.runtime.onMessage) {
      api.runtime.onMessage.addListener(handler);
    }
  },

  onBeforeRequest(handler, filter) {
    registerListener(api.webRequest && api.webRequest.onBeforeRequest, handler, filter);
  },

  onBeforeSendHeaders(handler, filter, extras) {
    registerListener(api.webRequest && api.webRequest.onBeforeSendHeaders, handler, filter, extras);
  },

  onHeadersReceived(handler, filter) {
    registerListener(api.webRequest && api.webRequest.onHeadersReceived, handler, filter);
  },
};

export { browserApi };
