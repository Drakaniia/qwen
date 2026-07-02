import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const popupBundle = fs.readFileSync(path.join(__dirname, "../../../dist/test/popup.bundle.js"), "utf8");

// ─── Mock DOM helpers ──────────────────────────────────────────────────────

class ClassList {
  constructor(element) { this.element = element; }
  toggle(name, force) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    const enabled = force === undefined ? !classes.has(name) : Boolean(force);
    if (enabled) classes.add(name); else classes.delete(name);
    this.element.className = Array.from(classes).join(" ");
    return enabled;
  }
}

class TestElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = "";
    this.classList = new ClassList(this);
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.title = "";
    this.onclick = null;
    this.ownerDocument = null;
    this._textContent = "";
  }
  set textContent(value) { this._textContent = String(value || ""); this.children = []; }
  get textContent() { return this._textContent; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }
  async click() {
    const event = { target: this };
    for (const l of this.listeners.click || []) await l(event);
    if (this.onclick) await this.onclick(event);
  }
  closest() { return null; }
}

const BATCH_ELEMENT_IDS = [
  "helperStatus", "downloadIndicator", "settingsToggle", "settingsPanel",
  "settingsStatus", "viewToggle", "contentView", "footerActions",
  "showVideos", "showMusic", "showDownloads",
  "manualUrl", "downloadManualUrl", "magnetUrl", "downloadMagnet",
  "downloadTorrentFile", "downloadFolder", "chooseDownloadFolder",
  "saveSettings", "message", "videoToolbar",
  "showListLayout", "showBoxLayout", "videoList", "downloadList",
  "qualityDialog", "qualityTitle", "qualityList", "cancelQuality",
  "rescan", "clear",
  "musicLinkSection", "musicLinkUrl", "downloadMusicLink",
  "audioFormat", "recordingMode",
  "batchBar", "batchLabel", "batchProgress", "batchProgressFill",
  "batchStatus", "batchCancelBtn", "playlistPrompt", "playlistTitle",
  "downloadAllBtn",
  "backend", "downloadSubtitles", "syncHistoryToggle", "syncStatus",
  "depBanner", "depBannerToggle", "depBannerBody", "depBannerList",
  "depBannerTitle", "depBannerCopyBtn",
];

function createDocument() {
  const elements = new Map();
  const doc = {
    getElementById(id) { return elements.get(id) || null; },
    createElement(tagName) { const el = new TestElement(tagName); el.ownerDocument = doc; return el; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    element(id) { return elements.get(id); },
  };
  for (const id of BATCH_ELEMENT_IDS) {
    const el = new TestElement("div", id);
    el.ownerDocument = doc;
    elements.set(id, el);
  }
  elements.get("downloadFolder").value = "";
  return doc;
}

async function flushPromises() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

let messageLog = [];

function createHarness({ activeTabUrl = "https://example.com/", messageHandler } = {}) {
  const document = createDocument();
  messageLog = [];

  const defaultHandler = async (msg) => {
    messageLog.push(msg.type);
    if (msg.type === "getVideos") {
      return { ok: true, videos: [], downloads: [], settings: {} };
    }
    if (msg.type === "pingNativeHost") {
      return { ok: true, version: "1.2.3", dependencies: { ytDlp: true, ffmpeg: true, aria2c: true } };
    }
    if (msg.type === "enumeratePlaylist") {
      return {
        ok: true,
        items: [
          { id: "v1", url: "https://youtube.com/watch?v=v1", title: "First Item", duration: 120 },
          { id: "v2", url: "https://youtube.com/watch?v=v2", title: "Second Item", duration: 240 },
        ],
        playlistTitle: "Test Playlist", totalItems: 2,
      };
    }
    if (msg.type === "batchDownload") {
      return {
        ok: true,
        batchInfo: { totalItems: (msg.videos || []).length, completedItems: 0, currentIndex: 0, status: "running", percent: 0, label: "1/3" },
      };
    }
    return { ok: true };
  };

  const callbacks = [];
  const sandbox = { URL, browser: null, document, console,
    window: { setTimeout: (cb) => setTimeout(cb, 0), clearTimeout() {}, innerHeight: 600, innerWidth: 390, addEventListener() {} },
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class { constructor() { this.observe = () => {}; } observe() {} disconnect() {} },
    performance: { getEntriesByType() { return []; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
  };
  sandbox.browser = {
    tabs: { async query() { return [{ id: 42, url: activeTabUrl }]; } },
    runtime: {
      async sendMessage(msg) { return (messageHandler || defaultHandler)(msg); },
      onMessage: { addListener(cb) { callbacks.push(cb); } },
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(popupBundle, sandbox, { filename: "popup.bundle.js" });

  return {
    element: (id) => document.element(id),
    getMessageLog: () => messageLog,
    sendMessage: (msg) => { for (const cb of callbacks) cb(msg); },
    async ready() { await flushPromises(); },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

(async () => {
  // ─── Test 1: Download All triggers enumeratePlaylist + batchDownload ───

  const h1 = createHarness({
    activeTabUrl: "https://www.youtube.com/playlist?list=PLTEST123",
  });
  await h1.ready();

  await h1.element("downloadAllBtn").click();
  await flushPromises();

  const log = h1.getMessageLog();
  assert.ok(
    log.includes("enumeratePlaylist"),
    `enumeratePlaylist should be called. Messages: ${JSON.stringify(log)}`,
  );
  assert.ok(
    log.includes("batchDownload"),
    `batchDownload should be called. Messages: ${JSON.stringify(log)}`,
  );

  // ─── Test 2: batchDownload receives correct items from enumeration ─────

  const h2Log = [];
  const h2 = createHarness({
    activeTabUrl: "https://www.youtube.com/playlist?list=PLTEST123",
    messageHandler: async (msg) => {
      h2Log.push({ type: msg.type, count: msg.videos?.length, ids: msg.videos?.map((v) => v.id) });
      if (msg.type === "getVideos") return { ok: true, videos: [], downloads: [], settings: {} };
      if (msg.type === "pingNativeHost") return { ok: true, version: "1.0", dependencies: { ytDlp: true, ffmpeg: true, aria2c: true } };
      if (msg.type === "enumeratePlaylist") return { ok: true, items: [{ id: "a1", url: "https://youtube.com/watch?v=a1", title: "Alpha", duration: 120 }, { id: "b2", url: "https://youtube.com/watch?v=b2", title: "Beta", duration: 240 }], playlistTitle: "My List", totalItems: 2 };
      if (msg.type === "batchDownload") {
        return { ok: true, batchInfo: { totalItems: msg.videos?.length || 0, completedItems: 0, currentIndex: 0, status: "running", percent: 0, label: "1/2" } };
      }
      return { ok: true };
    },
  });
  await h2.ready();

  await h2.element("downloadAllBtn").click();
  await flushPromises();

  const batchCall = h2Log.find((m) => m.type === "batchDownload");
  assert.ok(batchCall, "batchDownload should be called");
  assert.equal(batchCall.count, 2, "batchDownload should receive 2 items");
  assert.deepEqual(batchCall.ids, ["a1", "b2"], "batchDownload should receive correct item IDs");

  // ─── Test 3: Button shows loading state during enumeration ─────────────

  let enumResolver;
  const enumBlockPromise = new Promise((r) => { enumResolver = r; });

  const h3Doc = createDocument();
  const h3Sandbox = {
    URL, browser: null, document: h3Doc, console,
    window: { setTimeout: (cb) => setTimeout(cb, 0), clearTimeout() {}, innerHeight: 600, innerWidth: 390, addEventListener() {} },
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class { constructor() { this.observe = () => {}; } observe() {} disconnect() {} },
    performance: { getEntriesByType() { return []; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
  };
  h3Sandbox.browser = {
    tabs: { async query() { return [{ id: 42, url: "https://www.youtube.com/playlist?list=PLTEST123" }]; } },
    runtime: {
      async sendMessage(msg) {
        if (msg.type === "enumeratePlaylist") return enumBlockPromise;
        if (msg.type === "getVideos") return { ok: true, videos: [], downloads: [], settings: {} };
        if (msg.type === "pingNativeHost") return { ok: true, version: "1.0", dependencies: { ytDlp: true, ffmpeg: true, aria2c: true } };
        return { ok: true };
      },
      onMessage: { addListener() {} },
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
    },
  };
  vm.createContext(h3Sandbox);
  vm.runInContext(popupBundle, h3Sandbox, { filename: "popup.bundle.js" });
  await flushPromises();

  const btn3 = h3Doc.element("downloadAllBtn");
  const clickPromise = btn3.click();

  assert.equal(btn3.disabled, true, "Button disabled during enumeration");
  assert.equal(btn3.textContent, "Enumerating...", "Button text changes to 'Enumerating...'");

  enumResolver({ ok: true, items: [] });
  await flushPromises();
  await clickPromise;

  // ─── Test 4: Enumerate failure shows error message ─────────────────────

  const h4 = createHarness({
    activeTabUrl: "https://www.youtube.com/playlist?list=PLFAIL",
    messageHandler: async (msg) => {
      if (msg.type === "enumeratePlaylist") return { ok: false, error: "Private playlist" };
      if (msg.type === "getVideos") return { ok: true, videos: [], downloads: [], settings: {} };
      if (msg.type === "pingNativeHost") return { ok: true, version: "1.0", dependencies: { ytDlp: true, ffmpeg: true, aria2c: true } };
      return { ok: true };
    },
  });
  await h4.ready();

  await h4.element("downloadAllBtn").click();
  await flushPromises();

  assert.equal(h4.element("downloadAllBtn").disabled, false, "Button re-enabled after failure");
  assert.match(h4.element("message").textContent, /Private playlist/, "Error message shown");

  // ─── Test 5: Empty playlist shows message without batch download ───────

  const h5 = createHarness({
    activeTabUrl: "https://www.youtube.com/playlist?list=PLEMPTY",
    messageHandler: async (msg) => {
      if (msg.type === "enumeratePlaylist") return { ok: true, items: [], playlistTitle: "", totalItems: 0 };
      if (msg.type === "getVideos") return { ok: true, videos: [], downloads: [], settings: {} };
      if (msg.type === "pingNativeHost") return { ok: true, version: "1.0", dependencies: { ytDlp: true, ffmpeg: true, aria2c: true } };
      return { ok: true };
    },
  });
  await h5.ready();

  await h5.element("downloadAllBtn").click();
  await flushPromises();

  assert.match(h5.element("message").textContent, /No items found/, "Empty playlist shows message");

  // ─── Test 6: batchUpdated message updates batch bar ────────────────────

  const h6 = createHarness({ activeTabUrl: "https://example.com/" });
  await h6.ready();

  assert.equal(h6.element("batchBar").hidden, true, "Batch bar hidden initially");

  h6.sendMessage({
    type: "batchUpdated",
    batchInfo: { totalItems: 5, completedItems: 2, currentIndex: 2, status: "running", percent: 40, label: "3/5", isActive: true, failedItems: [] },
  });
  await flushPromises();

  assert.equal(h6.element("batchBar").hidden, false, "Batch bar visible after update");
  assert.equal(h6.element("batchLabel").textContent, "3/5", "Label shows 3/5");
  assert.equal(h6.element("batchProgressFill").style.width, "40%", "Progress 40%");

  // ─── Test 7: batchComplete sets message ────────────────────────────────

  const h7 = createHarness({ activeTabUrl: "https://example.com/" });
  await h7.ready();

  h7.sendMessage({
    type: "batchComplete",
    batchInfo: { totalItems: 3, completedItems: 3, currentIndex: -1, status: "completed", percent: 100, label: "3/3", isActive: false, failedItems: [] },
    message: "All 3 items downloaded.",
  });
  await flushPromises();

  assert.match(h7.element("message").textContent, /All 3 items/, "batchComplete message shown");

  // ─── Test 8: Paused batch shows status ─────────────────────────────────

  const h8 = createHarness({ activeTabUrl: "https://example.com/" });
  await h8.ready();

  h8.sendMessage({
    type: "batchUpdated",
    batchInfo: { totalItems: 5, completedItems: 2, currentIndex: 2, status: "paused", percent: 40, label: "3/5", isActive: true, failedItems: [] },
  });
  await flushPromises();

  assert.match(h8.element("batchStatus").textContent, /Paused/, "Status shows Paused");

  // ─── Test 9: Failed items count in status ──────────────────────────────

  const h9 = createHarness({ activeTabUrl: "https://example.com/" });
  await h9.ready();

  h9.sendMessage({
    type: "batchUpdated",
    batchInfo: { totalItems: 10, completedItems: 4, currentIndex: 6, status: "running", percent: 40, label: "7/10", isActive: true, failedItems: [{ id: "v1", error: "e1" }] },
  });
  await flushPromises();

  assert.match(h9.element("batchStatus").textContent, /1 failed/, "Status shows 1 failed");

  console.log("popup batch UI flow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
