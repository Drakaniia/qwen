import { describe, expect, it } from "vitest";

import {
  enrichVideoVariant,
  isGenericTitle,
  isSameFullVideo,
  normalizeComparableUrl,
} from "../../../src/shared/video_identity.js";

describe("normalizeComparableUrl", () => {
  it.each([
    ["https://x.com/a#frag", "https://x.com/a"],
    ["https://x.com/a#", "https://x.com/a"],
    ["https://x.com/a?b=1#frag", "https://x.com/a?b=1"],
    ["https://x.com/a?b=1", "https://x.com/a?b=1"],
    ["", ""],
  ])("normalizeComparableUrl(%j) === %j", (url, expected) => {
    expect(normalizeComparableUrl(url)).toBe(expected);
  });

  it("falls back to a hash-trimmed string for unparseable urls", () => {
    expect(normalizeComparableUrl("not a url#frag")).toBe("not a url");
  });
});

describe("isGenericTitle", () => {
  it.each([
    ["Video", true],
    ["video", true],
    ["VIDEOS", true],
    ["HTML5 Video", true],
    ["Home Page", true],
    ["Advertisement", true],
    ["undefined", true],
    ["null", true],
    ["1080p", true],
    ["720p", true],
    ["  ", true],
    ["", true],
    [null, true],
    [undefined, true],
    ["Real Song Title", false],
    ["1080p movie clip", false],
    ["日本語のタイトル", false],
  ])("isGenericTitle(%j) === %j", (value, expected) => {
    expect(isGenericTitle(value)).toBe(expected);
  });
});

describe("isSameFullVideo", () => {
  it("matches on identical url after hash stripping", () => {
    expect(isSameFullVideo({ url: "https://cdn/x.mp4" }, { url: "https://cdn/x.mp4#t=10" })).toBe(true);
  });

  it("does not match different urls with no pageUrl", () => {
    expect(isSameFullVideo({ url: "https://cdn/x.mp4" }, { url: "https://cdn/y.mp4" })).toBe(false);
  });

  it("matches on identical stem within the same page", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/a/movie.mp4", pageUrl: "https://site/p", title: "A" },
        { url: "https://cdn/b/movie.mp4", pageUrl: "https://site/p", title: "B" },
      ),
    ).toBe(true);
  });

  it("matches different stems when the title agrees and both stems are generic", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/video.mp4", pageUrl: "https://site/p", title: "Song" },
        { url: "https://cdn/stream.mp4", pageUrl: "https://site/p", title: "Song" },
      ),
    ).toBe(true);
  });

  it("does not match when both stems are specific but differ", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/ep1.mp4", pageUrl: "https://site/p", title: "A" },
        { url: "https://cdn/ep2.mp4", pageUrl: "https://site/p", title: "A" },
      ),
    ).toBe(false);
  });

  it("does not match when titles disagree and stems are specific", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/ep1.mp4", pageUrl: "https://site/p", title: "A" },
        { url: "https://cdn/ep2.mp4", pageUrl: "https://site/p", title: "B" },
      ),
    ).toBe(false);
  });

  it("does not match across different pages", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/video.mp4", pageUrl: "https://site/a", title: "A" },
        { url: "https://cdn/stream.mp4", pageUrl: "https://site/b", title: "A" },
      ),
    ).toBe(false);
  });

  it("ignores query and hash when comparing page urls", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/video.mp4", pageUrl: "https://Site/p?a=1#x", title: "A" },
        { url: "https://cdn/stream.mp4", pageUrl: "https://site/p", title: "A" },
      ),
    ).toBe(true);
  });

  it("uses frameUrl as a pageUrl fallback", () => {
    expect(
      isSameFullVideo(
        { url: "https://cdn/video.mp4", frameUrl: "https://site/p", title: "A" },
        { url: "https://cdn/stream.mp4", pageUrl: "https://site/p", title: "A" },
      ),
    ).toBe(true);
  });

  it("does not match entries with no url and no pageUrl", () => {
    // pageKey is empty, so the page comparison short-circuits to false. This is
    // what keeps url-less candidates from collapsing into one group.
    expect(isSameFullVideo({}, {})).toBe(false);
  });
});

describe("enrichVideoVariant", () => {
  it("derives the format from the url when absent", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.m3u8" }).format).toBe("M3U8");
  });

  it("keeps an explicit format", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4", format: "PAGE" }).format).toBe("PAGE");
  });

  it("infers height from a resolution suffix in the title", () => {
    const out = enrichVideoVariant({ url: "https://cdn/x.mp4", title: "Clip 1080p" });
    expect([out.width, out.height]).toEqual([null, 1080]);
  });

  it("infers both dimensions from a WxH string", () => {
    const out = enrichVideoVariant({ url: "https://cdn/x.mp4", title: "1280x720 rendition" });
    expect([out.width, out.height]).toEqual([1280, 720]);
  });

  it("converts mbps to kbps", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4", title: "2 mbps" }).bitrate).toBe(2000);
  });

  it("passes kbps through", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4", title: "1500 kbps" }).bitrate).toBe(1500);
  });

  it("prefers explicit width/height/bitrate over inference", () => {
    const out = enrichVideoVariant({
      url: "https://cdn/x.mp4",
      title: "1280x720",
      width: 1920,
      height: 1080,
      bitrate: 900,
    });
    expect([out.width, out.height, out.bitrate]).toEqual([1920, 1080, 900]);
  });

  it("nulls out absent numeric fields", () => {
    const out = enrichVideoVariant({ url: "https://cdn/x.mp4" });
    expect([out.width, out.height, out.bitrate, out.tbr]).toEqual([null, null, null, null]);
  });

  it("mirrors bitrate onto tbr", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4", tbr: 3000 }).bitrate).toBe(3000);
  });

  it("marks downloadable urls as downloadable", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4" }).downloadable).toBe(true);
  });

  it("marks blocked urls as not downloadable", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.js" }).downloadable).toBe(false);
  });

  it("honours an explicit downloadable === false", () => {
    expect(enrichVideoVariant({ url: "https://cdn/x.mp4", downloadable: false }).downloadable).toBe(false);
  });

  it("does not mutate the input", () => {
    const input = { url: "https://cdn/x.mp4" };
    enrichVideoVariant(input);
    expect((input as { format?: unknown }).format).toBeUndefined();
  });
});
