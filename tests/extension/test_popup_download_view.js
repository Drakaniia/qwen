import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as DownloadList from "../../src/popup/download_list.js";

const __dirname = import.meta.dirname;
const popupDir = path.join(__dirname, "../../src/popup");
const html = fs.readFileSync(path.join(popupDir, "popup.html"), "utf8");
const js = fs.readFileSync(path.join(popupDir, "popup.js"), "utf8");
const css = fs.readFileSync(path.join(popupDir, "popup.css"), "utf8");
const overlayCss = fs.readFileSync(path.join(__dirname, "../../src/shared/qwin_overlay.css"), "utf8");
const qualityDialogJs = fs.readFileSync(path.join(__dirname, "../../src/shared/quality_dialog.js"), "utf8");
const downloadListJs = fs.readFileSync(path.join(popupDir, "download_list.js"), "utf8");
const popupUiJs = fs.readFileSync(path.join(popupDir, "popup-ui.js"), "utf8");
const popupStateJs = fs.readFileSync(path.join(popupDir, "popup-state.js"), "utf8");

function popupLabelHelpers() {
  return {
    downloadProgressButtonText: DownloadList.downloadProgressButtonText,
    downloadProgressLabel: DownloadList.downloadProgressLabel,
  };
}

assert.match(html, /<button[^>]+id="showMusic"[^>]*>Music<\/button>/, "popup must expose a Music button");
assert.match(html, /<button[^>]+id="showDownloads"[^>]*>Downloads<\/button>/, "popup must expose a Downloads button");

for (const layoutButton of ["showListLayout", "showBoxLayout"]) {
  assert.match(
    html,
    new RegExp(`<button[^>]+id="${layoutButton}"`),
    `popup must expose ${layoutButton} for video list layout switching`,
  );
}

assert.match(html, /id="videoToolbar"/, "popup must include a video-only toolbar for list and box controls");

assert.match(html, /<script src="popup\.bundle\.js"><\/script>/, "popup must load the bundled popup script");

assert.match(
  html,
  /<div class="topbar-actions">[\s\S]*<button[^>]+id="rescan"[^>]+class="icon-button"[^>]+aria-label="Rescan"[^>]+title="Rescan"[\s\S]*<svg[\s\S]*<\/button>\s*<button[^>]+id="settingsToggle"/,
  "popup topbar must show an icon-only Rescan button immediately to the left of Settings",
);

{
  const footerMatch = html.match(/<footer id="footerActions">([\s\S]*?)<\/footer>/);
  assert.ok(footerMatch, "popup must keep footer actions for non-header controls");
  assert.doesNotMatch(footerMatch[1], /id="rescan"|>Rescan</, "footer must not keep the old text Rescan button");
}

assert.match(css, /\.topbar-actions/, "popup must align header action icons as a group");

for (const containerId of ["viewToggle", "contentView", "footerActions"]) {
  assert.match(
    html,
    new RegExp(`id="${containerId}"`),
    `popup must expose ${containerId} so settings can hide non-settings UI`,
  );
}

assert.match(
  html,
  /id="settingsStatus"/,
  "settings panel must include an in-panel status message when the main content is hidden",
);

assert.match(
  html,
  /<input[^>]+id="manualUrl"[^>]+type="url"/,
  "settings panel must expose a manual URL input for extractor fallback downloads",
);

assert.match(
  html,
  /<button[^>]+id="downloadManualUrl"[^>]*>Download link<\/button>/,
  "settings panel must expose a manual link download button",
);

assert.match(
  html,
  /<button[^>]+id="chooseDownloadFolder"[^>]*>Browse<\/button>/,
  "settings panel must expose a Browse button for selecting the download folder",
);

assert.match(js, /function\s+setViewMode\s*\(\s*mode\s*\)/, "popup script must provide a view-mode toggle");

assert.match(
  js,
  /function\s+setSettingsOpen\s*\(\s*open\s*\)/,
  "popup script must provide a settings-only view toggle",
);

for (const hiddenTarget of ["viewToggle", "contentView", "footerActions"]) {
  assert.match(
    js,
    new RegExp(`elements\\.${hiddenTarget}\\.hidden\\s*=\\s*open`),
    `settings-only view must hide ${hiddenTarget}`,
  );
}

assert.match(js, /elements\.settingsPanel\.hidden\s*=\s*!open/, "settings-only view must show the settings panel");

assert.match(
  js,
  /settingsToggle\.setAttribute\("aria-expanded",\s*String\(open\)\)/,
  "settings button must expose whether the settings-only view is open",
);

assert.match(
  js,
  /setMessage\("No downloadable video or music detected yet\."/,
  "popup empty state must say no downloadable URL was detected instead of implying scanning is still running",
);

assert.match(
  js,
  /downloadManualUrl:\s*document\.getElementById\("downloadManualUrl"\)/,
  "popup script must track the manual link button",
);

assert.match(
  js,
  /chooseDownloadFolder:\s*document\.getElementById\("chooseDownloadFolder"\)/,
  "popup script must track the download-folder Browse button",
);

assert.match(
  popupStateJs,
  /function\s+isUnknownMessageTypeError\s*\(/,
  "popup-state module must detect the stale-background Unknown message type error",
);

assert.match(
  js,
  /Reload Qwin from the browser extensions page/,
  "popup must show an actionable reload message when the background worker is stale",
);

assert.match(
  js,
  /elements\.downloadFolder\.value\s*=\s*\(response\.settings\s*&&\s*response\.settings\.downloadFolder\)\s*\|\|\s*response\.path\s*\|\|\s*""/,
  "popup must display the selected folder returned by the native picker",
);

assert.match(
  js,
  /formatsResponse\.videoId\s*\|\|\s*button\.dataset\.videoId/,
  "detected video flow must use the fallback video id returned by quality lookup",
);

assert.match(
  js,
  /elements\.musicLinkSection\.hidden\s*=\s*!isMusic/,
  "music mode must show the music link input section",
);

assert.match(js, /elements\.videoList\.hidden\s*=\s*isDownloads/, "downloads mode must hide detected videos");

assert.match(js, /elements\.downloadList\.hidden\s*=\s*!isDownloads/, "downloads mode must show only downloads");

assert.match(css, /\.view-toggle/, "popup must style the view switch controls");

assert.match(
  js,
  /button\.textContent\s*=\s*runningJob\s*\?\s*DownloadList\.downloadProgressButtonText\(runningJob\)\s*:\s*"Unsupported"/,
  "active video row button must show progress instead of only a blinking Downloading label",
);

assert.match(
  js,
  /DownloadList\.appendDownloadProgress\(content,\s*runningJob,\s*\{\s*compact:\s*true\s*\}\)/,
  "active video rows must show a compact download progress bar",
);

assert.match(
  downloadListJs,
  /appendDownloadProgress\(item,\s*job\)/,
  "downloads list must show progress for active jobs",
);

assert.doesNotMatch(
  js,
  /const\s+knownPercent\s*=\s*hasDownloadPercent\(job\);\s*if\s*\(\s*!knownPercent\s*\)\s*\{\s*return;\s*\}/s,
  "active downloads must still render a progress bar while exact percent is not available yet",
);

assert.match(
  css,
  /\.progress-bar\.indeterminate/,
  "popup must style an indeterminate progress bar for post-download processing stages",
);

assert.match(
  downloadListJs,
  /isProcessingStage\(job\)/,
  "download list module must gate indeterminate progress on processing stage detection",
);

assert.doesNotMatch(
  js,
  /return\s+"Downloading"/,
  "popup should not fall back to a generic Downloading label when real progress is unavailable",
);

assert.match(
  downloadListJs,
  /function\s+downloadMessageText\s*\(/,
  "download list module must normalize download status text before rendering it",
);

assert.doesNotMatch(
  downloadListJs,
  /message\.textContent\s*=\s*job\.error\s*\|\|\s*job\.message\s*\|\|\s*job\.url\s*\|\|\s*""/,
  "download list module must not directly render stale fake Downloading... job messages",
);

assert.match(
  downloadListJs,
  /if\s*\(\s*messageText\s*\)\s*\{\s*item\.append\(message\);/s,
  "download list module must omit the download message row when there is no real progress or useful status text",
);

assert.match(
  css,
  /@keyframes\s+progress-loop/,
  "popup must animate indeterminate progress for post-download processing",
);

assert.match(css, /\.progress-label/, "popup must show a readable progress label next to the bar");

assert.match(
  downloadListJs,
  /Downloading video segments/,
  "download list progress label must show segmented download activity when fragment details are available",
);

assert.match(
  downloadListJs,
  /Downloading video segments at/,
  "download list progress label must show speed-based activity when segmented downloads lack exact percent",
);

{
  const helpers = popupLabelHelpers();
  const postprocessJob = { status: "running", stage: "postprocess", percent: 100, format: "M3U8" };

  assert.equal(
    helpers.downloadProgressLabel(postprocessJob),
    "Merging downloaded segments...",
    "postprocess stage must show merging text instead of stale 100% downloaded text",
  );
  assert.equal(
    helpers.downloadProgressButtonText(postprocessJob),
    "Merging",
    "compact active download buttons must show merging after segmented downloads finish",
  );
}

assert.match(
  downloadListJs,
  /function\s+downloadDetailEntries\s*\(/,
  "download list module must collect available download metadata into detail rows",
);

assert.match(
  downloadListJs,
  /function\s+appendDownloadDetails\s*\(/,
  "download list module must render full download details in the downloads tab",
);

assert.match(
  downloadListJs,
  /appendDownloadDetails\(item,\s*job\)/,
  "downloads list must include the full download detail block for each job",
);

for (const detail of ["Speed", "ETA", "Downloaded", "Total size", "Source URL", "Saved file", "Helper output"]) {
  assert.match(downloadListJs, new RegExp(detail), `download list details must include ${detail} when available`);
}

assert.match(css, /\.download-details/, "popup must style the download detail grid");

assert.match(css, /\.download-detail/, "popup must style individual download detail rows");

assert.match(
  js,
  /const\s+qualityChooser\s*=\s*qualityDialog\.create\(/,
  "popup must create the shared quality chooser",
);

assert.match(
  js,
  /function\s+showQualityLoading\s*\(/,
  "popup must show the quality dialog immediately while versions load",
);

assert.match(
  js,
  /qualityChooser\.showLoading\(/,
  "popup loading state must be delegated to the shared quality chooser",
);

assert.match(
  js,
  /const\s+requestToken\s*=\s*showQualityLoading\(\)/,
  "popup download clicks must open a loading dialog before asking the helper for formats",
);

assert.ok(
  js.indexOf("const requestToken = showQualityLoading()") <
    js.indexOf("const formatsResponse = await PopupApi.getVideoFormats("),
  "popup must show loading feedback before awaiting getVideoFormats",
);

assert.match(
  js,
  /function\s+setVideoLayoutMode\s*\(\s*mode\s*\)/,
  "popup script must provide a video layout-mode toggle",
);

assert.match(
  js,
  /elements\.videoList\.classList\.toggle\("boxes"/,
  "popup must switch the video list into a boxes layout",
);

assert.match(popupUiJs, /function\s+videoThumbnailUrl\s*\(/, "popup-ui module must resolve a thumbnail URL for box cards");

assert.match(js, /thumb\.className\s*=\s*"video-thumbnail"/, "popup video box cards must render thumbnail images");

assert.match(js, /sizeEl\.className\s*=\s*"video-size"/, "popup video list must render a video-size metadata item");

assert.match(css, /\.video-size/, "popup must style video size metadata");

assert.match(
  qualityDialogJs,
  /button\.dataset\.variantId\s*=/,
  "quality choices must preserve the selected source variant id",
);

assert.match(
  qualityDialogJs,
  /button\.dataset\.backend\s*=/,
  "quality choices must preserve the selected downloader backend",
);

assert.match(js, /selectedFormat\.variantId,/, "download requests must send the selected source variant id");

assert.match(js, /selectedFormat\.backend,/, "download requests must send the selected downloader backend");

assert.match(css, /@import url\("\.\.\/shared\/qwin_overlay\.css"\);/, "popup must import shared overlay styles");

assert.match(overlayCss, /\.quality-table/, "quality dialog must use a comparison table layout");

assert.match(overlayCss, /\.quality-header/, "quality dialog must label comparison columns");

assert.match(overlayCss, /\.quality-loading/, "quality dialog must style the immediate loading state");

console.log("popup download view tests passed");
