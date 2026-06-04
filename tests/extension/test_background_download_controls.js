const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../src/background/background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8"));

assert.ok(
  manifest.permissions.includes("cookies"),
  "extension must be able to pass browser session cookies to the native helper"
);

assert.match(
  source,
  /const\s+downloadPortsById\s*=\s*\{\}/,
  "background must track active native download ports"
);

for (const nativeType of ["pause", "resume", "cancel", "openFile", "showFile"]) {
  assert.match(source, new RegExp(`type: "${nativeType}"`), `background must send native ${nativeType} messages`);
}

assert.match(
  source,
  /type: "deleteArtifacts"/,
  "background must ask the native host to delete downloaded files and leftover artifacts"
);

for (const runtimeType of [
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "retryDownload",
  "openDownloadedFile",
  "showDownloadedFile",
  "removeDownload",
]) {
  assert.match(source, new RegExp(`message\\.type === "${runtimeType}"`), `background must handle ${runtimeType}`);
}

assert.match(
  source,
  /async function retryDownload/,
  "background must be able to redownload a previous job"
);

assert.match(
  source,
  /async function resumeDownload/,
  "background must be able to resume a paused job even after reconnecting to the native helper"
);

assert.match(
  source,
  /async function cancelDownload/,
  "background must be able to cancel a paused job even when no active native port remains"
);

assert.doesNotMatch(
  source,
  /\.filter\(\(job\) => job\.tabId === tabId\)/,
  "downloads must not be filtered to the current tab; active jobs should remain visible after changing or closing tabs"
);

assert.match(
  source,
  /async function probeVideoSize/,
  "background must probe direct media size when response headers did not include it"
);

assert.match(
  source,
  /method:\s*"HEAD"/,
  "background size probing must try HEAD first"
);

assert.match(
  source,
  /"Range",\s*"bytes=0-0"/,
  "background size probing must fall back to a one-byte range request"
);

assert.match(
  source,
  /function\s+updateVideoSize/,
  "background must update stored videos after a size probe succeeds"
);

assert.match(
  source,
  /artifactRoot:\s*message\.artifactRoot/,
  "background must remember the native helper artifact folder for later deletion"
);

assert.match(
  source,
  /thumbnailUrl:\s*input\.thumbnailUrl\s*\|\|\s*current\?\.thumbnailUrl\s*\|\|\s*""/,
  "background must preserve thumbnail URLs from DOM-detected downloadable videos"
);

assert.match(
  source,
  /onBeforeSendHeaders\.addListener/,
  "background must capture media request headers used by the browser"
);

assert.match(
  source,
  /"requestHeaders",\s*"extraHeaders"/,
  "background must request extraHeaders so Cookie/Origin-style media headers can be captured when supported"
);

assert.match(
  source,
  /async function nativeRequestHeadersForVideo/,
  "background must build browser-context headers for native yt-dlp requests"
);

assert.match(
  source,
  /requestHeaders:\s*await nativeRequestHeadersForVideo/,
  "background must send browser-context headers to the native helper"
);

assert.match(
  source,
  /function\s+isHardAccessError/,
  "background must detect hard access errors such as HTTP 403 or 410"
);

assert.match(
  source,
  /markVideoUrlUnavailable/,
  "background must hide sources that the server has refused"
);

console.log("background download control tests passed");
