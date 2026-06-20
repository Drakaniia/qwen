import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const popupDir = path.join(__dirname, "../../src/popup");
const html = fs.readFileSync(path.join(popupDir, "popup.html"), "utf8");
const css = fs.readFileSync(path.join(popupDir, "popup.css"), "utf8");
const downloadListJs = fs.readFileSync(path.join(popupDir, "download_list.js"), "utf8");
const popupBundle = fs.readFileSync(path.join(__dirname, "../../dist/test/popup.bundle.js"), "utf8");

// ─── Element IDs used by the popup (including new recording elements) ───────

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
];

// ─── TestElement helper (mirrored from other test files) ────────────────────

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

  const doc = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      const el = new TestElement(tagName);
      el.ownerDocument = doc;
      return el;
    },
    element(id) {
      return elements.get(id);
    },
  };

  for (const id of POPUP_ELEMENT_IDS) {
    const el = new TestElement("div", id);
    el.ownerDocument = doc;
    elements.set(id, el);
  }
  elements.get("downloadFolder").value = "";
  elements.get("recordingMode").value = "ask";

  return doc;
}

async function flushPromises() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

// ─── CSS Tests ──────────────────────────────────────────────────────────────

assert.ok(css.includes(".record-button"), "CSS must define .record-button for non-downloadable items");
assert.ok(css.includes(".record-page-button"), "CSS must define .record-page-button for zero-detect pages");
assert.ok(css.includes(".recording-item"), "CSS must define .recording-item for download list recording jobs");
assert.ok(css.includes(".recording-icon"), "CSS must define .recording-icon for recording icon");
assert.ok(css.includes("@keyframes recording-pulse"), "CSS must define @keyframes recording-pulse animation");
assert.ok(css.includes(".recording-badge"), "CSS must define .recording-badge for recording status badge");
assert.ok(css.includes(".recording-progress"), "CSS must define .recording-progress for progress display");
assert.ok(css.includes(".recording-duration"), "CSS must define .recording-duration for recording time display");
assert.ok(css.includes("border-top:") && css.includes(".settings-divider"), "CSS must define .settings-divider with border-top");

// ─── HTML Structure Tests ──────────────────────────────────────────────────

assert.ok(
  html.includes('id="recordingMode"') && html.includes('value="ask"') && html.includes("Ask first"),
  "popup.html must have a recordingMode select with 'Ask first' option",
);
assert.ok(
  html.includes('value="manual"') && html.includes("Manual"),
  "popup.html must have 'Manual' recording mode option",
);
assert.ok(
  html.includes('value="auto"') && html.includes("Automatic"),
  "popup.html must have 'Auto' recording mode option",
);
assert.ok(
  html.includes("Qwin can record the tab's video output"),
  "popup.html must include recording mode hint text",
);
assert.ok(
  html.includes('class="settings-divider"') && html.includes('for="recordingMode"'),
  "popup.html must place recording mode settings behind a settings-divider",
);

// ─── Download List Helper Tests ─────────────────────────────────────────────

import * as DownloadList from "../../src/popup/download_list.js";

{
  assert.ok(
    downloadListJs.includes("function formatDuration"),
    "download_list.js must define formatDuration helper",
  );
  assert.ok(
    downloadListJs.includes("function formatFileSize"),
    "download_list.js must define formatFileSize helper",
  );

  assert.ok(
    downloadListJs.includes('"recording-item"'),
    "download_list.js must add recording-item class to recording job elements",
  );
  assert.ok(
    downloadListJs.includes('"recording-icon"'),
    "download_list.js must create a recording-icon element for recording jobs",
  );
  assert.ok(
    downloadListJs.includes('"recording-badge"'),
    "download_list.js must use recording-badge class for recording status badge",
  );
  assert.ok(
    downloadListJs.includes('"recording-progress"'),
    "download_list.js must create recording-progress element",
  );
  assert.ok(
    downloadListJs.includes("Recording: "),
    "download_list.js must show 'Recording: ' duration label",
  );
  assert.ok(
    downloadListJs.includes("Stop recording"),
    "download_list.js must provide a Stop recording button",
  );
}

// ─── Popup Interactive Tests ────────────────────────────────────────────────

function createHarness({ videos = [], downloads = [], settings = {} } = {}) {
  const doc = createDocument();
  const messages = [];

  const browserMock = {
    tabs: {
      async query() {
        return [{ id: 42, url: "https://example.test/video-page" }];
      },
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.type === "getVideos") {
          return {
            ok: true,
            videos,
            downloads,
            settings: {
              downloadFolder: "",
              musicMode: false,
              audioFormat: "mp3",
              recordingMode: "ask",
              ...settings,
            },
          };
        }
        if (message.type === "pingNativeHost") {
          return {
            ok: true,
            version: "test",
            dependencies: {
              ytDlp: true,
              ffmpeg: true,
              cdmCapture: false,
              recording: false,
            },
          };
        }
        if (message.type === "saveSettings") {
          return { ok: true };
        }
        if (message.type === "startRecording") {
          return { ok: true, jobId: message.options?.jobId || "rec_test" };
        }
        if (message.type === "stopRecording") {
          return { ok: true, jobId: message.jobId };
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
    document: doc,
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
    document: doc,
    element: (id) => doc.element(id),
    async ready() {
      await flushPromises();
    },
  };
}

(async () => {
  // ─── Test 1: "Record this page" button on zero-detect pages ───────────────

  const emptyHarness = createHarness({ videos: [] });
  await emptyHarness.ready();

  const videoListChildren = emptyHarness.element("videoList").children;
  const recordPageBtn = Array.from(videoListChildren).find(
    (child) => child.className && child.className.includes("record-page-button"),
  );
  assert.ok(recordPageBtn, 'A "Record this page" button must appear when no videos are detected');
  assert.equal(
    recordPageBtn.textContent,
    "Record this page",
    '"Record this page" button must have correct label',
  );

  // ─── Test 2: Recording mode saved from refresh response ───────────────────

  const settingsHarness = createHarness({
    videos: [],
    settings: { recordingMode: "manual" },
  });
  await settingsHarness.ready();
  assert.equal(
    settingsHarness.element("recordingMode").value,
    "manual",
    "recordingMode select must be set from the settings response",
  );

  // ─── Test 3: Recording mode change saves settings ─────────────────────────

  const changeHarness = createHarness({ videos: [] });
  await changeHarness.ready();

  const recModeEl = changeHarness.element("recordingMode");
  const initialSaveCount = changeHarness.messages.filter((m) => m.type === "saveSettings").length;

  recModeEl.value = "auto";
  for (const listener of recModeEl.listeners.change || []) {
    await listener({ target: recModeEl });
  }
  await flushPromises();

  const savesAfterChange = changeHarness.messages.filter((m) => m.type === "saveSettings").length;
  assert.ok(
    savesAfterChange > initialSaveCount,
    "Changing recording mode must call saveSettings",
  );
  const lastSave = changeHarness.messages.filter((m) => m.type === "saveSettings").pop();
  assert.equal(lastSave.settings.recordingMode, "auto", "saveSettings must include recordingMode: auto");

  // ─── Test 4: Save settings button includes recordingMode ──────────────────

  const saveHarness = createHarness({ videos: [] });
  await saveHarness.ready();

  saveHarness.element("recordingMode").value = "manual";
  await saveHarness.element("saveSettings").click();
  await flushPromises();

  const saveMessages = saveHarness.messages.filter((m) => m.type === "saveSettings");
  const lastSaveSettings = saveMessages[saveMessages.length - 1];
  assert.ok(lastSaveSettings, "saveSettings must be called when save button is clicked");
  assert.ok(
    "recordingMode" in lastSaveSettings.settings,
    "saveSettings must include recordingMode in the settings object",
  );

  // ─── Test 5: Download list renders recording job with icon and stop button ─

  const recordingJob = {
    id: "rec_test_1",
    title: "My recording",
    format: "RECORDING",
    status: "running",
    stage: "recording",
    isRecording: true,
    recordingDuration: 120,
    recordingSizeBytes: 50 * 1024 * 1024,
    recordingFps: 30,
    recordingDroppedFrames: 2,
    message: "Recording... 2m 0s",
    url: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    percent: null,
  };

  const recJobHarness = createHarness({
    videos: [],
    downloads: [recordingJob],
  });
  await recJobHarness.ready();

  const downloadItems = recJobHarness.element("downloadList").children;
  assert.ok(downloadItems.length > 0, "Recording job must be rendered in the download list");
  const recItem = Array.from(downloadItems).find(
    (child) => child.className && child.className.includes("recording-item"),
  );
  assert.ok(recItem, "Recording job must have recording-item class");

  // Check for Stop recording button
  const actionButton = Array.from(recItem.children).find(
    (child) =>
      child.className === "download-actions" &&
      Array.from(child.children).some((btn) => btn.textContent === "Stop recording"),
  );
  const stopButton = actionButton
    ? Array.from(actionButton.children).find((btn) => btn.textContent === "Stop recording")
    : null;
  assert.ok(stopButton, "Recording job must have a Stop recording button");

  // ─── Test 6: Stop recording button triggers stopRecording API ──────────────

  if (stopButton) {
    const preStopCount = recJobHarness.messages.filter((m) => m.type === "stopRecording").length;
    await stopButton.click();
    await flushPromises();
    const postStopCount = recJobHarness.messages.filter((m) => m.type === "stopRecording").length;
    assert.ok(
      postStopCount > preStopCount,
      "Clicking Stop recording must call stopRecording API",
    );
  }

  // ─── Test 7: Completed recording job shows in list ────────────────────────

  const completedRecordingJob = {
    id: "rec_test_2",
    title: "Completed recording",
    format: "RECORDING",
    status: "done",
    stage: "done",
    isRecording: false,
    recordingDuration: 300,
    recordingSizeBytes: 200 * 1024 * 1024,
    message: "Recording complete. Duration: 5m 0s.",
    filepath: "C:\\Videos\\recording.mp4",
    url: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    percent: 100,
  };

  const doneHarness = createHarness({
    videos: [],
    downloads: [completedRecordingJob],
  });
  await doneHarness.ready();

  const doneDownloadItems = doneHarness.element("downloadList").children;
  assert.ok(doneDownloadItems.length > 0, "Completed recording must be rendered in download list");

  // ─── Test 8: Recording progress shows duration ────────────────────────────

  const progressRecordingJob = {
    id: "rec_test_3",
    title: "Progress recording",
    format: "RECORDING",
    status: "running",
    stage: "recording",
    isRecording: true,
    recordingDuration: 65,
    recordingSizeBytes: 25 * 1024 * 1024,
    recordingFps: 30,
    recordingDroppedFrames: 0,
    message: "Recording... 1m 5s, 25.0 MB",
    url: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    percent: null,
  };

  const progressHarness = createHarness({
    videos: [],
    downloads: [progressRecordingJob],
  });
  await progressHarness.ready();

  const progressItems = progressHarness.element("downloadList").children;
  const progressItem = Array.from(progressItems).find(
    (child) => child.className && child.className.includes("recording-item"),
  );
  assert.ok(progressItem, "Progress recording must be rendered with recording-item class");

  // Check for recording duration text
  const hasDurationText = Array.from(progressItem.children).some(
    (child) =>
      child.className === "recording-progress" &&
      Array.from(child.children).some((span) => span.textContent && span.textContent.includes("65")),
  );
  assert.ok(hasDurationText, "Recording progress must show duration in the progress section");

  // ─── Test 9: formatDuration and formatFileSize code coverage ──────────────

  assert.ok(
    downloadListJs.includes("formatDuration(seconds)"),
    "formatDuration must take a seconds parameter",
  );

  console.log("recording UI tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
