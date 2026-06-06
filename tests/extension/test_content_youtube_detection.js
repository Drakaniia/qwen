const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filters = require(path.join(__dirname, "../../src/shared/video_filters.js"));
const qualityFormat = require(path.join(__dirname, "../../src/shared/quality_format.js"));
const source = fs.readFileSync(path.join(__dirname, "../../src/content/content.js"), "utf8");

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
    performance: { getEntriesByType() { return []; } },
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
  context.QwinVideoFilters = filters;
  context.QwinQualityFormat = qualityFormat;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "content.js" });
  return context;
}

const context = createContentContext("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(
  typeof context.youtubePageCandidateForVideo,
  "function",
  "content script must expose a YouTube page candidate builder for scanner tests"
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

const candidate = context.youtubePageCandidateForVideo(video);
assert.equal(candidate.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
assert.equal(candidate.format, "YOUTUBE");
assert.equal(candidate.source, "youtube-page");
assert.equal(candidate.downloadable, true);
assert.equal(candidate.title, "Example YouTube Video");
assert.equal(candidate.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

const nonYouTubeContext = createContentContext("https://example.com/watch?v=dQw4w9WgXcQ");
assert.equal(nonYouTubeContext.youtubePageCandidateForVideo(video), null);

console.log("content YouTube detection tests passed");
