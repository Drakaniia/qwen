import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const targets = {
  content: {
    entryPoints: [resolve(rootDir, "src/content/content.js")],
  },
  background: {
    entryPoints: [resolve(rootDir, "src/background/background.js")],
  },
  popup: {
    entryPoints: [resolve(rootDir, "src/popup/popup.js")],
  },
};

/**
 * Copy native-host assets (bat, ps1) into the bundled output.
 */
function copyNativeHostAssets(outDir) {
  const srcNativeHost = resolve(rootDir, "src", "native-host");
  const outNativeHost = resolve(outDir, "src", "native-host");

  mkdirSync(outNativeHost, { recursive: true });

  const filesToCopy = [
    "qwin_video_host.bat",
    "register-host.ps1",
  ];

  for (const file of filesToCopy) {
    const src = resolve(srcNativeHost, file);
    const dest = resolve(outNativeHost, file);
    try {
      copyFileSync(src, dest);
      console.log(`  Copied native-host asset: ${file}`);
    } catch (err) {
      console.warn(`  Warning: Could not copy ${file}: ${err.message}`);
    }
  }
}

/**
 * Copy config/native-host manifest JSON files into the bundled output.
 */
function copyConfigAssets(outDir) {
  const configNativeHost = resolve(rootDir, "config", "native-host");
  const outNativeHost = resolve(outDir, "native-host");

  mkdirSync(outNativeHost, { recursive: true });

  const manifestFiles = [
    "com.qwin.video_downloader.chrome.json",
    "com.qwin.video_downloader.firefox.json",
    "com.qwin.video_downloader.yandex.json",
  ];

  for (const file of manifestFiles) {
    const src = resolve(configNativeHost, file);
    const dest = resolve(outNativeHost, file);
    try {
      copyFileSync(src, dest);
      console.log(`  Copied config asset: ${file}`);
    } catch (err) {
      console.warn(`  Warning: Could not copy ${file}: ${err.message}`);
    }
  }
}

async function build(targetNames, outDir) {
  if (!outDir) {
    outDir = resolve(rootDir, "dist/bundled");
  }

  for (const target of targetNames) {
    const config = targets[target];
    if (!config) {
      console.error(`Unknown target: ${target}`);
      process.exit(1);
    }

    await esbuild.build({
      entryPoints: config.entryPoints,
      bundle: true,
      format: "iife",
      outbase: resolve(rootDir, "src"),
      outdir: resolve(outDir, "src"),
      entryNames: "[dir]/[name].bundle",
      target: ["chrome120", "firefox121"],
      platform: "browser",
      logLevel: "info",
    });
  }

  // Copy native host and config assets
  copyNativeHostAssets(outDir);
  copyConfigAssets(outDir);
}

// Parse CLI args
const args = process.argv.slice(2);
const targetFlagIndex = args.indexOf("--target");
const outdirFlagIndex = args.indexOf("--outdir");

let targetNames;
if (targetFlagIndex >= 0 && args[targetFlagIndex + 1]) {
  const value = args[targetFlagIndex + 1];
  targetNames = value === "all" ? Object.keys(targets) : [value];
} else {
  targetNames = Object.keys(targets);
}

const outDir = outdirFlagIndex >= 0 ? args[outdirFlagIndex + 1] : undefined;

build(targetNames, outDir).catch((error) => {
  console.error(error);
  process.exit(1);
});
