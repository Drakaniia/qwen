import { describe, expect, it } from "vitest";

import {
  displayVideoFormat,
  displayVideoSize,
  finiteNumber,
  humanSize,
  isGenericTitle,
  isDownloadableUrl,
  isLikelyFullLengthVideoCandidate,
  isLikelyRealVideoBox,
  isLikelyRealVideoElement,
  isLikelyVideoRequest,
  lower,
  numericVideoSize,
  sourceLabel,
  textForVideoSignals,
} from "../../../src/shared/video_filters.js";

describe("basic utilities", () => {
  it.each([
    ["A", "a"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    [0, ""],
    [false, ""],
  ])("lower(%j) === %j", (value, expected) => {
    expect(lower(value)).toBe(expected);
  });

  it.each([
    ["12", 12],
    [12, 12],
    [12.5, 12.5],
    ["abc", 0],
    [null, 0],
    [undefined, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NaN, 0],
  ])("finiteNumber(%j) === %j", (value, expected) => {
    expect(finiteNumber(value)).toBe(expected);
  });

  it("textForVideoSignals joins the known signal fields", () => {
    expect(textForVideoSignals({ url: "u", title: "t", note: "n", source: "s" })).toBe("u t n s");
  });

  it("textForVideoSignals skips falsy fields", () => {
    expect(textForVideoSignals({ url: "u", title: "", label: null })).toBe("u");
  });

  it.each([null, undefined, 0])("textForVideoSignals(%j) is a string", (value) => {
    expect(typeof textForVideoSignals(value)).toBe("string");
  });

  it("textForVideoSignals stringifies a non-object input", () => {
    expect(textForVideoSignals("hello")).toBe("hello");
  });
});

describe("displayVideoFormat", () => {
  /** `unknown` first column: the input may be a bare format string or no object at all. */
  const cases: [unknown, string][] = [
    [{ format: "audio" }, "AUDIO"],
    [{ format: "AUDIO" }, "AUDIO"],
    [{ format: "m3u8" }, "MP4"],
    [{ format: "mpd" }, "MP4"],
    [{ format: "ism" }, "MP4"],
    [{ format: "youtube" }, "MP4"],
    [{ format: "page" }, "MP4"],
    [{ format: "webm" }, "WEBM"],
    ["mp4", "MP4"],
    [null, "VIDEO"],
    [{}, "VIDEO"],
    [{ format: "" }, "VIDEO"],
  ];

  it.each(cases)("displayVideoFormat(%j) === %j", (input, expected) => {
    expect(displayVideoFormat(input)).toBe(expected);
  });
});

describe("humanSize", () => {
  it.each([
    [0, ""],
    [-5, ""],
    [null, ""],
    ["abc", ""],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [5000, "4.9 KB"],
    [1024 * 1024, "1.0 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
    [5 * 1024 * 1024 * 1024, "5.0 GB"],
  ])("humanSize(%j) === %j", (bytes, expected) => {
    expect(humanSize(bytes)).toBe(expected);
  });
});

describe("numericVideoSize", () => {
  it.each([
    [{ sizeBytes: 100 }, 100],
    [{ filesize: 200 }, 200],
    [{ filesize_approx: 300 }, 300],
    [{ fileSize: 400 }, 400],
    [{ sizeBytes: 0, filesize: 200 }, 200],
    [{ sizeBytes: 100, filesize: 200 }, 100],
    [{}, 0],
    [null, 0],
    ["100", 0],
    // Playlist-shaped entries never report a size.
    [{ sizeBytes: 100, format: "M3U8" }, 0],
    [{ sizeBytes: 100, url: "https://x/a.m3u8" }, 0],
  ])("numericVideoSize(%j) === %j", (input, expected) => {
    expect(numericVideoSize(input)).toBe(expected);
  });
});

describe("displayVideoSize", () => {
  it.each([
    [null, ""],
    ["x", ""],
    [{ size: "  1.2 GB  " }, "1.2 GB"],
    [{ size: "   " }, ""],
    [{ sizeBytes: 2048 }, "2.0 KB"],
    [{ sizeBytes: 2048, size: "prefer-me" }, "prefer-me"],
    [{ variants: [{ sizeBytes: 100 }, { sizeBytes: 2048 }] }, "2.0 KB"],
    [{ variants: [{ size: "9 MB" }] }, "9 MB"],
    [{ variants: [{ size: "9 MB" }, { sizeBytes: 2048 }] }, "2.0 KB"],
    [{ variants: [] }, ""],
    [{}, ""],
    [{ format: "M3U8", variants: [{ sizeBytes: 5_000_000 }] }, "4.8 MB"],
  ])("displayVideoSize(%j) === %j", (input, expected) => {
    expect(displayVideoSize(input)).toBe(expected);
  });
});

describe("sourceLabel", () => {
  it.each([
    [{ source: "manual-url" }, "manual link"],
    [{ source: "music-page" }, "music"],
    [{ format: "M3U8", source: "dom-video" }, "full video"],
    [{ format: "mpd", source: "dom-video" }, "full video"],
    [{ format: "YOUTUBE", source: "dom-video" }, "full video"],
    [{ format: "PAGE", source: "dom-video" }, "full video"],
    [{ source: "dom-video" }, "dom-video"],
    [{}, "detected"],
    [{ source: "manual-url", format: "M3U8" }, "manual link"],
  ])("sourceLabel(%j) === %j", (input, expected) => {
    expect(sourceLabel(input)).toBe(expected);
  });
});

describe("isLikelyFullLengthVideoCandidate", () => {
  // NB: the base url deliberately avoids "clip"/"preview"/"part" — those are
  // short/incomplete signal words and would trip the filter for non-dom sources.
  const base = {
    url: "https://cdn.example.com/movie.mp4",
    source: "dom-video",
    duration: 120,
    width: 1920,
    height: 1080,
  };

  it("accepts a normal dom candidate", () => {
    expect(isLikelyFullLengthVideoCandidate(base)).toBe(true);
  });

  it.each([
    ["no url", { ...base, url: "" }],
    ["non-downloadable url", { ...base, url: "https://cdn.example.com/a.js" }],
    ["downloadable === false", { ...base, downloadable: false }],
    ["under 30s", { ...base, duration: 10 }],
    ["performance source with no duration", { ...base, source: "performance", duration: 0 }],
    ["direct size under 2KB", { ...base, sizeBytes: 100 }],
    ["header source under 1MB", { ...base, source: "headers", sizeBytes: 5000 }],
    ["complete === false", { ...base, complete: false }],
    ["partial === true", { ...base, partial: true }],
  ])("rejects: %s", (_label, details) => {
    expect(isLikelyFullLengthVideoCandidate(details)).toBe(false);
  });

  it.each([
    ["manual-url bypasses every signal", { ...base, source: "manual-url", duration: 1 }],
    ["ssr-json source is trusted", { ...base, source: "ssr-json:config", duration: 1, title: "preview" }],
    ["header source over 1MB", { ...base, source: "headers", sizeBytes: 5_000_000 }],
    ["playlist header source skips the 1MB rule", { ...base, source: "headers", format: "M3U8", sizeBytes: 5000 }],
  ])("accepts: %s", (_label, details) => {
    expect(isLikelyFullLengthVideoCandidate(details)).toBe(true);
  });

  // Dom sources are exempt from the short/incomplete *word* filter only —
  // the 30-second floor still applies to them. (The CDP capture path that produced
  // "cdp-*" sources was removed, so there is no such source to test.)
  it.each(["dom-video", "dom-source", "page-fallback", "youtube-page"])(
    "%s ignores short/preview/part words",
    (source) => {
      expect(isLikelyFullLengthVideoCandidate({ ...base, source, title: "Teaser preview" })).toBe(true);
      expect(isLikelyFullLengthVideoCandidate({ ...base, source, url: "https://cdn.example.com/clip.mp4" })).toBe(true);
    },
  );

  it.each(["dom-video", "dom-source", "page-fallback", "youtube-page"])("%s still rejects under 30s", (source) => {
    expect(isLikelyFullLengthVideoCandidate({ ...base, source, duration: 10 })).toBe(false);
  });

  it("a former cdp-* source is no longer exempt", () => {
    expect(isLikelyFullLengthVideoCandidate({ ...base, source: "cdp-network", title: "Teaser preview" })).toBe(false);
  });

  it.each([
    ["url contains 'clip'", { url: "https://cdn.example.com/clip.mp4" }],
    ["url contains 'short'", { url: "https://cdn.example.com/short.mp4" }],
    ["url contains 'segment'", { url: "https://cdn.example.com/segment.mp4" }],
    ["title says preview", { title: "Teaser preview" }],
    ["title says part", { title: "Episode part 1" }],
  ])("network source is rejected on a short/incomplete signal: %s", (_label, patch) => {
    expect(isLikelyFullLengthVideoCandidate({ ...base, source: "network", ...patch })).toBe(false);
  });

  it("accepts a short youtube page url regardless of duration", () => {
    expect(
      isLikelyFullLengthVideoCandidate({
        url: "https://www.youtube.com/watch?v=abc",
        source: "dom-video",
        duration: 5,
        title: "short",
      }),
    ).toBe(true);
  });

  it.each([null, undefined, "string", 0])("rejects non-object input %j", (value) => {
    expect(isLikelyFullLengthVideoCandidate(value)).toBe(false);
  });
});

describe("isLikelyRealVideoBox", () => {
  it.each([
    [{ width: 1920, height: 1080 }, true],
    [{ width: 640, height: 360 }, true],
    [{ width: 159, height: 1080 }, false],
    [{ width: 1920, height: 89 }, false],
    [{ width: 120, height: 120 }, false],
    // No dimensions at all collapses width*height to 0 < 14400.
    [{}, false],
    [{ width: 1920, height: 1080, duration: 1 }, false],
    [{ width: 1920, height: 1080, duration: 0 }, true],
    [{ width: 640, height: 360, duration: 3, loop: true, muted: true, autoplay: true }, false],
    [{ width: 640, height: 360, duration: 3, loop: true, muted: true, autoplay: false }, true],
  ])("isLikelyRealVideoBox(%j) === %j", (details, expected) => {
    expect(isLikelyRealVideoBox(details)).toBe(expected);
  });
});

describe("isLikelyRealVideoElement", () => {
  it("requires both a full-length candidate and a real box", () => {
    expect(
      isLikelyRealVideoElement({
        url: "https://cdn.example.com/clip.mp4",
        source: "dom-video",
        duration: 120,
        width: 1920,
        height: 1080,
      }),
    ).toBe(true);
  });

  it("rejects a candidate with no dimensions", () => {
    expect(
      isLikelyRealVideoElement({
        url: "https://cdn.example.com/clip.mp4",
        source: "dom-video",
        duration: 120,
      }),
    ).toBe(false);
  });

  it("rejects a non-candidate with good dimensions", () => {
    expect(
      isLikelyRealVideoElement({
        url: "https://cdn.example.com/clip.mp4",
        source: "dom-video",
        duration: 3,
        width: 1920,
        height: 1080,
      }),
    ).toBe(false);
  });
});

describe("re-exported classification wrappers", () => {
  it("isGenericTitle is re-exported from video_identity", () => {
    expect(isGenericTitle("Home Page")).toBe(true);
    expect(isGenericTitle("Real Title")).toBe(false);
  });

  it("isDownloadableUrl delegates to media_candidates", () => {
    expect(isDownloadableUrl("https://cdn.example.com/a.mp4")).toBe(true);
    expect(isDownloadableUrl("https://cdn.example.com/a.js")).toBe(false);
  });

  it("isLikelyVideoRequest delegates to media_candidates", () => {
    expect(isLikelyVideoRequest("https://cdn.example.com/a.mp4")).toBe(true);
  });
});
