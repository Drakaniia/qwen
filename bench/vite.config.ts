import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The Media-list benchmark's dev server. Deliberately a SECOND config.
 *
 * `vite.config.ts` owns `src/popup` and its four inputs, and `vitest.config.ts` includes
 * `tests/js/**`, so neither the extension build nor the test run can see this directory.
 * Nothing about the shipped extension changes when the benchmark changes shape.
 *
 * Run it from the repo root:
 *
 *   npx vite --config bench/vite.config.ts
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [preact(), tailwindcss()],
  // Vite 8 transforms with oxc, not esbuild — same setting as the extension build.
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  // Pinned and strict so a stale process on the port fails loudly instead of silently
  // serving another thread's page.
  server: { port: 5199, strictPort: true },
  // `vite preview` serves the built output on its own port. The build is the one that
  // matters: the dev graph carries HMR, devtools and unminified code, so a number taken
  // from it overstates the shipped popup.
  preview: { port: 5200, strictPort: true },
});
