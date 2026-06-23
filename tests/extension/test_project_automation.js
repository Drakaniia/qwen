import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const root = path.join(__dirname, "../..");
const testScriptPath = path.join(root, "scripts/test.ps1");
const workflowPath = path.join(root, ".github/workflows/test.yml");
const projectDocs = fs.readFileSync(path.join(root, "docs/reference/project-structure.md"), "utf8");

const testScript = fs.readFileSync(testScriptPath, "utf8");
const workflow = fs.readFileSync(workflowPath, "utf8");

assert.match(testScript, /python -m unittest discover -s tests\\native-host -p test_\*\.py/);
assert.match(testScript, /Get-ChildItem[\s\S]+tests\\extension[\s\S]+node/);
assert.match(testScript, /build-extension\.ps1/);

assert.match(workflow, /windows-latest/);
assert.match(workflow, /actions\/setup-python/);
assert.match(workflow, /actions\/setup-node/);
assert.match(workflow, /scripts\/test\.ps1/);

assert.match(projectDocs, /scripts\\test\.ps1/);

console.log("project automation tests passed");
