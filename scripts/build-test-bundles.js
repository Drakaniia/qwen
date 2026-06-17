import esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const outDir = resolve(rootDir, "dist/test");

const entries = [
  { in: resolve(rootDir, "src/content/content.js"), out: "content" },
  { in: resolve(rootDir, "src/background/background.js"), out: "background" },
  { in: resolve(rootDir, "src/popup/popup.js"), out: "popup" },
];

async function build() {
  for (const entry of entries) {
    await esbuild.build({
      entryPoints: [entry.in],
      bundle: true,
      format: "iife",
      outfile: resolve(outDir, `${entry.out}.bundle.js`),
      target: ["chrome120", "firefox121"],
      platform: "browser",
      logLevel: "info",
    });
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
