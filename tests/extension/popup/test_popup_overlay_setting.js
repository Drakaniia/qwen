import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const popupDir = path.join(__dirname, "../../../src/popup");
const html = fs.readFileSync(path.join(popupDir, "popup.html"), "utf8");
const elementsJs = fs.readFileSync(path.join(popupDir, "popup_elements.js"), "utf8");
const helpersJs = fs.readFileSync(path.join(popupDir, "popup_helpers.js"), "utf8");
const urlEventsJs = fs.readFileSync(path.join(popupDir, "popup_url_events.js"), "utf8");
const tabStateJs = fs.readFileSync(path.join(__dirname, "../../../src/background/tab_state.js"), "utf8");

(async () => {
  // ─── Test: tab_state.js defaults include overlayEnabled ─────────────────

  assert.match(tabStateJs, /overlayEnabled:\s*true/, "tab_state.js default settings must include overlayEnabled: true");

  // ─── Test: popup.html has the overlay toggle checkbox ───────────────────

  assert.match(html, /id="overlayToggle"/, "popup.html must include an overlayToggle checkbox in settings");

  assert.match(html, /Show download overlay on videos/, "overlay toggle checkbox must have a descriptive label");

  // ─── Test: popup_elements.js has the overlayToggle reference ────────────

  assert.match(
    elementsJs,
    /overlayToggle:\s*document\.getElementById\("overlayToggle"\)/,
    "popup_elements.js must reference the overlayToggle element",
  );

  // ─── Test: popup_helpers.js reads overlayEnabled from settings ──────────

  assert.match(
    helpersJs,
    /response\.settings\s*&&\s*response\.settings\.overlayEnabled/,
    "popup_helpers.js must read overlayEnabled from the settings response",
  );

  assert.match(
    helpersJs,
    /elements\.overlayToggle\.checked\s*=/,
    "popup_helpers.js must set overlayToggle.checked from the overlayEnabled setting",
  );

  // ─── Test: popup_url_events.js handles overlay toggle change ────────────

  assert.match(
    urlEventsJs,
    /elements\.overlayToggle\.addEventListener\("change"/,
    "popup_url_events.js must listen for overlayToggle change events",
  );

  assert.match(
    urlEventsJs,
    /saveSettings\(\{\s*overlayEnabled:\s*(enabled|elements\.overlayToggle\.checked)\s*\}/,
    "overlay toggle must save the overlayEnabled setting when changed",
  );

  assert.match(
    urlEventsJs,
    /type:\s*"setOverlayEnabled"/,
    "overlay toggle must send setOverlayEnabled message to the content script",
  );

  console.log("popup overlay setting tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
