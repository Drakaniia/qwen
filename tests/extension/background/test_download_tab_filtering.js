import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;

// ── Test: getTabDownloads must filter by tab ID ──────────────────────────
//
// When the user navigates from Site A to Site B, the popup must only show
// downloads for the current tab — otherwise old downloads from other tabs
// clutter the download list and cause confusion (opening the wrong file).

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "../../../src/background/background.js"),
  "utf8",
);

assert.match(
  backgroundSource,
  /\.filter\(\s*\(?\s*job\s*\)?\s*=>\s*(?:!\s*job\s*\.\s*tabId\s*\|\||job\s*\.\s*tabId\s*===\s*tabId\s*)/,
  "getTabDownloads must filter downloads to only show jobs matching the current tabId",
);

// ── Test: popup must filter downloadUpdated events by active tab ──────────
//
// The popup's background event handler must ignore download updates for
// other tabs to prevent the download list from being polluted by downloads
// initiated on other tabs/sites.

const popupBackgroundEventsSource = fs.readFileSync(
  path.join(__dirname, "../../../src/popup/popup_background_events.js"),
  "utf8",
);

assert.match(
  popupBackgroundEventsSource,
  /message\.job\.tabId\s*&&?\s*message\.job\.tabId\s*!==\s*(?:PopupState\.get\(["']activeTabId["']\)|state\.activeTabId)/,
  "popup_background_events must filter downloadUpdated events to only process jobs matching the active tab",
);

console.log("download tab filtering tests passed");
