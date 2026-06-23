import assert from "node:assert/strict";

import * as downloadState from "../../src/background/download_state.js";

assert.equal(downloadState.clampDownloadPercent("12.4"), 12.4);
assert.equal(downloadState.clampDownloadPercent("bad"), null);
assert.equal(downloadState.clampDownloadPercent(150), 100);
assert.equal(downloadState.clampDownloadPercent(-20), 0);

assert.equal(downloadState.normalizeDownloadProgress(null, 25), 25);
assert.equal(downloadState.normalizeDownloadProgress(40, 35), 40);
assert.equal(downloadState.normalizeDownloadProgress(99, 100), 99);
assert.equal(downloadState.downloadProgressMessage(44.6), "45% downloaded");
assert.equal(downloadState.visibleDownloadProgressPercent(99, 14, true), 14);
assert.equal(downloadState.visibleDownloadProgressPercent(99, 14, false), 99);

assert.deepEqual(downloadState.resetDownloadProgressDetails(), {
  rawPercent: null,
  downloadedSize: "",
  totalSize: "",
  speed: "",
  eta: "",
  connections: null,
  fragment: "",
  rawProgressLine: "",
});

assert.deepEqual(
  downloadState.progressDetailPatchFromMessage({
    percent: 51.2,
    downloadedSize: " 4 MiB ",
    totalSize: "10 MiB",
    speed: "1 MiB/s",
    eta: "00:06",
    connections: 16,
    fragment: "1/3",
    line: "x".repeat(600),
  }),
  {
    rawPercent: 51.2,
    downloadedSize: "4 MiB",
    totalSize: "10 MiB",
    speed: "1 MiB/s",
    eta: "00:06",
    connections: 16,
    fragment: "1/3",
    rawProgressLine: "x".repeat(500),
  },
);

console.log("background download state tests passed");
