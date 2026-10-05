import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, dirname, join, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

/**
 * esbuild has no notion of Vite's `?inline` / `?raw` "read this file as a string"
 * suffix, so the content script's `import css from "...css?inline"` — the shadow
 * root's stylesheet — has to be resolved by hand. Vite already handles the same
 * specifier natively, which is what lets the overlay's tests run through vitest.
 */
function cssTextPlugin() {
  return {
    name: "css-text",
    setup(build) {
      build.onResolve({ filter: /\.css\?(raw|inline)$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?(raw|inline)$/, "")),
        namespace: "css-text",
      }));
      build.onLoad({ filter: /.*/, namespace: "css-text" }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))};`,
        loader: "js",
      }));
    },
  };
}

const targets = {
  content: {
    entryPoints: [resolve(rootDir, "src/content/content.ts")],
    // The overlay's Preact components are compiled here, not by Vite: a declared
    // content script cannot be an ES module (manifest `content_scripts` has no
    // `type` field), so it must stay a single IIFE and the popup's Vite build
    // must not be reachable from here. One esbuild pass inlines both.
    esbuildOptions: {
      jsx: "automatic",
      jsxImportSource: "preact",
      plugins: [cssTextPlugin()],
    },
  },
  background: {
    entryPoints: [resolve(rootDir, "src/background/background.ts")],
  },
};

/**
 * Copy native-host assets (bat, ps1) into the bundled output.
 */
function copyNativeHostAssets(outDir) {
  const srcNativeHost = resolve(rootDir, "src", "native_host");
  const outNativeHost = resolve(outDir, "src", "native_host");

  mkdirSync(outNativeHost, { recursive: true });

  const filesToCopy = ["qwin_video_host.bat", "register-host.ps1"];

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

  const manifestFiles = ["com.qwin.video_downloader.chrome.json", "com.qwin.video_downloader.yandex.json"];

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
      target: ["chrome148"],
      platform: "browser",
      logLevel: "info",
      ...config.esbuildOptions,
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
