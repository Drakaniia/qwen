const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../src/background/background.js"), "utf8");

assert.match(
  source,
  /const\s+downloadPortsById\s*=\s*\{\}/,
  "background must track active native download ports"
);

for (const nativeType of ["pause", "resume", "cancel", "openFile", "showFile"]) {
  assert.match(source, new RegExp(`type: "${nativeType}"`), `background must send native ${nativeType} messages`);
}

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

console.log("background download control tests passed");
