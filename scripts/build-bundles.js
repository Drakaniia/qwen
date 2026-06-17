import esbuild from "esbuild";
import { resolve, dirname } from "path";
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
