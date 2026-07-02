import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const popupBundle = fs.readFileSync(path.join(__dirname, "../../../dist/test/popup.bundle.js"), "utf8");

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
  "magnetUrl",
  "downloadMagnet",
  "downloadTorrentFile",
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
  "recordingMode",
  "backend",
  "downloadSubtitles",
  "downloadAllBtn",
  "batchCancelBtn",
  "syncHistoryToggle",
  "syncStatus",
  "depBanner",
  "depBannerToggle",
  "depBannerBody",
  "depBannerList",
  "depBannerTitle",
  "depBannerCopyBtn",
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

function createHarness({ dependencies = {} } = {}) {
  const document = createDocument();

  const browserMock = {
    tabs: {
      async query() {
        return [{ id: 42, url: "https://example.test/" }];
      },
    },
    runtime: {
      async sendMessage(message) {
        if (message.type === "getVideos") {
          return {
            ok: true,
            videos: [],
            downloads: [],
            settings: { downloadFolder: "" },
          };
        }
        if (message.type === "pingNativeHost" || message.type === "getHelperStatus") {
          return {
            ok: true,
            connected: true,
            version: "1.2.3",
            dependencies: {
              ytDlp: true,
              ffmpeg: true,
              aria2c: true,
              nM3u8DlRe: true,
              streamlink: true,
              cdmCapture: false,
              recording: false,
              ...dependencies,
            },
          };
        }
        return { ok: true };
      },
      onMessage: {
        addListener() {},
      },
    },
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
    element: (id) => document.element(id),
    async ready() {
      await flushPromises();
    },
  };
}

(async () => {
  // ─── Test 1: CDM capture + recording both available ────────────────────────

  const bothHarness = createHarness({
    dependencies: { cdmCapture: true, recording: true },
  });
  await bothHarness.ready();

  const bothText = bothHarness.element("helperStatus").textContent;
  assert.match(
    bothText,
    /CDM capture \+ recording/,
    `helper status should mention "CDM capture + recording" when both are available. Got: ${bothText}`,
  );
  assert.match(bothText, /Helper ready/, `helper status should start with "Helper ready". Got: ${bothText}`);

  // ─── Test 2: Only recording available ──────────────────────────────────────

  const recordHarness = createHarness({
    dependencies: { cdmCapture: false, recording: true },
  });
  await recordHarness.ready();

  const recordText = recordHarness.element("helperStatus").textContent;
  assert.match(
    recordText,
    /recording available/,
    `helper status should mention "recording available" when only recording is available. Got: ${recordText}`,
  );
  assert.doesNotMatch(
    recordText,
    /CDM/,
    `helper status should not mention CDM when only recording is available. Got: ${recordText}`,
  );

  // ─── Test 3: Only CDM capture available ────────────────────────────────────

  const cdmHarness = createHarness({
    dependencies: { cdmCapture: true, recording: false },
  });
  await cdmHarness.ready();

  const cdmText = cdmHarness.element("helperStatus").textContent;
  assert.match(
    cdmText,
    /CDM/,
    `helper status should mention "CDM" when only CDM capture is available. Got: ${cdmText}`,
  );
  assert.doesNotMatch(
    cdmText,
    /recording/,
    `helper status should not mention recording when only CDM is available. Got: ${cdmText}`,
  );

  // ─── Test 4: Neither CDM nor recording available ───────────────────────────

  const noneHarness = createHarness({
    dependencies: { cdmCapture: false, recording: false },
  });
  await noneHarness.ready();

  const noneText = noneHarness.element("helperStatus").textContent;
  assert.doesNotMatch(
    noneText,
    /CDM|recording/,
    `helper status should not mention CDM or recording when neither is available. Got: ${noneText}`,
  );
  // Should still show stream fallbacks as before
  assert.match(noneText, /stream fallbacks/, `helper status should still mention stream fallbacks. Got: ${noneText}`);

  // ─── Test 5: Neither CDM nor recording, stream fallbacks only ──────────────

  const basicHarness = createHarness({
    dependencies: { ytDlp: true, ffmpeg: true, nM3u8DlRe: false, streamlink: false },
  });
  await basicHarness.ready();

  const basicText = basicHarness.element("helperStatus").textContent;
  assert.match(basicText, /yt-dlp only/, `without fallback tools, should say "yt-dlp only". Got: ${basicText}`);

  // ─── Test 6: Helper not connected ─────────────────────────────────────────

  const noConnBrowser = {
    tabs: {
      async query() {
        return [{ id: 42, url: "https://example.test/" }];
      },
    },
    runtime: {
      async sendMessage(message) {
        if (message.type === "getVideos") {
          return { ok: true, videos: [], downloads: [], settings: {} };
        }
        if (message.type === "pingNativeHost") {
          return { ok: false, error: "Not connected" };
        }
        return { ok: true };
      },
      onMessage: {
        addListener() {},
      },
    },
  };

  const noConnDoc = createDocument();
  const noConnSandbox = {
    URL,
    browser: noConnBrowser,
    document: noConnDoc,
    console,
    window: {
      setTimeout(callback) {
        return { callback };
      },
      clearTimeout() {},
    },
  };
  vm.createContext(noConnSandbox);
  vm.runInContext(popupBundle, noConnSandbox, { filename: "popup.bundle.js" });
  await flushPromises();

  const noConnText = noConnDoc.element("helperStatus").textContent;
  assert.match(
    noConnText,
    /Helper not connected/,
    `helper status should show "Helper not connected". Got: ${noConnText}`,
  );

  console.log("popup CDM status display tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
