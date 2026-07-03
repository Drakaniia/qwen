import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const overlaySource = fs.readFileSync(path.join(__dirname, "../../../src/content/content_overlay.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "../../../src/content/content.js"), "utf8");

(async () => {
  // ─── Test: content_overlay exports hideAllOverlays ───────────────────────

  assert.match(
    overlaySource,
    /export\s+\{\s*[^}]*\bhideAllOverlays\b[^}]*\}/,
    "content_overlay.js must export hideAllOverlays to remove all video overlays at once",
  );

  // ─── Test: content_overlay exports setOverlayEnabled ────────────────────

  assert.match(
    overlaySource,
    /export\s+\{\s*[^}]*\bsetOverlayEnabled\b[^}]*\}/,
    "content_overlay.js must export setOverlayEnabled to control overlay visibility based on settings",
  );

  // ─── Test: setOverlayEnabled(enabled) function definition ────────────────

  assert.match(
    overlaySource,
    /function\s+setOverlayEnabled\s*\(\s*enabled\s*\)/,
    "content_overlay.js must define setOverlayEnabled(enabled) function",
  );

  // ─── Test: setOverlayEnabled calls positionAllOverlays when enabled ─────

  assert.match(
    overlaySource,
    /function\s+setOverlayEnabled[\s\S]*enabled\s*\)[\s\S]*positionAllOverlays\s*\(/,
    "setOverlayEnabled must call positionAllOverlays when enabling overlays",
  );

  // ─── Test: setOverlayEnabled calls hideAllOverlays when disabled ─────────

  assert.match(
    overlaySource,
    /function\s+setOverlayEnabled[\s\S]*hideAllOverlays\s*\(/,
    "setOverlayEnabled must call hideAllOverlays when disabling overlays",
  );

  // ─── Test: hideAllOverlays removes all overlay buttons ──────────────────

  assert.match(
    overlaySource,
    /function\s+hideAllOverlays\s*\(/,
    "content_overlay.js must define hideAllOverlays() function",
  );

  assert.match(
    overlaySource,
    /for\s*\(\s*(const|let|var)\s+record\s+of\s+Array\.from\s*\(\s*overlayRecords\s*\)\s*\)/,
    "hideAllOverlays must iterate over overlayRecords to remove each overlay",
  );

  // ─── Test: content.js handles setOverlayEnabled message ─────────────────

  assert.match(
    contentSource,
    /message\.type\s*===\s*["']setOverlayEnabled["']/,
    "content.js must listen for setOverlayEnabled runtime messages",
  );

  assert.match(
    contentSource,
    /setOverlayEnabled\s*\(\s*message\.enabled/,
    "content.js must call setOverlayEnabled with the message.enabled value",
  );

  console.log("content overlay toggle tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
