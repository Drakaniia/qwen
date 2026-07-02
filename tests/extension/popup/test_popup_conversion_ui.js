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

// Test 1: CSS Animation exists
assert.match(css, /\.progress-bar\.indeterminate span/, "CSS must define indeterminate progress");
assert.match(css, /animation:\s*progress-loop/, "CSS must use progress-loop animation");
assert.match(css, /@keyframes\s+progress-loop/, "CSS must define progress-loop keyframes");

// Test 2: Button logic (Simulated render)
const js = fs.readFileSync(path.join(__dirname, "../../../src/popup/download_list.js"), "utf8");
assert.match(js, /isProcessingStage\(job\)/, "Logic must check for processing stage");
assert.match(js, /"Converting\.\.\."/, "Logic must show Converting... label");

console.log("Conversion UI tests passed");
