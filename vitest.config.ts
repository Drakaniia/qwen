import { defineConfig } from "vitest/config";

// Read independently of vite.config.ts (which owns the Preact popup build).
export default defineConfig({
  // Vite 8 transforms with oxc, not esbuild — the `esbuild` option is ignored there.
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/js/**/*.test.{js,ts,tsx}"],
  },
});
