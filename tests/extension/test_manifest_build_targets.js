import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const root = path.join(__dirname, "../..");
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const chromiumManifest = JSON.parse(
  fs.readFileSync(path.join(root, "config/extension/manifest.chromium.json"), "utf8"),
);
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, "config/extension/manifest.firefox.json"), "utf8"));
const buildScript = fs.readFileSync(path.join(root, "scripts/build-extension.ps1"), "utf8");
const installScript = fs.readFileSync(path.join(root, "scripts/install.sh"), "utf8");

assert.deepEqual(rootManifest, chromiumManifest, "root manifest should match the Chromium/Yandex development manifest");

assert.equal(
  typeof chromiumManifest.background.service_worker,
  "string",
  "Chromium MV3 manifest must use a single service_worker string",
);
assert.equal(
  Object.hasOwn(chromiumManifest.background, "scripts"),
  false,
  "Chromium MV3 manifest must not include background.scripts",
);

assert.ok(Array.isArray(firefoxManifest.background.scripts), "Firefox MV3 manifest should use background.scripts");
assert.equal(
  Object.hasOwn(firefoxManifest.background, "service_worker"),
  false,
  "Firefox manifest target must not mix service_worker with background.scripts",
);

assert.match(
  buildScript,
  /Copy-Item[\s\S]+src[\s\S]+Destination/,
  "build script must copy extension source into browser-specific dist folders",
);
assert.match(buildScript, /manifest\.chromium\.json/, "build script must use the Chromium manifest template");
assert.match(buildScript, /manifest\.firefox\.json/, "build script must use the Firefox manifest template");
assert.match(
  installScript,
  /build_extension|Build browser|Built.*extension/,
  "installer must build browser-specific extension folders after dependency setup",
);

assert.match(
  installScript,
  /install_stream_fallbacks|Stream fallback/,
  "installer must install or check stream fallback tools after aria2 setup",
);
assert.match(
  installScript,
  /yt-dlp\[default,curl-cffi\]/,
  "installer must install yt-dlp with curl-cffi impersonation support",
);

console.log("manifest build target tests passed");
