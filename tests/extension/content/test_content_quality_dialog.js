import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as qualityDialog from "../../../src/shared/quality_dialog.js";
import * as qualityFormat from "../../../src/shared/quality_format.js";
import * as videoFilters from "../../../src/shared/video_filters.js";

const __dirname = import.meta.dirname;
const overlaySource = fs.readFileSync(path.join(__dirname, "../../../src/content/content_overlay.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../manifest.json"), "utf8"));

class TestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.onclick = null;
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
    this.children.push(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  click() {
    for (const listener of this.listeners.click || []) {
      listener({ target: this });
    }
    if (this.onclick) {
      this.onclick({ target: this });
    }
  }
}

function createDocument() {
  return {
    createElement(tagName) {
      return new TestElement(tagName);
    },
  };
}

function createChooser(options = {}) {
  const document = createDocument();
  const root = new TestElement("div");
  const title = new TestElement("div");
  const list = new TestElement("div");
  const cancel = new TestElement("button");
  const back = new TestElement("button");
  const chooser = qualityDialog.create({
    document,
    root,
    title,
    list,
    cancel,
    back,
    qualityFormat,
    videoFilters,
    style: "inline",
    hideOnSelect: false,
    hideOnBack: false,
    showRoot(element) {
      element.style.display = "grid";
    },
    hideRoot(element) {
      element.style.display = "none";
    },
    ...options,
  });

  return { chooser, root, title, list, cancel, back };
}

(async () => {
  {
    const { chooser, root, title, list, cancel } = createChooser();
    let canceled = false;

    chooser.showLoading({
      loadingTitle: "Sample video",
      statusText: "Looking...",
      onCancel() {
        canceled = true;
      },
    });

    assert.equal(root.style.display, "grid");
    assert.equal(title.textContent, "Sample video");
    assert.equal(list.children[0].textContent, "Looking...");

    chooser.updateLoadingStatus("Almost done...");
    assert.equal(list.children[0].textContent, "Almost done...");

    cancel.click();
    assert.equal(canceled, true);
    assert.equal(root.style.display, "none");
  }

  {
    const { chooser, root, title, list, back } = createChooser();
    const selectedPromise = chooser.showChoices({
      choiceTitle: "Sample video",
      hasBack: true,
      formats: [
        {
          formatId: "137",
          variantId: "native-137",
          backend: "yt-dlp",
          height: 1080,
          sizeBytes: 98_000_000,
          ext: "mp4",
          bitrate: 2500,
          source: "yt-dlp",
        },
      ],
    });

    assert.equal(root.style.display, "grid");
    assert.equal(title.textContent, "Compare versions: Sample video");
    assert.equal(back.hidden, false);

    const table = list.children[0];
    const option = table.children[1];
    assert.equal(option.children[0].textContent, "1080p");
    assert.equal(option.children[1].textContent, "93.5 MB");
    assert.equal(option.children[2].textContent, "MP4");
    assert.equal(option.children[3].textContent, "2500 kbps");
    assert.equal(option.children[4].textContent, "yt-dlp");

    option.click();
    assert.deepEqual(await selectedPromise, {
      formatId: "137",
      variantId: "native-137",
      backend: "yt-dlp",
    });
    assert.equal(root.style.display, "grid", "content chooser must remain visible while the download is queued");
    assert.equal(back.hidden, true);
  }

  {
    const { chooser, root, back } = createChooser();
    const selectedPromise = chooser.showChoices({
      choiceTitle: "Sample video",
      hasBack: true,
      formats: [{ id: "best", label: "Best available MP4" }],
    });

    back.click();
    assert.equal(await selectedPromise, null);
    assert.equal(root.style.display, "grid", "back must keep the overlay open so the video list can be restored");
  }

  assert.match(
    overlaySource,
    /button\.addEventListener\("click", async \(event\) => \{[\s\S]*?showAvailableVideosOverlay\(\);/m,
    "content overlay clicks must show the in-page available videos list instead of opening the extension popup",
  );
  assert.match(
    overlaySource,
    /videoPicker\.renderList\(/,
    "content overlay must render available videos through the shared video picker",
  );
  assert.match(overlaySource, /style:\s*"classes"/, "content quality chooser must use the shared class-based styling");
  assert.match(
    overlaySource,
    /root\.id\s*=\s*"qwin-video-overlay"/,
    "content overlay must use the shared overlay shell id",
  );
  assert.doesNotMatch(
    overlaySource,
    /item\.onclick\s*=\s*\(\)\s*=>\s*handleVideoSelection/,
    "content overlay must not keep a bespoke inline-styled video list renderer",
  );
  assert.match(
    overlaySource,
    /type:\s*"downloadVideo"[\s\S]*formatId:\s*selectedFormat\.formatId/s,
    "quality selection must start a download with the selected format",
  );

  const contentScripts = manifest.content_scripts[0];
  assert.deepEqual(
    contentScripts.js,
    ["src/content/content.bundle.js"],
    "content script must use the single esbuild bundle which includes all quality dialog dependencies",
  );
  assert.deepEqual(
    contentScripts.css,
    ["src/shared/qwin_overlay.css"],
    "content script must inject shared overlay styles",
  );

  console.log("content quality dialog tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
