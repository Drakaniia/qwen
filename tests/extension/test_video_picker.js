import assert from "node:assert/strict";

import * as videoPicker from "../../src/shared/video_picker.js";
import * as videoFilters from "../../src/shared/video_filters.js";

class TestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.title = "";
    this.type = "";
    this._textContent = "";
    this.listeners = {};
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

  addEventListener(type, listener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  click() {
    for (const listener of this.listeners.click || []) {
      listener();
    }
  }
}

const document = {
  createElement(tagName) {
    return new TestElement(tagName);
  },
};

const container = new TestElement("div");
container.ownerDocument = document;

let selectedVideo = null;
videoPicker.renderList(
  container,
  [
    {
      title: "Sample clip",
      url: "https://example.com/watch?v=abc123456789",
      format: "mp4",
      variantCount: 2,
      sizeBytes: 98_000_000,
    },
  ],
  {
    document,
    videoFilters,
    emptyText: "No downloadable video detected yet.",
    onSelect(video) {
      selectedVideo = video;
    },
  },
);

assert.equal(container.children.length, 1);
const item = container.children[0];
assert.equal(item.tagName, "BUTTON");
assert.match(item.className, /video-picker-item/);

const title = item.children[0].children[0];
const meta = item.children[0].children[1];
assert.equal(title.className, "video-title");
assert.equal(title.textContent, "Sample clip");
assert.equal(meta.children[0].textContent, "MP4");
assert.equal(meta.children[1].textContent, "2 versions");
assert.equal(meta.children[2].className, "video-size");

item.click();
assert.equal(selectedVideo.title, "Sample clip");

container.textContent = "";
videoPicker.renderList(container, [], {
  document,
  emptyText: "Nothing here",
});
assert.equal(container.children[0].className, "qwin-overlay-empty");
assert.equal(container.children[0].textContent, "Nothing here");

console.log("video picker tests passed");
