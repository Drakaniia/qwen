/**
 * Canonical-behaviour pins for the consolidated display formatters.
 *
 * This file replaces the `DIVERGENCE` describe block in
 * `tests/js/popup/popup_ui.test.js` (lines 133-177). That block asserted that
 * `popup_ui.shortenUrl` and `video_picker.shortenUrl` produce *different* output —
 * true only while both copies exist. Its content is kept here, inverted: instead of
 * pinning the fork, this pins the winner and records the behaviour that was dropped.
 *
 * Dropped, and why:
 *   1. `video_picker.js` cut the path at 28 chars with a single `…`, discarding the
 *      query string entirely. That loses the file extension — which is the thing a
 *      user picks a download by — and loses the "does this URL carry parameters?"
 *      signal, which distinguishes a plain file from a signed/stream URL.
 *   2. `video_picker.js` fell back to the literal `"Video"` for audio jobs, labelling
 *      every music download "Video". That is a defect, not a variant.
 *   3. The `video_picker.js` wrappers took `videoFilters` as an *optional* second
 *      argument and degraded to a thinner in-module fallback when it was absent.
 *      `video_filters.js` is the only layer with the real logic, so the canonical
 *      functions call it unconditionally and the optionality is gone.
 */
import { describe, expect, it } from "vitest";

import {
  displayFormat,
  formatDownloadPercent,
  normalizeManualUrl,
  shortenUrl,
  sourceLabel,
  videoSizeLabel,
  videoThumbnailUrl,
  videoTitle,
} from "../../../src/ui/format.js";

/** hostname + pathname is 96 chars, so the canonical middle-cut path is 34 + "..." + 30. */
const LONG_PATH = `https://example.com/${"a".repeat(80)}.mp4`;

describe("shortenUrl (canonical)", () => {
  it.each([
    ["https://example.com/a/b", "example.com/a/b"],
    ["https://example.com/a?x=1", "example.com/a?..."],
    ["https://example.com/a?x=1&y=2", "example.com/a?..."],
    ["https://example.com", "example.com/"],
    ["https://example.com/a#frag", "example.com/a"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("shortenUrl(%j) === %j", (url, expected) => {
    expect(shortenUrl(url)).toBe(expected);
  });

  it("cuts a long url from the middle, keeping both ends and the extension", () => {
    const result = shortenUrl(LONG_PATH);
    expect(result).toHaveLength(34 + 3 + 30);
    expect(result).toBe(`example.com/${"a".repeat(22)}` + "..." + `${"a".repeat(26)}.mp4`);
    expect(result.endsWith(".mp4")).toBe(true);
  });

  it("keeps the file extension on a long path — the behaviour the picker's copy lost", () => {
    // The dropped `video_picker` cut was `example.com/aaaa…` — 28 chars of path, no
    // extension, no query marker.
    const dropped = `example.com/${"a".repeat(27)}…`;
    expect(shortenUrl(LONG_PATH)).not.toBe(dropped);
    expect(shortenUrl(LONG_PATH)).toContain("...");
  });

  it("marks query presence after the cut", () => {
    expect(shortenUrl(`${LONG_PATH}?token=1`)).toBe(shortenUrl(LONG_PATH) + "?...");
  });

  it("falls back to a 95-char slice for unparseable input", () => {
    expect(shortenUrl("not a url")).toBe("not a url");
    expect(shortenUrl("x".repeat(200))).toBe("x".repeat(95));
  });
});

describe("videoTitle (canonical)", () => {
  it.each([
    [{ title: "Real Title" }, "Real Title"],
    [{ title: "", url: "https://e.com/a" }, "e.com/a"],
    [{ url: "https://e.com/a", format: "AUDIO" }, "e.com/a"],
    [{ format: "AUDIO" }, "Music"],
    [{ format: "audio" }, "Music"],
    [{}, "Video"],
    // A whitespace-only title is truthy, so it wins over the format fallback.
    [{ title: "  ", format: "AUDIO" }, "  "],
    [{ title: "日本語のタイトル" }, "日本語のタイトル"],
  ])("videoTitle(%j) === %j", (video, expected) => {
    expect(videoTitle(video)).toBe(expected);
  });

  it("labels an audio job 'Music' — the picker's literal 'Video' was dropped", () => {
    expect(videoTitle({ format: "AUDIO" })).toBe("Music");
    expect(videoTitle({ format: "AUDIO" })).not.toBe("Video");
  });

  it.each([null, undefined])("tolerates a missing video object (%j)", (video) => {
    expect(videoTitle(video)).toBe("Video");
  });

  it("truncates a long untitled url through shortenUrl, not a shorter budget", () => {
    expect(videoTitle({ url: LONG_PATH })).toBe(shortenUrl(LONG_PATH));
  });
});

describe("displayFormat / sourceLabel / videoSizeLabel (canonical, straight onto video_filters)", () => {
  it.each([
    [{ format: "m3u8" }, "MP4"],
    [{ format: "audio" }, "AUDIO"],
    [{ format: "webm" }, "WEBM"],
    [{}, "VIDEO"],
  ])("displayFormat(%j) === %j", (video, expected) => {
    expect(displayFormat(video)).toBe(expected);
  });

  it.each([
    [{ source: "manual-url" }, "manual link"],
    [{ source: "music-page" }, "music"],
    [{ format: "M3U8", source: "dom-video" }, "full video"],
    [{ source: "dom-video" }, "dom-video"],
    [{}, "detected"],
  ])("sourceLabel(%j) === %j", (video, expected) => {
    expect(sourceLabel(video)).toBe(expected);
  });

  it.each([
    [{ size: "  5 MB  " }, "5 MB"],
    [{ sizeBytes: 2048 }, "2.0 KB"],
    [{}, ""],
  ])("videoSizeLabel(%j) === %j", (video, expected) => {
    expect(videoSizeLabel(video)).toBe(expected);
  });

  it("has no optional videoFilters argument — the thin fallbacks are gone", () => {
    // Previously `Picker.displayFormat(video, null)` returned the raw format
    // ("m3u8"); the canonical form has one behaviour with no second mode.
    expect(displayFormat({ format: "m3u8" })).toBe("MP4");
    expect(videoSizeLabel({ sizeBytes: 2048 })).toBe("2.0 KB");
  });

  it("sourceLabel checks source before format", () => {
    expect(sourceLabel({ format: "M3U8", source: "manual-url" })).toBe("manual link");
  });
});

describe("videoThumbnailUrl", () => {
  it.each([
    [{ thumbnailUrl: "https://cdn.example/a.png" }, "https://cdn.example/a.png"],
    [{ poster: "http://cdn.example/a.png" }, "http://cdn.example/a.png"],
    [{ image: "https://cdn.example/a.png" }, "https://cdn.example/a.png"],
    // `blob:` dropped 2026-10-04 (thumbnail-spec.md §1.3): a page-origin blob URL
    // cannot resolve in a chrome-extension:// document, so it always fired onError.
    [{ thumbnailUrl: "blob:https://x/uuid" }, ""],
    [{ thumbnailUrl: "data:image/png;base64,AAA" }, "data:image/png;base64,AAA"],
    [{ thumbnailUrl: "ftp://cdn.example/a.png" }, ""],
    [{ thumbnailUrl: "javascript:alert(1)" }, ""],
    [{ thumbnailUrl: "", poster: "https://cdn.example/b.png" }, "https://cdn.example/b.png"],
    [{}, ""],
    [null, ""],
  ])("videoThumbnailUrl(%j) === %j", (video, expected) => {
    expect(videoThumbnailUrl(video)).toBe(expected);
  });
});

describe("normalizeManualUrl", () => {
  it.each([
    ["https://cdn.example/a.mp4", "https://cdn.example/a.mp4"],
    ["http://cdn.example/a.mp4", "http://cdn.example/a.mp4"],
    ["  https://cdn.example/a.mp4  ", "https://cdn.example/a.mp4"],
    ["cdn.example/a.mp4", ""],
    ["javascript:alert(1)", ""],
    ["ftp://cdn.example/a.mp4", ""],
    ["blob:https://x/uuid", ""],
    ["", ""],
    [null, ""],
  ])("normalizeManualUrl(%j) === %j", (value, expected) => {
    expect(normalizeManualUrl(value)).toBe(expected);
  });
});

describe("formatDownloadPercent", () => {
  it.each([
    [0, "0%"],
    [42.4, "42%"],
    [42.6, "43%"],
    [100, "100%"],
    [-20, "0%"],
    [140, "100%"],
  ])("formatDownloadPercent(%j) === %j", (value, expected) => {
    expect(formatDownloadPercent(value)).toBe(expected);
  });
});
