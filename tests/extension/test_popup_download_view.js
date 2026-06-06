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
  /function\s+appendDownloadProgress\s*\(/,
  "popup must render download progress bars from a shared helper"
);

assert.match(
  js,
  /function\s+downloadProgressButtonText\s*\(/,
  "video row download button must show numeric progress when known"
);

assert.match(
  js,
  /const\s+ACTIVE_DOWNLOAD_STATUSES\s*=\s*new Set\(\[[^\]]*"paused"/,
  "popup must treat paused downloads as occupying the video row"
);

assert.match(
  js,
  /status === "paused"[\s\S]*?return "Paused"/,
  "video row download button must show paused state instead of enabling a duplicate download"
);

assert.match(
  js,
  /job\?\.fragment/,
  "video row download button must surface fragment activity when exact percent is unavailable"
);

assert.match(
  js,
  /button\.textContent\s*=\s*runningJob\s*\?\s*downloadProgressButtonText\(runningJob\)\s*:\s*"Unsupported"/,
  "active video row button must show progress instead of only a blinking Downloading label"
);

assert.match(
  js,
  /appendDownloadProgress\(content,\s*runningJob,\s*\{\s*compact:\s*true\s*\}\)/,
  "active video rows must show a compact download progress bar"
);

assert.match(
  js,
  /appendDownloadProgress\(item,\s*job\)/,
  "downloads list must show progress for active jobs"
);

assert.doesNotMatch(
  js,
  /const\s+knownPercent\s*=\s*hasDownloadPercent\(job\);\s*if\s*\(\s*!knownPercent\s*\)\s*\{\s*return;\s*\}/s,
  "active downloads must still render a progress bar while exact percent is not available yet"
);

assert.doesNotMatch(
  css,
  /\.progress\.indeterminate/,
  "popup must not show a fake loading-loop progress bar when exact percent is unavailable"
);

assert.doesNotMatch(
  js,
  /indeterminate/,
  "popup script must not render fake indeterminate download progress"
);

assert.doesNotMatch(
  js,
  /return\s+"Downloading"/,
  "popup should not fall back to a generic Downloading label when real progress is unavailable"
);

assert.match(
  js,
  /function\s+downloadMessageText\s*\(/,
  "popup must normalize download status text before rendering it"
);

assert.doesNotMatch(
  js,
  /message\.textContent\s*=\s*job\.error\s*\|\|\s*job\.message\s*\|\|\s*job\.url\s*\|\|\s*""/,
  "popup must not directly render stale fake Downloading... job messages"
);

assert.match(
  js,
  /if\s*\(\s*messageText\s*\)\s*\{\s*item\.append\(message\);/s,
  "popup must omit the download message row when there is no real progress or useful status text"
);

assert.doesNotMatch(
  css,
  /@keyframes\s+progress-indeterminate/,
  "popup must not animate fake download progress"
);

assert.match(
  css,
  /\.progress-label/,
  "popup must show a readable progress label next to the bar"
);

assert.match(
  js,
  /Downloading fragments/,
  "popup progress label must show segmented download activity when fragment details are available"
);

assert.match(
  js,
  /Downloading at/,
  "popup progress label must show speed-based activity when segmented downloads lack exact percent"
);

assert.match(
  js,
  /function\s+downloadDetailEntries\s*\(/,
  "popup must collect available download metadata into detail rows"
);

assert.match(
  js,
  /function\s+appendDownloadDetails\s*\(/,
  "popup must render full download details in the downloads tab"
);

assert.match(
  js,
  /appendDownloadDetails\(item,\s*job\)/,
  "downloads list must include the full download detail block for each job"
);

for (const detail of ["Speed", "ETA", "Downloaded", "Total size", "Source URL", "Saved file", "Helper output"]) {
  assert.match(js, new RegExp(detail), `popup details must include ${detail} when available`);
}

assert.match(
  css,
  /\.download-details/,
  "popup must style the download detail grid"
);

assert.match(
  css,
  /\.download-detail/,
  "popup must style individual download detail rows"
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
