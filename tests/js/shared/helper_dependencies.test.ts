/**
 * The one distinction that separates "the helper says this tool is absent" from "we have
 * no data yet" (native-helper-status-spec.md §2.2).
 *
 * `isMissing` is *not* fixed by the tri-state work — it keeps `!== true` because the
 * popup's already-correct banner gate is built on it. So the `{}`-reads-as-missing
 * behaviour is pinned here on purpose: it is a contract both UIs depend on, not an
 * accident to assert away.
 */
import { describe, expect, it } from "vitest";

import { HELPER_DEPENDENCIES, isMissing, isUnknown } from "../../../src/shared/helper_dependencies.js";

describe("isMissing", () => {
  it("still reads every key of an empty dependency record as missing", () => {
    for (const dep of HELPER_DEPENDENCIES) {
      expect(isMissing({}, dep.key)).toBe(true);
    }
  });

  it("is true for anything the host did not report as a literal true", () => {
    expect(isMissing({ ytDlp: false }, "ytDlp")).toBe(true);
    expect(isMissing({ ytDlp: "yes" }, "ytDlp")).toBe(true);
    expect(isMissing({ ytDlp: 1 }, "ytDlp")).toBe(true);
  });

  it("is false only for true", () => {
    expect(isMissing({ ytDlp: true }, "ytDlp")).toBe(false);
    expect(isMissing({ ytDlp: true, ffmpeg: false }, "ffmpeg")).toBe(true);
  });
});

describe("isUnknown", () => {
  it("is true only for null, the value that has no probe behind it", () => {
    expect(isUnknown({ connected: null })).toBe(true);
  });

  it("is false for both checked states, so a real failure still reads as a failure", () => {
    expect(isUnknown({ connected: false })).toBe(false);
    expect(isUnknown({ connected: true })).toBe(false);
  });
});
