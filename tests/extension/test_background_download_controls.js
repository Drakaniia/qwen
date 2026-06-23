import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;

const source = [
  fs.readFileSync(path.join(__dirname, "../../../src/background/download_helpers.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/header_utils.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/video_utils.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/filter_integration.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/size_probe.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/format_helpers.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/recording.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/background.js"), "utf8"),
  fs.readFileSync(path.join(__dirname, "../../../src/background/download_orchestration.js"), "utf8"),
].join("\n");
const downloadStateSource = fs.readFileSync(path.join(__dirname, "../../../src/background/download_state.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../manifest.json"), "utf8"));

assert.ok(
  manifest.permissions.includes("cookies"),
  "extension must be able to pass browser session cookies to the native helper",
);

assert.match(source, /const\s+downloadPortsById\s*=\s*\{\}/, "background must track active native download ports");

for (const nativeType of ["pause", "resume", "cancel", "openFile", "showFile"]) {
  assert.match(source, new RegExp(`type: "${nativeType}"`), `background must send native ${nativeType} messages`);
}

assert.match(
  source,
  /type: "deleteArtifacts"/,
  "background must ask the native host to delete downloaded files and leftover artifacts",
);
assert.match(
  source,
  /downloadFolder:\s*job\.downloadFolder\s*\|\|\s*tabState\.getSettings\(\)\.downloadFolder\s*\|\|\s*""/,
  "background must send the original or current download folder when deleting artifacts",
);

for (const runtimeType of [
  "pauseDownload",
  "resumeDownload",
  "cancelDownload",
  "retryDownload",
  "openDownloadedFile",
  "showDownloadedFile",
  "removeDownload",
  "clearDownloads",
  "openPopup",
]) {
  assert.match(
    source,
    new RegExp(`messageRouter\\.handle\\("${runtimeType}"`),
    `background must handle ${runtimeType}`,
  );
}

assert.match(
  source,
  /async function clearDownloads/,
  "background must be able to clear completed download history from the popup",
);

assert.match(source, /async function retryDownload/, "background must be able to redownload a previous job");

assert.match(
  source,
  /async function resumeDownload/,
  "background must be able to resume a paused job even after reconnecting to the native helper",
);

assert.match(
  source,
  /function\s+findBlockingDownloadJobForVideo\s*\(/,
  "background must detect an existing queued, running, or paused job for a selected video",
);

assert.match(
  source,
  /BLOCKING_DOWNLOAD_STATUSES\s*=\s*new Set\(\[[^\]]*"paused"/,
  "background must treat paused downloads as duplicate-blocking jobs",
);

assert.match(
  source,
  /async function cancelDownload/,
  "background must be able to cancel a paused job even when no active native port remains",
);

assert.match(
  source,
  /async function cleanupDownloadArtifacts\(jobId,\s*job/,
  "background must clean leftover artifacts when canceling without an active native helper port",
);

assert.match(
  source,
  /await (?:deps\.)?cleanupDownloadArtifacts\(jobId,\s*job\)/,
  "background no-port cancellation must request artifact cleanup before recording the canceled state",
);

assert.match(
  source,
  /artifactCleanupDeleted/,
  "background must consume native cleanup results from canceled downloads",
);

assert.doesNotMatch(
  source,
  /\.filter\(\(job\) => job\.tabId === tabId\)/,
  "downloads must not be filtered to the current tab; active jobs should remain visible after changing or closing tabs",
);

assert.match(
  source,
  /async function probeVideoSize/,
  "background must probe direct media size when response headers did not include it",
);

assert.match(source, /method:\s*"HEAD"/, "background size probing must try HEAD first");

assert.match(source, /"Range",\s*"bytes=0-0"/, "background size probing must fall back to a one-byte range request");

assert.match(source, /function\s+updateVideoSize/, "background must update stored videos after a size probe succeeds");

assert.match(
  source,
  /artifactRoot:\s*message\.artifactRoot/,
  "background must remember the native helper artifact folder for later deletion",
);

assert.match(
  source,
  /thumbnailUrl:\s*input\.thumbnailUrl\s*\|\|\s*current\?\.thumbnailUrl\s*\|\|\s*""/,
  "background must preserve thumbnail URLs from DOM-detected downloadable videos",
);

assert.match(
  source,
  /onBeforeSendHeaders\.addListener/,
  "background must capture media request headers used by the browser",
);

assert.match(
  source,
  /"requestHeaders",\s*"extraHeaders"/,
  "background must request extraHeaders so Cookie/Origin-style media headers can be captured when supported",
);

assert.match(
  source,
  /async function nativeRequestHeadersForVideo/,
  "background must build browser-context headers for native yt-dlp requests",
);

assert.match(
  source,
  /requestHeaders:\s*\(?await .*?nativeRequestHeadersForVideo/,
  "background must send browser-context headers to the native helper",
);
assert.match(
  source,
  /video\.source\s*===\s*"youtube-page"/,
  "background quality fallback labels must not expose the internal youtube-page source marker",
);
assert.match(
  source,
  /existingJob\.requestHeaders/,
  "background must reuse stored request headers when resuming an existing job",
);
assert.match(
  source,
  /requestHeaders:\s*requestHeaders/,
  "background must persist the exact native request headers with the download job",
);
assert.match(
  source,
  /requestHeaders:\s*job\.requestHeaders/,
  "background must restore request headers from download history for retry and resume",
);

assert.match(
  source,
  /function\s+isHardAccessError/,
  "background must detect hard access errors such as HTTP 403 or 410",
);

assert.match(source, /markVideoUrlUnavailable/, "background must hide sources that the server has refused");

assert.doesNotMatch(
  source,
  /Downloading\.\.\./,
  "background must not store fake Downloading... text when real percent is unavailable",
);

assert.match(
  source,
  /function\s+downloadProgressMessage\s*\(/,
  "background must format progress messages from actual numeric percent values",
);

assert.match(
  downloadStateSource,
  /function\s+normalizeDownloadProgress\s*\(/,
  "background must normalize helper percent into a monotonic job-level display percent",
);

assert.match(source, /function\s+isSegmentedDownloadJob\s*\(/, "background must identify HLS and DASH downloads");

assert.match(
  source,
  /visibleDownloadProgressPercent\([^)]*isSegmentedDownloadJob\(/s,
  "background must use raw helper percent for HLS and DASH progress",
);

assert.match(
  source,
  /patch\.percent\s*=\s*(?:deps\.)?normalizeDownloadProgress\(jobId,\s*message\.percent\)/,
  "background must route helper percent through download progress normalization",
);

assert.doesNotMatch(
  source,
  /patch\.percent\s*=\s*message\.percent/,
  "background must not allow raw helper percent to make visible progress jump backward",
);

assert.match(
  source,
  /function\s+progressDetailPatchFromMessage\s*\(/,
  "background must preserve parsed helper progress details for the downloads tab",
);

for (const detailField of [
  "rawPercent",
  "downloadedSize",
  "totalSize",
  "speed",
  "eta",
  "connections",
  "rawProgressLine",
]) {
  assert.match(
    downloadStateSource,
    new RegExp(`${detailField}:`),
    `background download state must store ${detailField} from helper progress messages`,
  );
}

console.log("background download control tests passed");
