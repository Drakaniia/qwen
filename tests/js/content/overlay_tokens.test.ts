/**
 * Spec §9 — the overlay stylesheet is refactored onto the shared token system.
 *
 * The mechanism that makes this possible (a stylesheet installed inside the shadow
 * root rather than in the manifest's `content_scripts[].css`) is what makes it
 * fragile: because `src/ui/theme.css` cannot be imported — its
 * `@import "tailwindcss"` would drag preflight into the shadow tree — the token
 * *values* are copied. Copying is only safe if the copy is checked, so these tests
 * read both files off disk and compare them rather than restating a value list that
 * would itself drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * Read off disk rather than through the `?inline` import `content_overlay.ts` uses:
 * vitest resolves that specifier to an empty string (there is no CSS plugin in
 * `vitest.config.ts`, which is why the overlay test only ever asserts on the DOM).
 */
const OVERLAY_CSS = readRepoFile("../../../src/shared/qwin_overlay.css");
const THEME_CSS = readRepoFile("../../../src/ui/theme.css");

/**
 * Comments explain *why* several of these declarations exist by naming the thing they
 * replace, so the assertions below run against declarations only.
 */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every hex literal in a stylesheet, lowercased. */
function hexes(css: string): string[] {
  return (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((hex) => hex.toLowerCase());
}

describe("overlay stylesheet draws only on theme.css tokens", () => {
  it("uses no hex value that theme.css does not define", () => {
    const allowed = new Set(hexes(THEME_CSS));

    // Both schemes must contribute tokens, or a light-only overlay on a dark OS is
    // the failure this whole refactor exists to prevent.
    expect(allowed.size).toBeGreaterThan(10);

    expect(hexes(declarations(OVERLAY_CSS)).filter((hex) => !allowed.has(hex))).toEqual([]);
  });

  it("declares a dark palette as well as a light one", () => {
    expect(declarations(OVERLAY_CSS)).toContain(':host([data-theme="dark"])');
    // `system` is represented by NOT pinning the attribute, exactly as in theme.css.
    expect(declarations(OVERLAY_CSS)).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:host\(:not\(\[data-theme="light"\]\)\)/,
    );
  });

  it("keeps the theme.css type and radius steps rather than inventing values", () => {
    for (const token of ["--text-title", "--text-row", "--text-caption", "--radius-row", "--radius-dialog"]) {
      expect(declarations(OVERLAY_CSS)).toContain(`${token}: `);
    }
    // 13px row title / 11px caption, not the 14px/700 and 10px/800 the old file used.
    expect(declarations(OVERLAY_CSS)).not.toContain("font-weight: 750");
    expect(declarations(OVERLAY_CSS)).not.toContain("font-weight: 800");
  });

  it("carries no emoji", () => {
    // §1.5 / §4.4: emoji are platform-dependent and do not align to the 4px grid.
    expect(declarations(OVERLAY_CSS)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("overlay stylesheet stays inside the shadow root", () => {
  it("keeps `all: initial` on :host", () => {
    // Shadow-scoping loses to an aggressive `* { ... }` in the host page, so this is
    // best-effort defence only. Switching to `!important` would mean shipping a
    // stylesheet into the host page — the exact thing the shadow root prevents.
    expect(declarations(OVERLAY_CSS)).toMatch(/:host \{[^}]*all: initial;/);
  });

  it("uses !important only in the reduced-motion clamp", () => {
    // `theme.css` puts exactly two, both in the one block that must win.
    expect((declarations(OVERLAY_CSS).match(/!important/g) || []).length).toBe(2);
  });

  it("never imports tailwindcss into the shadow tree", () => {
    expect(declarations(OVERLAY_CSS)).not.toContain("@import");
  });
});

describe("overlay motion and accessibility media queries (spec §4.5, §4.6)", () => {
  it("gives the floating button the press scale and a hover lift", () => {
    expect(declarations(OVERLAY_CSS)).toContain("transform: translateY(0) scale(0.97)");
    expect(declarations(OVERLAY_CSS)).toContain("transition: transform 100ms ease-out");
    expect(declarations(OVERLAY_CSS)).toMatch(/@media \(hover: hover\) \{\s*\.qwin-overlay-btn:hover/);
  });

  it("honours all four a11y/material queries", () => {
    expect(declarations(OVERLAY_CSS)).toContain("@media (prefers-reduced-motion: reduce)");
    expect(declarations(OVERLAY_CSS)).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(declarations(OVERLAY_CSS)).toContain("@media (prefers-contrast: more)");
    expect(declarations(OVERLAY_CSS)).toContain("@supports not (backdrop-filter: blur(1px))");
  });

  it("uses Sheet weight, not the popup's Chrome", () => {
    // blur 32 + the sheet drop shadow — §9: it floats over arbitrary host pages.
    expect(declarations(OVERLAY_CSS)).toContain("--material-sheet-blur: 32px");
    expect(declarations(OVERLAY_CSS)).toContain("--material-sheet-shadow: 0 24px 48px rgba(0, 0, 0, 0.18)");
    expect(declarations(OVERLAY_CSS)).not.toContain("--material-chrome-blur");
  });
});
