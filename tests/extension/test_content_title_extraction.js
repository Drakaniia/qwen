const assert = require("node:assert/strict");
const path = require("node:path");

const filters = require(path.join(__dirname, "../../src/shared/video_filters.js"));
const pageDetection = require(path.join(__dirname, "../../src/content/page_detection.js"));

function createPageDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Generic Site",
    baseURI: "https://example.com/video/123",
    querySelector(selector) {
      if (options.meta && selector.startsWith("meta")) {
        const property = selector.match(/property="([^"]+)"/);
        const name = selector.match(/name="([^"]+)"/);
        const key = (property && property[1]) || (name && name[1]);
        if (options.meta[key]) {
          return { content: options.meta[key] };
        }
      }
      if (options.h1 && selector === "h1") {
        return { textContent: options.h1 };
      }
      return null;
    },
    getElementById(id) {
      if (options.elements && options.elements[id]) {
        return { textContent: options.elements[id] };
      }
      return null;
    },
  };

  const loc = new URL("https://example.com/video/123");

  return pageDetection.create({
    document: doc,
    location: loc,
    videoFilters: filters,
  });
}

// Case 1: All current metadata is generic, but H1 has a good title
const pd1 = createPageDetection({
  docTitle: "Video Player - ExampleSite",
  meta: {
    "og:title": "Video Player",
    "twitter:title": "Video Player",
  },
  h1: "Real Video Title",
});

const videoMock = {
  getAttribute(_name) {
    return null;
  },
  videoWidth: 1280,
  videoHeight: 720,
  duration: 100,
  getBoundingClientRect() {
    return { width: 1280, height: 720 };
  },
};

console.log("--- Testing Case 1 ---");
const title1 = pd1.titleForVideo(videoMock, "https://example.com/video.mp4");
console.log("Title 1:", title1);
console.log("isGenericTitle('Video Player'):", filters.isGenericTitle("Video Player"));
console.log("isGenericTitle('Video Player - ExampleSite'):", filters.isGenericTitle("Video Player - ExampleSite"));

// With the fix, Title 1 should be "Real Video Title" because H1 is prioritized over generic docTitle
assert.equal(title1, "Real Video Title");

// Case 2: No og:title, no twitter:title, docTitle is generic.
const pd2 = createPageDetection({
  docTitle: "Video Site",
  h1: "Another Real Title",
});

console.log("\n--- Testing Case 2 ---");
const title2 = pd2.titleForVideo(videoMock, "https://example.com/video.mp4");
console.log("Title 2:", title2);
console.log("isGenericTitle('Video Site'):", filters.isGenericTitle("Video Site"));

// With the fix, Title 2 should be "Another Real Title"
assert.equal(title2, "Another Real Title");

console.log(
  "\nReproduction tests passed: improved logic correctly picks titles from H1 and filters out generic site names.",
);
