import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import * as videoFilters from "../../../src/shared/video_filters.js";
import * as pageDetectionModule from "../../../src/content/page_detection.js";

const __dirname = import.meta.dirname;
const contentBundle = fs.readFileSync(path.join(__dirname, "../../../dist/test/content.bundle.js"), "utf8");

function createContentContext(locationHref) {
  const document = {
    baseURI: locationHref,
    readyState: "loading",
    title: "Example YouTube Video - YouTube",
    addEventListener() {},
    getElementById() {
      return null;
    },
    querySelector(selector) {
      if (selector === 'meta[property="og:title"]') {
        return { content: "Example YouTube Video" };
      }
      if (selector === 'meta[property="og:image"]') {
        return { content: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" };
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    documentElement: {},
  };

  const context = {
    URL,
    chrome: {
      runtime: {
        sendMessage() {},
        onMessage: { addListener() {} },
      },
    },
    document,
    location: new URL(locationHref),
    performance: {
      getEntriesByType() {
        return [];
      },
    },
    window: {
      innerHeight: 720,
      innerWidth: 1280,
      addEventListener() {},
      setTimeout() {},
      setInterval() {},
    },
    MutationObserver: class {
      constructor() {}
      observe() {}
    },
    Node: { ELEMENT_NODE: 1 },
    setTimeout() {},
    setInterval() {},
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(contentBundle, context, { filename: "content.bundle.js" });
  return context;
}

createContentContext("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

function createDetection(locationHref) {
  const document = {
    baseURI: locationHref,
    title: "Example YouTube Video - YouTube",
    getElementById() {
      return null;
    },
    querySelector(selector) {
      if (selector === 'meta[property="og:title"]') {
        return { content: "Example YouTube Video" };
      }
      if (selector === 'meta[property="og:image"]') {
        return { content: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" };
      }
      return null;
    },
  };
  return pageDetectionModule.create({
    document,
    location: new URL(locationHref),
    videoFilters,
    seenUrls: new Map(),
  });
}

const detection = createDetection("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(
  typeof detection.youtubePageCandidateForVideo,
  "function",
  "page detection module must expose a YouTube page candidate builder for scanner tests",
);

const video = {
  videoWidth: 1280,
  videoHeight: 720,
  duration: 12,
  loop: false,
  muted: false,
  autoplay: false,
  currentSrc: "blob:https://www.youtube.com/abc",
  src: "",
  type: "",
  clientWidth: 1280,
  clientHeight: 720,
  getAttribute() {
    return "";
  },
  getBoundingClientRect() {
    return { width: 1280, height: 720 };
  },
  querySelectorAll() {
    return [];
  },
};

const candidate = detection.youtubePageCandidateForVideo(video);
assert.equal(candidate.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(candidate.format, "YOUTUBE");
assert.equal(candidate.source, "youtube-page");
assert.equal(candidate.downloadable, true);
assert.equal(candidate.title, "Example YouTube Video");
assert.equal(candidate.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

const nonYouTubeDetection = createDetection("https://example.com/watch?v=dQw4w9WgXcQ");
assert.equal(nonYouTubeDetection.youtubePageCandidateForVideo(video), null);

console.log("content YouTube detection tests passed");
