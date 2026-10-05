/**
 * Regression guard for the Tailwind content-detection base (see the `@source` comment at
 * the top of `src/ui/theme.css`).
 *
 * Tailwind v4 derives its automatic scan base from the Vite `root`, which
 * `vite.config.ts` sets to `src/popup`. Every Tailwind class used *only* by the design
 * system was therefore never emitted: `sr-only`, `size-2`, `size-16`, `rounded-full`,
 * `bg-current`, `gap-1.5`. Nothing about that fails loudly in review, because any
 * component using one of those alongside a `src/popup` class looks fine in isolation —
 * the class only fails once it is the *sole* user of it.
 *
 * The symptom that surfaced it was `StatusDot`'s `sr-only` label rendering as visible
 * red text in the popup header.
 *
 * This asserts the mechanism rather than the built CSS on purpose: `dist/` is generated
 * and gitignored, so a test that reads it would fail on a clean CI checkout. The
 * `@source` declaration is the only thing that can regress this, and removing it is what
 * this catches.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from `process.cwd()` rather than `import.meta.url`: vitest runs with the repo
// root as its cwd, whereas `import.meta.url` is not a `file:` URL under the happy-dom
// environment and `fileURLToPath` rejects it.
const THEME_CSS = readFileSync(resolve(process.cwd(), "src/ui/theme.css"), "utf8");

describe("theme.css Tailwind sources", () => {
  it("registers the whole of src/ as a Tailwind source", () => {
    // `../` is relative to src/ui/theme.css, i.e. all of src/ — ui, popup, shared,
    // background, content. Anything narrower re-breaks the next design-system folder.
    expect(THEME_CSS).toMatch(/@source\s+"\.\.\/"/);
  });

  it("keeps tailwindcss imported first, since @source must follow it", () => {
    const importAt = THEME_CSS.indexOf('@import "tailwindcss"');
    const sourceAt = THEME_CSS.indexOf('@source "../"');
    expect(importAt).toBeGreaterThanOrEqual(0);
    expect(sourceAt).toBeGreaterThan(importAt);
  });
});
