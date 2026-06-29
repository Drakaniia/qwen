/**
 * Test: scanVisiblePlayerFrames should prefer document.title over iframe title
 *
 * Bug: When a page embeds a video via iframe (e.g. hianime.ad), the iframe's
 * title attribute (e.g. "VibePlayer - Fast Streaming with FullHD") takes
 * priority over the page's document.title (e.g. "Anime Rent-a-Girlfriend
 * Season 5 Episode 1 Watch Online Free - Hianime"), because the iframe title
 * is not caught by isGenericTitle().
 *
 * Fix: Prefer document.title over iframe title when both are non-generic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const __dirname = import.meta.dirname;
const bundlePath = path.join(__dirname, "../../../dist/test/content.bundle.js");

if (!fs.existsSync(bundlePath)) {
  console.error("ERROR: content.bundle.js not found. Run 'node scripts/build-test-bundles.js' first.");
  process.exit(1);
}

const contentBundle = fs.readFileSync(bundlePath, "utf8");

/**
 * Create a VM context simulating an anime streaming page with an embedded
 * iframe video player.
 */
function createPageContext({ pageUrl, pageTitle, iframeTitle, iframeSrc, capturedMessages }) {
  let onMessageCallback = null;

  const iframe = {
    getAttribute(name) {
      if (name === "title") return iframeTitle;
      if (name === "src") return iframeSrc;
      return null;
    },
    src: iframeSrc,
    getBoundingClientRect() {
      return { width: 640, height: 480 };
    },
    matches() {
      return false;
    },
    querySelectorAll() {
      return [];
    },
  };

  const doc = {
    baseURI: pageUrl,
    title: pageTitle,
    readyState: "loading",
    addEventListener() {},
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return [iframe];
      if (selector === "video, source") return [];
      if (selector === "h1, h2, h3, h4, h5, h6, figcaption, legend") return [];
      if (selector === "*") return [iframe];
      return [];
    },
    documentElement: {},
    scripts: [],
  };

  const context = {
    URL,
    chrome: {
      runtime: {
        sendMessage(msg) {
          capturedMessages.push(msg);
        },
        lastError: null,
        onMessage: {
          addListener(cb) {
            onMessageCallback = cb;
          },
        },
      },
    },
    document: doc,
    location: new URL(pageUrl),
    performance: {
      getEntriesByType() {
        return [];
      },
    },
    window: {
      innerHeight: 1080,
      innerWidth: 1920,
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
    // Used after the bundle runs to trigger a scan
    _triggerScanNow: () => {
      if (onMessageCallback) {
        return onMessageCallback({ type: "scanNow" }, { tab: { id: 1, title: pageTitle } }, () => {});
      }
      return null;
    },
  };
  context.globalThis = context;
  return context;
}

// ─── Test: page title should be preferred over branded iframe title ───

{
  const capturedMessages = [];
  const context = createPageContext({
    pageUrl: "https://hianime.ad/watch/rent-a-girlfriend-season-5/ep-1",
    pageTitle: "Anime Rent-a-Girlfriend Season 5 Episode 1 Watch Online Free - Hianime",
    iframeTitle: "VibePlayer - Fast Streaming with FullHD",
    iframeSrc: "https://vibeplayer.net/e/abc123",
    capturedMessages,
  });

  vm.createContext(context);
  vm.runInContext(contentBundle, context, { filename: "content.bundle.js" });

  // Trigger a scan via the registered onMessage handler
  context._triggerScanNow();

  // Wait for async sendMessage to fire
  const waitForScan = () => {
    return new Promise((resolve) => {
      const check = () => {
        if (capturedMessages.length > 0) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  };

  await Promise.race([waitForScan(), new Promise((r) => setTimeout(r, 2000))]);

  // Find the contentDetectedVideos message
  const videoMessage = capturedMessages.find((m) => m.type === "contentDetectedVideos");

  if (!videoMessage) {
    console.log("FAIL: No contentDetectedVideos message was sent");
    console.log("Captured messages:", JSON.stringify(capturedMessages, null, 2));
    assert.fail("Expected contentDetectedVideos message but none was sent");
  }

  const videos = videoMessage.videos || [];
  const iframeVideo = videos.find((v) => v.source === "iframe-page");

  if (!iframeVideo) {
    console.log("FAIL: No iframe-page video candidate found");
    console.log("Videos found:", JSON.stringify(videos, null, 2));
    assert.fail("Expected an iframe-page video candidate but none was found");
  }

  console.log("Page title:", context.document.title);
  console.log("Video title used:", iframeVideo.title);

  // The page title should be preferred over the iframe title
  assert.equal(
    iframeVideo.title,
    "Anime Rent-a-Girlfriend Season 5 Episode 1 Watch Online Free - Hianime",
    "The iframe video title should be the page's document.title, not the iframe title attribute",
  );

  console.log("✓ Page title correctly preferred over branded iframe title");
}

console.log("\nAll iframe title priority tests passed!");
