import assert from "node:assert/strict";

import * as filters from "../../src/shared/video_filters.js";
import * as pageDetection from "../../src/content/page_detection.js";

function createPageDetection(options = {}) {
  const doc = {
    title: options.docTitle || "Generic Site",
    baseURI: options.url || "https://example.com/video/123",
    querySelector(selector) {
      if (options.meta && selector.startsWith("meta")) {
        const property = selector.match(/property="([^"]+)"/);
        const name = selector.match(/name="([^"]+)"/);
        const key = (property && property[1]) || (name && name[1]);
        if (options.meta[key]) {
          return { content: options.meta[key] };
        }
      }
      const tags = selector.split(",").map((t) => t.trim());
      for (const tag of tags) {
        if (options[tag]) {
          return { textContent: options[tag] };
        }
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const tags = selector.split(",").map((t) => t.trim());
      for (const tag of tags) {
        if (options[tag]) {
          if (Array.isArray(options[tag])) {
            for (const text of options[tag]) {
              results.push({ textContent: text });
            }
          } else {
            results.push({ textContent: options[tag] });
          }
        }
      }
      return results;
    },
    getElementById(id) {
      if (options.elements && options.elements[id]) {
        return { textContent: options.elements[id] };
      }
      return null;
    },
  };

  const loc = new URL(options.url || "https://example.com/video/123");

  return pageDetection.create({
    document: doc,
    location: loc,
    videoFilters: filters,
  });
}

function createVideoMock(attributes = {}, parentHeading = null) {
  const video = {
    getAttribute(name) {
      return attributes[name] || null;
    },
    videoWidth: 1280,
    videoHeight: 720,
    duration: 100,
    getBoundingClientRect() {
      return { width: 1280, height: 720 };
    },
  };

  if (parentHeading) {
    const parent = {
      querySelector(selector) {
        const tags = selector.split(",").map((t) => t.trim());
        if (tags.some((tag) => tag === parentHeading.tag)) {
          return { textContent: parentHeading.text };
        }
        return null;
      },
    };
    video.parentElement = parent;
  }
  return video;
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

const videoMockGeneric = createVideoMock();

console.log("--- Testing Case 1 ---");
const title1 = pd1.titleForVideo(videoMockGeneric, "https://example.com/video.mp4");
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
const title2 = pd2.titleForVideo(videoMockGeneric, "https://example.com/video.mp4");
console.log("Title 2:", title2);
console.log("isGenericTitle('Video Site'):", filters.isGenericTitle("Video Site"));

// With the fix, Title 2 should be "Another Real Title"
assert.equal(title2, "Another Real Title");

// Case 3: Video element attributes: data-title, data-name, alt
console.log("\n--- Testing Case 3 ---");
const pd3 = createPageDetection({
  docTitle: "Generic Site",
});
const videoWithDataTitle = createVideoMock({ "data-title": "My Data Title" });
const title3a = pd3.titleForVideo(videoWithDataTitle, "https://example.com/video.mp4");
console.log("Title 3a:", title3a);
assert.equal(title3a, "My Data Title");

const videoWithDataName = createVideoMock({ "data-name": "My Data Name" });
const title3b = pd3.titleForVideo(videoWithDataName, "https://example.com/video.mp4");
console.log("Title 3b:", title3b);
assert.equal(title3b, "My Data Name");

const videoWithAlt = createVideoMock({ alt: "My Alt Title" });
const title3c = pd3.titleForVideo(videoWithAlt, "https://example.com/video.mp4");
console.log("Title 3c:", title3c);
assert.equal(title3c, "My Alt Title");

// Case 4: Nearest ancestor heading (e.g. h3 or figcaption)
console.log("\n--- Testing Case 4 ---");
const pd4 = createPageDetection({
  docTitle: "Generic Site",
});
const videoWithAncestorHeading = createVideoMock({}, { tag: "h3", text: "Ancestor H3 Title" });
const title4a = pd4.titleForVideo(videoWithAncestorHeading, "https://example.com/video.mp4");
console.log("Title 4a:", title4a);
assert.equal(title4a, "Ancestor H3 Title");

const videoWithFigcaption = createVideoMock({}, { tag: "figcaption", text: "Figcaption Title" });
const title4b = pd4.titleForVideo(videoWithFigcaption, "https://example.com/video.mp4");
console.log("Title 4b:", title4b);
assert.equal(title4b, "Figcaption Title");

// Case 5: Document level headings (h2-h6) as general fallbacks
console.log("\n--- Testing Case 5 ---");
const pd5 = createPageDetection({
  docTitle: "Generic Site",
  h2: "H2 General Title",
});
const title5 = pd5.titleForVideo(videoMockGeneric, "https://example.com/video.mp4");
console.log("Title 5:", title5);
assert.equal(title5, "H2 General Title");

// Case 6: Video call detection via srcObject and hostname
console.log("\n--- Testing Case 6 ---");
const pd6Normal = createPageDetection({
  url: "https://example.com/video/123",
});
const videoNormal = createVideoMock();
assert.equal(pd6Normal.isLikelyRealPlayer(videoNormal), true);

const videoWithSrcObject = createVideoMock();
videoWithSrcObject.srcObject = {}; // mock WebRTC MediaStream
assert.equal(pd6Normal.isLikelyRealPlayer(videoWithSrcObject), false);

const pd6Meet = createPageDetection({
  url: "https://meet.google.com/abc-defg-hij",
});
assert.equal(pd6Meet.isLikelyRealPlayer(videoNormal), false);

const pd6Zoom = createPageDetection({
  url: "https://zoom.us/j/123456789",
});
assert.equal(pd6Zoom.isLikelyRealPlayer(videoNormal), false);

console.log(
  "\nReproduction tests passed: improved logic correctly picks titles from custom attributes, ancestors, and document fallbacks, and detects video calls.",
);
