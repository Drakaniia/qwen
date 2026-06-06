const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../../scripts/install-stream-fallbacks.ps1"), "utf8");

assert.match(
  script,
  /assetArch/,
  "stream fallback installer must choose a release asset for the current CPU architecture"
);

assert.match(
  script,
  /win-x64/,
  "stream fallback installer must explicitly support the Windows x64 asset"
);

assert.match(
  script,
  /win-arm64/,
  "stream fallback installer must explicitly support the Windows ARM64 asset"
);

assert.doesNotMatch(
  script,
  /win\.\*64/,
  "stream fallback installer must not use a broad win.*64 pattern that can select ARM64 on x64 Windows"
);

assert.match(
  script,
  /Remove-Item[\s\S]+N_m3u8DL-RE\.exe/,
  "stream fallback installer must remove an invalid existing N_m3u8DL-RE executable before reinstalling"
);

assert.match(
  script,
  /System\.Diagnostics\.ProcessStartInfo[\s\S]+ExitCode/,
  "stream fallback installer must validate N_m3u8DL-RE with the process exit code instead of stale LASTEXITCODE"
);

console.log("stream fallback installer tests passed");
