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

console.log("popup download view tests passed");
