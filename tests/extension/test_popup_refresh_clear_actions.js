import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const popupBundle = fs.readFileSync(path.join(__dirname, "../../dist/test/popup.bundle.js"), "utf8");
const popupCss = fs.readFileSync(path.join(__dirname, "../../src/popup/popup.css"), "utf8");

// Mutable browser mock — set in each VM sandbox before the bundle runs so that
// popup_api.js (bundled inside) captures `browser` at load time.
function createBrowserMock() {
  return {
    tabs: {
      async query() {
        return [];
      },
    },
    runtime: {
      async sendMessage() {
        return { ok: true };
      },
      onMessage: {
        addListener() {},
      },
    },
  };
}

const POPUP_ELEMENT_IDS = [
  "helperStatus",
  "downloadIndicator",
  "settingsToggle",
  "settingsPanel",
  "settingsStatus",
  "viewToggle",
  "contentView",
  "footerActions",
  "showVideos",
  "showMusic",
  "showDownloads",
  "manualUrl",
  "downloadManualUrl",
  "downloadFolder",
  "chooseDownloadFolder",
  "saveSettings",
  "message",
  "videoToolbar",
  "showListLayout",
  "showBoxLayout",
  "videoList",
  "downloadList",
  "qualityDialog",
  "qualityTitle",
  "qualityList",
  "cancelQuality",
  "rescan",
  "clear",
  "musicLinkSection",
  "musicLinkUrl",
  "downloadMusicLink",
  "audioFormat",
];

class ClassList {
  constructor(element) {
    this.element = element;
  }

  toggle(name, force) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    const enabled = force === undefined ? !classes.has(name) : Boolean(force);
    if (enabled) {
      classes.add(name);
    } else {
      classes.delete(name);
    }
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

  set textContent(value) {
    this._textContent = String(value || "");
    this.children = [];
  }

  get textContent() {
    return this._textContent;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  async click() {
    const event = { target: this };
    for (const listener of this.listeners.click || []) {
      await listener(event);
    }
    if (this.onclick) {
      await this.onclick(event);
    }
  }

  closest() {
    return null;
  }
}

function createDocument() {
  const elements = new Map();

  const document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      const el = new TestElement(tagName);
      el.ownerDocument = document;
      return el;
    },
    element(id) {
      return elements.get(id);
    },
  };

  for (const id of POPUP_ELEMENT_IDS) {
    const el = new TestElement("div", id);
    el.ownerDocument = document;
    elements.set(id, el);
  }
  elements.get("downloadFolder").value = "";

  return document;
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function createHarness({
  initialVideos = [],
  initialDownloads = [],
  refreshedVideos = [],
  clearResponse = { ok: true },
  activeTabs = [{ id: 42, url: "https://old.example.test/watch" }],
} = {}) {
  const document = createDocument();
  const messages = [];
  let tabsQueryCount = 0;
  let rescanCount = 0;
  let videosCleared = false;
  let downloadsCleared = false;
  let holdNextUserRescan = false;
  let pendingUserRescan = null;

  const browserMock = createBrowserMock();

  browserMock.tabs.query = async function () {
    const tab = activeTabs[Math.min(tabsQueryCount, activeTabs.length - 1)];
    tabsQueryCount += 1;
    return tab ? [tab] : [];
  };

  browserMock.runtime.sendMessage = async function (message) {
    messages.push(message);
    if (message.type === "getVideos") {
      return {
        ok: true,
        videos: videosCleared ? [] : rescanCount >= 1 ? refreshedVideos : initialVideos,
        downloads: downloadsCleared ? [] : initialDownloads,
        settings: { downloadFolder: "" },
      };
    }
    if (message.type === "rescanTab") {
      rescanCount += 1;
      if (holdNextUserRescan && rescanCount >= 2) {
        pendingUserRescan = createDeferred();
        holdNextUserRescan = false;
        return pendingUserRescan.promise;
      }
      return { ok: true };
    }
    if (message.type === "clearVideos") {
      if (clearResponse.ok) {
        videosCleared = true;
      }
      return clearResponse;
    }
    if (message.type === "clearDownloads") {
      if (clearResponse.ok) {
        downloadsCleared = true;
      }
      return clearResponse;
    }
    if (message.type === "pingNativeHost") {
      return {
        ok: true,
        version: "test",
        dependencies: { ytDlp: true, ffmpeg: true, aria2c: false },
      };
    }
    return { ok: true };
  };

  const sandbox = {
    URL,
    browser: browserMock,
    document,
    console,
    window: {
      setTimeout(callback) {
        return { callback };
      },
      clearTimeout() {},
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(popupBundle, sandbox, { filename: "popup.bundle.js" });

  return {
    messages,
    element: (id) => document.element(id),
    async ready() {
      await flushPromises();
    },
    holdNextUserRescan() {
      holdNextUserRescan = true;
    },
    resolveUserRescan(response = { ok: true }) {
      assert.ok(pendingUserRescan, "expected a pending user rescan");
      pendingUserRescan.resolve(response);
    },
  };
}

(async () => {
  assert.match(
    popupCss,
    /\.icon-button\.is-refreshing\s+svg[\s\S]*animation:/,
    "refresh icon must animate while the popup is rescanning",
  );

  const refreshedVideo = {
    id: "video-1",
    url: "https://example.test/video.mp4",
    title: "Fresh video",
    format: "MP4",
    downloadable: true,
  };
  const refreshHarness = createHarness({ refreshedVideos: [refreshedVideo] });

  await refreshHarness.ready();
  assert.equal(refreshHarness.element("videoList").children.length, 0);

  await refreshHarness.element("rescan").click();
  await flushPromises();

  assert.equal(
    refreshHarness.element("videoList").children.length,
    1,
    "refresh button must reload the popup list after requesting a tab rescan",
  );
  assert.equal(refreshHarness.element("message").textContent, "1 full video detected.");

  const changedTabHarness = createHarness({
    activeTabs: [
      { id: 42, url: "https://old.example.test/watch" },
      { id: 84, url: "https://new.example.test/watch" },
    ],
  });
  await changedTabHarness.ready();
  await changedTabHarness.element("rescan").click();
  await flushPromises();

  const userRescans = changedTabHarness.messages.filter((message) => message.type === "rescanTab");
  assert.equal(
    userRescans.at(-1).tabId,
    84,
    "refresh button must rescan the currently active tab instead of the tab captured when the popup opened",
  );

  const animationHarness = createHarness();
  await animationHarness.ready();
  animationHarness.holdNextUserRescan();
  const rescanClick = animationHarness.element("rescan").click();
  await flushPromises();

  assert.match(
    animationHarness.element("rescan").className,
    /\bis-refreshing\b/,
    "refresh button must show a refreshing class while the rescan request is pending",
  );
  assert.equal(animationHarness.element("rescan").getAttribute("aria-busy"), "true");

  animationHarness.resolveUserRescan();
  await rescanClick;
  assert.doesNotMatch(animationHarness.element("rescan").className, /\bis-refreshing\b/);
  assert.equal(animationHarness.element("rescan").getAttribute("aria-busy"), "false");

  const completedDownload = {
    id: "download-1",
    status: "done",
    title: "Downloaded video",
    url: "https://example.test/video.mp4",
  };
  const clearDownloadsHarness = createHarness({
    initialDownloads: [completedDownload],
  });

  await clearDownloadsHarness.ready();
  assert.equal(clearDownloadsHarness.element("downloadList").children.length, 1);

  await clearDownloadsHarness.element("clear").click();
  await flushPromises();

  assert.ok(
    clearDownloadsHarness.messages.some((message) => message.type === "clearDownloads"),
    "clear button must ask the background page to clear the downloaded list",
  );
  assert.equal(
    clearDownloadsHarness.element("downloadList").children[0].textContent,
    "No downloads yet.",
    "clear button must empty the downloaded list after clearing detected videos",
  );

  const clearHarness = createHarness({
    initialVideos: [refreshedVideo],
    clearResponse: { ok: false, error: "Clear failed" },
  });

  await clearHarness.ready();
  assert.equal(clearHarness.element("videoList").children.length, 1);

  await clearHarness.element("clear").click();
  await flushPromises();

  assert.equal(
    clearHarness.element("message").textContent,
    "Clear failed",
    "clear button must surface background clear failures instead of silently refreshing",
  );
  assert.match(clearHarness.element("message").className, /\berror\b/);

  console.log("popup refresh and clear action tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
