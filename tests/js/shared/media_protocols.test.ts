import { describe, expect, it } from "vitest";

import { hasMediaContentType } from "../../../src/shared/media_protocols.js";

describe("hasMediaContentType", () => {
  it.each([
    ["video/mp4", true],
    ["video/webm", true],
    ["audio/mpeg", true],
    ["AUDIO/MPEG", true],
    ["application/x-mpegURL", true],
    ["application/vnd.apple.mpegURL", true],
    ["application/dash+xml", true],
    ["text/vtt", true],
    ["  video/mp4  ", true],
    ["video/mp4; charset=utf-8", true],
    ["application/json", false],
    ["text/html", false],
    ["text/plain", false],
    ["", false],
    [null, false],
    [undefined, false],
    [42, false],
  ])("hasMediaContentType(%j) === %j", (value, expected) => {
    expect(hasMediaContentType(value)).toBe(expected);
  });
});
