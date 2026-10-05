import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const input = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// Plain Vite, no extension plugin (spec §3.2): the content script and service worker
// stay esbuild/IIFE and `dist/` stays owned by scripts/build-extension.ps1.
export default defineConfig({
  root: "src/popup",
  // Asset URLs must be relative so they resolve under chrome-extension://.
  base: "./",
  plugins: [preact(), tailwindcss()],
  // Vite 8 transforms with oxc, not esbuild — the `esbuild` option is ignored there.
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: {
    outDir: "../../dist/bundled/src/popup",
    emptyOutDir: false,
    // One merged stylesheet: popup.html links `popup.css` by hand and nothing links the
    // JS entry's CSS, so a per-entry split file would never reach the page.
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        popup: input("src/popup/popup.html"),
        main: input("src/popup/main.tsx"),
        downloads: input("src/popup/downloads.html"),
        options: input("src/popup/options.html"),
      },
      output: { entryFileNames: "[name].js" },
    },
  },
});
