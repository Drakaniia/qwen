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

/**
 * The indeterminate sheen needs a `prefers-reduced-motion` override that parks the segment
 * mid-track, because the blanket `animation-duration: 1ms !important` would otherwise snap
 * it to its end keyframe — off the track, so the bar renders *empty* and reads as 0%.
 *
 * That override only works because of source order: media queries add no specificity, so
 * the two `.sheen-indeterminate` rules are equal-weight and the later one wins. Declared
 * after the media query, `animation: none` loses to `animation: … infinite` and the
 * "fix" silently stops existing — a broken bar that only shows up under the OS reduced-motion
 * setting, which is exactly the kind of regression no build or type check catches.
 */
describe("theme.css indeterminate sheen ordering", () => {
  const baseAt = THEME_CSS.indexOf(".sheen-indeterminate {");
  const overrideAt = THEME_CSS.indexOf(".sheen-indeterminate {", baseAt + 1);

  it("declares both the sheen and its reduced-motion override", () => {
    expect(THEME_CSS).toMatch(/@keyframes\s+qwin-sheen/);
    expect(baseAt).toBeGreaterThanOrEqual(0);
    expect(overrideAt).toBeGreaterThan(baseAt);
  });

  it("declares the animated sheen BEFORE the reduced-motion override that cancels it", () => {
    // Sanity: the two matches above are the base rule and the override, not the same one.
    expect(overrideAt).not.toBe(baseAt);
    // The override must sit inside the reduced-motion media query, not be a bare
    // declaration that would then also apply at full motion.
    const mediaAt = THEME_CSS.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(mediaAt).toBeGreaterThanOrEqual(0);
    expect(mediaAt).toBeLessThan(overrideAt);
    // Bounded rather than a fixed slice width: the declaration sits below the comment
    // that explains why it exists, and that comment is the thing most likely to be edited.
    const noneAt = THEME_CSS.indexOf("animation: none", overrideAt);
    expect(noneAt).toBeGreaterThan(overrideAt);
    expect(noneAt - overrideAt).toBeLessThan(600);
  });
});
