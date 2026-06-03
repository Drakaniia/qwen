const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../../src/popup/popup.css"), "utf8");

assert.match(
  css,
  /\.quality-dialog\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s,
  "quality dialog hidden state must override .quality-dialog display:grid"
);

console.log("popup css tests passed");
