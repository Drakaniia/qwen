"use strict";

/** @type {QwinPopupState} */
const state = {
  activeTabId: null,
  activeTabUrl: "",
  currentVideos: [],
  currentDownloads: [],
  viewMode: "videos",
  videoLayoutMode: "list",
  musicMode: false,
  qualityRequestSerial: 0,
};

/** @type {Array<function(Object): void>} */
const subscribers = [];

/**
 * Get a single state value by key.
 * @param {string} key
 * @returns {*}
 */
function get(key) {
  return state[key];
}

/**
 * Get a shallow copy of the entire state.
 * @returns {Object}
 */
function getState() {
  return { ...state };
}

/**
 * Set a single state value (silent – does not notify subscribers).
 * Use {@link update} for changes that should trigger re-renders.
 * @param {string} key
 * @param {*} value
 */
function set(key, value) {
  state[key] = value;
}

/**
 * Batch-update state and notify all subscribers with a snapshot.
 * @param {Object} partial
 */
function update(partial) {
  Object.assign(state, partial);
  const snapshot = { ...state };
  for (let i = 0; i < subscribers.length; i++) {
    try {
      subscribers[i](snapshot);
    } catch (_error) {
      // Swallow subscriber errors so one bad handler does not break the chain.
    }
  }
}

/**
 * Subscribe to state changes. The callback receives a state snapshot on every update.
 * @param {function(Object): void} fn
 * @returns {function(): void} unsubscribe
 */
function subscribe(fn) {
  subscribers.push(fn);
  return function unsubscribe() {
    const idx = subscribers.indexOf(fn);
    if (idx >= 0) {
      subscribers.splice(idx, 1);
    }
  };
}

export { get, getState, set, update, subscribe };
