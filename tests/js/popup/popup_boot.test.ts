/**
 * Boot smoke test for the shell and the imperative half of the popup (spec D18).
 *
 * `popup_helpers.ts`, `popup_background_events.ts` and `popup_url_events.ts` are the
 * modules no component test imports, so without this file nothing would notice a typo in
 * them, an id `popup_elements.ts` looks up but `popup.html` no longer declares, a view
 * toggle that stopped being wired, or a `saveSettings` patch that lost a field.
 *
 * **This file was rewritten, not deleted** (spec §1.1, §12, D18). It used to assert 34
 * ids against `popup.html` and read `src/popup/popup_elements.js` — a path the
 * `.js`→`.ts` migration had already renamed, so it had been failing to resolve. The
 * assertion it exists for is unchanged and still the point: an id the registry looks up
 * that the page does not declare.
 *
 * ## Why it reads the source rather than rendering
 *
 * The registry is captured at import time, so the fixture has to be in the document
 * first. Reading both files keeps the two halves in one place and lets the test also
 * assert the *absence* of things — which is the half of the old contract that mattered,
 * because a hidden mirror control is exactly the defect §1.1 is about and an id that
 * merely exists in the registry would not catch it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Read from the repo root, which is where `npm test` runs from. */
const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");

const POPUP_HTML = read("src/popup/popup.html");
const POPUP_ELEMENTS = read("src/popup/popup_elements.ts");

// The <script> tag is stripped: happy-dom would try to fetch it, and the entry point is
// imported below instead.
document.body.innerHTML = POPUP_HTML.replace(/<script[\s\S]*?<\/script>/gi, "");

const { elements } = await import("../../../src/popup/popup_elements.js");
const { init } = await import("../../../src/popup/popup_helpers.js");
// `popup_events.js` is gone with the chrome it wired (spec §5.1); `popup.js` now imports
// the background-broadcast listener directly, and importing it here is what proves that
// side-effect module still resolves.
const loadPopup = () => import("../../../src/popup/popup.js");

const declaredIds = (html: string) => [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

describe("popup.html is a shell (spec §5.1, acceptance #2)", () => {
  it("declares exactly the three mount roots and nothing else", () => {
    expect(declaredIds(POPUP_HTML)).toEqual(["popupApp", "selectionBar", "qualityDialog"]);
  });

  it("carries no form controls at all", () => {
    // Acceptance #2: "popup.html is a shell with three mount roots and no form
    // controls." One regex over every control the old markup had.
    expect(POPUP_HTML).not.toMatch(/<(input|select|textarea|button)\b/i);
  });

  it("carries no ids the registry does not look up", () => {
    // The direction the old test never checked, and the one that catches a component
    // that kept an id nobody reads — the §1.1 defect in its other form.
    const looked = declaredIds(POPUP_HTML).filter((id) => !POPUP_ELEMENTS.includes(`"${id}"`));
    expect(looked).toEqual([]);
  });

  it("does not ship the five hidden mirror controls (spec §5.1, §12)", () => {
    for (const id of ["audioFormat", "overlayToggle", "syncHistoryToggle", "downloadFolder", "saveSettings"]) {
      expect(POPUP_HTML, `${id} is still declared`).not.toContain(`id="${id}"`);
      expect(POPUP_ELEMENTS, `${id} is still looked up`).not.toContain(`"${id}"`);
    }
  });

  it("does not ship the merged-away link boxes (spec D20)", () => {
    for (const id of ["manualUrl", "musicLinkUrl", "musicLinkSection"]) {
      expect(POPUP_HTML, `${id} is still declared`).not.toContain(`id="${id}"`);
    }
  });

  it("does not ship the Music tab or the list/boxes toggle (spec D7, D12)", () => {
    for (const id of ["showMusic", "viewToggle", "showListLayout", "showBoxLayout", "videoToolbar"]) {
      expect(POPUP_HTML, `${id} is still declared`).not.toContain(`id="${id}"`);
    }
  });

  it("leaves the width and the background to `useResize` and D10", () => {
    // 390 was below the 400px floor and `useResize` owns sizing; D10 wants the popup
    // transparent so the chrome's blur reads as depth against the desktop.
    expect(POPUP_HTML).not.toMatch(/w-\[/);
    expect(POPUP_HTML).not.toMatch(/<body[^>]*\bbg-/);
  });

  it("has no emoji (acceptance #3, spec §4.4)", () => {
    // The old markup carried ⚠️, ▶ and 📋 — spec §1.5. `Icon.tsx` replaced all three.
    expect(POPUP_HTML).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("does not link a stylesheet the theme system does not own", () => {
    // `popup.css` and its four `@import`s are gone (spec §5.2: all five files in
    // `src/popup/styles/` are deleted). `main.tsx` imports `theme.css` itself, exactly as
    // `downloads.html` and `options.html` already did.
    expect(POPUP_HTML).not.toMatch(/<link[^>]+stylesheet/i);
  });
});

describe("the registry resolves (spec §5.1)", () => {
  it("declares every id the elements registry looks up", () => {
    const declared = new Set(declaredIds(POPUP_HTML));
    const looked = [...POPUP_ELEMENTS.matchAll(/document\.getElementById\("([^"]+)"\)/g)].map((match) => match[1]);

    expect(looked.length).toBe(3);
    expect(looked.filter((id) => !declared.has(id))).toEqual([]);
    expect(Object.keys(elements)).toHaveLength(looked.length);
  });

  it("wires every registry entry to a real element", () => {
    for (const [id, node] of Object.entries(elements)) {
      expect(node, `${id} resolved to null`).not.toBeNull();
    }
  });
});

describe("boot", () => {
  it("registers every listener without throwing", async () => {
    await expect(loadPopup()).resolves.toBeDefined();
  });

  it("starts on the Media view with the Downloads view off", async () => {
    await init();
    const { viewMode } = await import("../../../src/popup/state/app.js");
    expect(viewMode.value).toBe("media");
  });

  it("rejects a view mode the two-segment switch cannot show", async () => {
    const { setViewMode } = await import("../../../src/popup/state/app.js");
    // "music" was a real ViewMode before D7; it must now fall back rather than silently
    // putting the popup in a view no segment can bring back.
    expect(setViewMode("music")).toBe("media");
    expect(setViewMode("downloads")).toBe("downloads");
    setViewMode("media");
  });
});
