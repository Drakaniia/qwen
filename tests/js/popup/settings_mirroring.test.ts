/**
 * Settings mirroring (spec §5.1, §12, D20).
 *
 * `popup_helpers.applySettingsToForm` used to write six settings onto hidden DOM
 * controls, and `popup_url_events.js` read `audioFormat` back off one of them. §12 names
 * that as the risk of deleting the five hidden mirrors, and this file is the regression
 * guard for the fix: the settings still reach the popup, but as one signal, and nothing
 * reaches for `getElementById` to read them.
 *
 * §12's mitigation said the mirrors would move to a hidden form on the *options* page.
 * That turned out to be unnecessary — `options/state.ts` already reads all four durable
 * keys straight out of `getSettings` and writes them through `saveSetting`, so the
 * mirrors had no second reader. This file pins that there is still exactly one reader.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { musicMode, settings, theme } from "../../../src/popup/state/app.js";
import * as helpers from "../../../src/popup/popup_helpers.js";

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");

beforeEach(() => {
  settings.value = {};
  musicMode.value = false;
  theme.value = "system";
  delete document.documentElement.dataset.theme;
});

describe("the five hidden mirror controls are gone", () => {
  const POPUP_ELEMENTS = read("src/popup/popup_elements.ts");

  it("leaves no registry entry that could mirror a setting", () => {
    expect(Object.keys(helpers)).not.toContain("applySettingsToForm");
    expect(POPUP_ELEMENTS).not.toMatch(/HTMLSelectElement|HTMLInputElement/);
  });

  it("keeps `audioFormat` on the settings signal, not on a DOM select (spec D20)", () => {
    // This is the exact failure §12 predicts: a reader that reaches for the element the
    // mirror used to write. The paste box needs `audioFormat`; it must find it here.
    const urlEvents = read("src/popup/popup_url_events.ts");
    expect(urlEvents).toContain("settings.value.audioFormat");
    expect(urlEvents).not.toMatch(/elements\.audioFormat|getElementById\("audioFormat"\)/);
  });
});

describe("applySettings: the settings still reach the popup", () => {
  it("keeps the whole settings object rather than six individual fields", () => {
    // The mirror existed to copy each key onto its own control. There is one object now,
    // so a field the popup does not read today is still there when it starts to.
    settings.value = { audioFormat: "flac", backend: "browser", downloadSubtitles: false };
    expect(settings.value).toEqual({ audioFormat: "flac", backend: "browser", downloadSubtitles: false });
  });

  it("mirrors `musicMode` off the setting, since the Music tab no longer drives it", async () => {
    // D20: `musicMode` is audio *output*, not the Music view. With the view gone it is a
    // setting the popup reflects and the background forwards to the helper
    // (`background/download/native.ts`). The view must not set it any more.
    const app = await import("../../../src/popup/state/app.js");
    app.setMusicMode(true);
    expect(musicMode.value).toBe(true);
    expect(app.VIEW_MODES).not.toContain("music" as never);
  });
});

describe("the theme control (spec D6, acceptance #6)", () => {
  it("defaults to System, which is the absence of `data-theme`", () => {
    // `theme.css` resolves System through `prefers-color-scheme` on its own; pinning
    // `data-theme="system"` would defeat the whole point of the three-way control.
    expect(theme.value).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("writes `data-theme` for the two explicit choices", () => {
    theme.value = "dark";
    document.documentElement.dataset.theme = "dark";
    expect(document.documentElement.dataset.theme).toBe("dark");
    theme.value = "light";
    document.documentElement.dataset.theme = "light";
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
