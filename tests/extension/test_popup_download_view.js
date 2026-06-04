const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const popupDir = path.join(__dirname, "../../src/popup");
const html = fs.readFileSync(path.join(popupDir, "popup.html"), "utf8");
const js = fs.readFileSync(path.join(popupDir, "popup.js"), "utf8");
const css = fs.readFileSync(path.join(popupDir, "popup.css"), "utf8");

assert.match(
  html,
  /<button[^>]+id="showDownloads"[^>]*>Downloads<\/button>/,
  "popup must expose a Downloads button"
);

for (const layoutButton of ["showListLayout", "showBoxLayout"]) {
  assert.match(
    html,
    new RegExp(`<button[^>]+id="${layoutButton}"`),
    `popup must expose ${layoutButton} for video list layout switching`
  );
}

assert.match(
  html,
  /id="videoToolbar"/,
  "popup must include a video-only toolbar for list and box controls"
);

assert.match(
  js,
  /function\s+setViewMode\s*\(\s*mode\s*\)/,
  "popup script must provide a view-mode toggle"
);

assert.match(
  js,
  /elements\.videoList\.hidden\s*=\s*downloadsOnly/,
  "downloads-only mode must hide detected videos"
);

assert.match(
  js,
  /elements\.downloadList\.hidden\s*=\s*!downloadsOnly/,
  "downloads-only mode must show only downloads"
);

assert.match(
  css,
  /\.view-toggle/,
  "popup must style the view switch controls"
);

for (const action of ["pause", "resume", "cancel", "retry", "open-file", "show-folder", "remove"]) {
  assert.match(js, new RegExp(`appendDownloadAction\\([^\\n]+, "${action}"`), `popup must render ${action} download action`);
}

assert.match(
  js,
  /button\.setAttribute\("data-action", action\)/,
  "download action helper must write data-action attributes"
);

assert.doesNotMatch(
  js,
  /message\.type === "downloadUpdated" && message\.job && message\.job\.tabId === activeTabId/,
  "popup download updates must not be filtered to the active tab"
);

for (const messageType of [
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "retryDownload",
  "openDownloadedFile",
  "showDownloadedFile",
  "removeDownload",
]) {
  assert.match(js, new RegExp(`type: "${messageType}"`), `popup must send ${messageType}`);
}

assert.match(
  css,
  /\.download-actions/,
  "popup must style download action controls"
);

assert.match(
  js,
  /function\s+formatQualityValue\s*\(/,
  "popup must format quality metadata for comparison rows"
);

assert.match(
  js,
  /function\s+showQualityLoading\s*\(/,
  "popup must show the quality dialog immediately while versions load"
);

assert.match(
  js,
  /const\s+requestToken\s*=\s*showQualityLoading\(\)/,
  "popup download clicks must open a loading dialog before asking the helper for formats"
);

assert.ok(
  js.indexOf("const requestToken = showQualityLoading()") < js.indexOf("const formatsResponse = await runtimeMessage({"),
  "popup must show loading feedback before awaiting getVideoFormats"
);

assert.match(
  js,
  /function\s+videoSizeLabel\s*\(/,
  "popup video list must format known video sizes"
);

assert.match(
  js,
  /function\s+setVideoLayoutMode\s*\(\s*mode\s*\)/,
  "popup script must provide a video layout-mode toggle"
);

assert.match(
  js,
  /elements\.videoList\.classList\.toggle\("boxes"/,
  "popup must switch the video list into a boxes layout"
);

assert.match(
  js,
  /function\s+videoThumbnailUrl\s*\(/,
  "popup video list must resolve a thumbnail URL for box cards"
);

assert.match(
  js,
  /thumb\.className\s*=\s*"video-thumbnail"/,
  "popup video box cards must render thumbnail images"
);

assert.match(
  js,
  /size\.className\s*=\s*"video-size"/,
  "popup video list must render a video-size metadata item"
);

assert.match(
  css,
  /\.video-size/,
  "popup must style video size metadata"
);

assert.match(
  js,
  /button\.dataset\.variantId\s*=/,
  "quality choices must preserve the selected source variant id"
);

assert.match(
  js,
  /variantId:\s*selectedFormat\.variantId/,
  "download requests must send the selected source variant id"
);

assert.match(
  css,
  /\.quality-table/,
  "quality dialog must use a comparison table layout"
);

assert.match(
  css,
  /\.quality-header/,
  "quality dialog must label comparison columns"
);

assert.match(
  css,
  /\.quality-loading/,
  "quality dialog must style the immediate loading state"
);

console.log("popup download view tests passed");
