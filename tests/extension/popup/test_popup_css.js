import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const popupDir = path.join(__dirname, "../../../src/popup");
const css = [
  fs.readFileSync(path.join(popupDir, "popup-base.css"), "utf8"),
  fs.readFileSync(path.join(popupDir, "popup-components.css"), "utf8"),
  fs.readFileSync(path.join(popupDir, "popup-theme.css"), "utf8"),
].join("\n");

assert.match(
  css,
  /\.quality-dialog\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s,
  "quality dialog hidden state must override .quality-dialog display:grid",
);

assert.match(
  css,
  /\.video-list\[hidden\][\s\S]*\.download-list\[hidden\][\s\S]*display:\s*none\s*!important\s*;/,
  "videos and downloads tab panels must stay hidden when their hidden attribute is set",
);

assert.match(
  css,
  /\.video-toolbar\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s,
  "video layout toolbar must stay hidden when the downloads tab is active",
);

assert.match(
  css,
  /\.view-toggle\[hidden\][\s\S]*#contentView\[hidden\][\s\S]*#footerActions\[hidden\][\s\S]*display:\s*none\s*!important\s*;/,
  "settings-only mode must hide the non-settings popup UI",
);

assert.match(css, /\.layout-toggle/, "popup must style the list and boxes toggle");

assert.match(
  css,
  /\.video-list\.boxes\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  "box layout must render videos as a two-column card grid",
);

assert.match(
  css,
  /\.video-list\.boxes\s+\.video-preview\s*\{[^}]*display:\s*grid/s,
  "box layout must reveal the thumbnail preview area",
);

assert.match(
  css,
  /\.video-thumbnail\s*\{[^}]*object-fit:\s*cover/s,
  "thumbnail images must fill the box card preview without layout distortion",
);

console.log("popup css tests passed");
