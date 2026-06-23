import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const root = path.join(__dirname, "../..");
const installScript = fs.readFileSync(path.join(root, "scripts/install.bat"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const installationDocs = fs.readFileSync(path.join(root, "docs/guides/installation.md"), "utf8");
const projectDocs = fs.readFileSync(path.join(root, "docs/reference/project-structure.md"), "utf8");
const troubleshootingDocs = fs.readFileSync(path.join(root, "docs/guides/troubleshooting.md"), "utf8");
const yandexManifestPath = path.join(root, "config/native-host/com.qwin.video_downloader.yandex.json");

assert.match(
  installScript,
  /set "YANDEX_MANIFEST=%NATIVE_DIR%\\%HOST_NAME%\.yandex\.json"/,
  "installer must define a Yandex Browser native messaging manifest path",
);

assert.match(
  installScript,
  /\$yandexPath = \$env:YANDEX_MANIFEST/,
  "installer must pass the Yandex manifest path into manifest generation",
);

assert.match(
  installScript,
  /\[System\.IO\.File\]::WriteAllText\(\$yandexPath,/,
  "installer must write the Yandex Browser native messaging manifest",
);

assert.match(
  installScript,
  /reg add "HKCU\\Software\\Chromium\\NativeMessagingHosts\\%HOST_NAME%"/,
  "installer must register the host in the Chromium native messaging registry key used by Yandex Browser",
);

assert.match(
  installScript,
  /Native helper installed for Chrome, Firefox, and Yandex Browser/,
  "installer output must tell users Yandex Browser is configured",
);

assert.ok(
  fs.existsSync(yandexManifestPath),
  "repo must include the generated Yandex Browser native messaging manifest",
);

const yandexManifest = JSON.parse(fs.readFileSync(yandexManifestPath, "utf8"));
assert.equal(yandexManifest.name, "com.qwin.video_downloader");
assert.equal(yandexManifest.type, "stdio");
assert.deepEqual(yandexManifest.allowed_origins, ["chrome-extension://dbjddokdmkodnkiaccmbjagfalmmmkmi/"]);

assert.match(readme, /Chrome, Firefox, and Yandex Browser/);
assert.match(readme, /Yandex Browser: open `browser:\/\/extensions`/);

assert.match(installationDocs, /Load In Yandex Browser/);
assert.match(installationDocs, /HKCU\\Software\\Chromium\\NativeMessagingHosts\\com\.qwin\.video_downloader/);

assert.match(projectDocs, /Generated Chrome, Yandex Browser, and Firefox native messaging manifest files/);
assert.match(troubleshootingDocs, /If Yandex Browser is used/);

console.log("Yandex Browser support tests passed");
