import { describe, expect, it } from "vitest";

import {
  classifyStreamingUrl,
  extractStreamingUrlsFromText,
  isLikelyStreamingUrl,
  isStreamingUrl,
  needsBackgroundProxy,
} from "../../../src/shared/streaming_patterns.js";

/**
 * Several cases below pin what the matchers do with a *missing* URL (`null`,
 * `undefined`, `42`). The signatures say `string`; the cast keeps the fixture as written
 * instead of widening the production signature to admit nonsense.
 */
const url = (value: unknown) => value as string;

describe("isStreamingUrl", () => {
  /** `unknown` first column: three cases pin a non-string URL. */
  const cases: [unknown, boolean][] = [
    ["https://hls.mediacdn.vn/x/master.m3u8", true],
    ["https://hls.tuoitre.vn/x/y.mp4.json", true],
    ["https://nixcdn.com/x", true],
    ["https://api-v1.soundcloud.com/media/soundcloud:tracks:123", true],
    ["https://zingmp3.vn/api/v2/song?id=1", true],
    ["https://streamsb.biz/playlist/json/abc/def", true],
    ["https://discordapp.com/attachments/1/2/file.mp4", true],
    ["https://vkvd123.mycdn.me/x", true],
    ["https://v.douyu.com/api/stream/getStreamUrl", true],
    ["https://cam-hls1.cuoiia.top/cdn/x", true],
    ["https://iamplayer.xyz/stream/1/Manifest", true],
    ["https://khophim18.net/m3u8/x", true],
    ["https://content-aapm1.uplynk.com/x", true],
    ["https://master2-eu.playerx.stream/x", true],
    ["https://s1.imacdn.com/x", true],
    ["https://www.vtvgiaitri.vn/x", true],
    // HYDRA_STREAM_RE is just /hydra/i.
    ["https://hydra.example.com/x", true],
    ["https://example.com/video.mp4", false],
    ["https://example.com/page", false],
    ["", false],
    [null, false],
    [undefined, false],
    [42, false],
  ];

  it.each(cases)("isStreamingUrl(%j) === %j", (input, expected) => {
    expect(isStreamingUrl(url(input))).toBe(expected);
  });
});

describe("isLikelyStreamingUrl", () => {
  it.each([
    ["https://hls.mediacdn.vn/x", true],
    ["https://cdn.example.com/a.mp4?token=abc", true],
    ["https://cdn.example.com/a.mp4?X-Amz-Expires=1", true],
    ["https://cdn.example.com/seg_12.ts", true],
    ["https://cdn.example.com/fragment-3.mp4", true],
    ["https://cdn.example.com/000001.mp4", true],
    ["https://api.example.com/video/42/config", true],
    ["https://video-cdn.example.com/x", true],
    ["https://example.com/page", false],
    ["https://example.com/a.mp4", false],
    ["", false],
    [null, false],
  ])("isLikelyStreamingUrl(%j) === %j", (input, expected) => {
    expect(isLikelyStreamingUrl(url(input))).toBe(expected);
  });
});

describe("classifyStreamingUrl", () => {
  it("treats a signed url with no extension as an HLS stream", () => {
    expect(classifyStreamingUrl("https://cdn.example.com/opaque?token=abc")).toEqual({
      type: "streaming",
      format: "M3U8",
      isStreaming: true,
    });
  });

  it("matches extension before pattern, and does not flag isStreaming", () => {
    expect(classifyStreamingUrl("https://hls.mediacdn.vn/master.m3u8")).toEqual({
      type: "manifest",
      format: "M3U8",
      isStreaming: false,
    });
  });

  it.each([
    ["https://x.example/a.m3u8", "", "manifest", "M3U8"],
    ["https://x.example/a.mpd", "", "manifest", "MPD"],
    ["https://x.example/a.mp4", "", "direct", "MP4"],
    ["https://x.example/a.m4v", "", "direct", "MP4"],
    // A .webm URL is reported as MP4 by the extension branch, but as WEBM by the
    // content-type branch. Pinned because the two paths disagree.
    ["https://x.example/a.webm", "", "direct", "MP4"],
    ["https://x.example/a", "application/x-mpegURL", "manifest", "M3U8"],
    ["https://x.example/a", "application/dash+xml", "manifest", "MPD"],
    ["https://x.example/a", "video/mp4", "direct", "MP4"],
    ["https://x.example/a", "video/webm", "direct", "WEBM"],
    ["https://x.example/a", "video/x-flv", "direct", "FLV"],
    ["https://x.example/a", "audio/mpeg", "direct", "VIDEO"],
  ])("classifyStreamingUrl(%j, %j) => %j / %j", (input, type, expectedType, expectedFormat) => {
    const result = classifyStreamingUrl(url(input), url(type));
    expect([result.type, result.format]).toEqual([expectedType, expectedFormat]);
  });

  it.each([
    ["", ""],
    [null, ""],
    ["https://example.com/page", ""],
  ])("classifyStreamingUrl(%j, %j) returns the unknown default", (input, type) => {
    expect(classifyStreamingUrl(url(input), url(type))).toEqual({ type: "unknown", format: "", isStreaming: false });
  });
});

describe("extractStreamingUrlsFromText", () => {
  it.each([
    ["", []],
    [null, []],
    ["no urls at all", []],
  ])("extractStreamingUrlsFromText(%j) === []", (text, expected) => {
    expect(extractStreamingUrlsFromText(url(text))).toEqual(expected);
  });

  it("finds extension urls", () => {
    const found = extractStreamingUrlsFromText('var src = "https://cdn.example/a.mp4";');
    expect(found).toEqual([{ url: "https://cdn.example/a.mp4", confidence: "extension" }]);
  });

  it("labels a fragment-free manifest url as a manifest only once", () => {
    const found = extractStreamingUrlsFromText('"https://cdn.example/a.m3u8"');
    expect(found).toEqual([{ url: "https://cdn.example/a.m3u8", confidence: "extension" }]);
  });

  it("labels a segment url as a manifest", () => {
    const found = extractStreamingUrlsFromText('"https://cdn.example/a.m4s"');
    expect(found).toEqual([{ url: "https://cdn.example/a.m4s", confidence: "manifest" }]);
  });

  it("labels a cdn-host url as cdn", () => {
    const found = extractStreamingUrlsFromText('"https://d1234.cloudfront.net/asset"');
    expect(found).toEqual([{ url: "https://d1234.cloudfront.net/asset", confidence: "cdn" }]);
  });

  it("picks a url out of a player config object", () => {
    const found = extractStreamingUrlsFromText('{ file: "https://cdn.example/stream.m3u8" }');
    expect(found).toEqual([{ url: "https://cdn.example/stream.m3u8", confidence: "extension" }]);
  });

  it("labels a signed url as signed", () => {
    // Host must avoid the pattern-3 cdn words, or "cdn" wins first.
    const found = extractStreamingUrlsFromText('"https://assets.example/asset?signature=xyz"');
    expect(found).toEqual([{ url: "https://assets.example/asset?signature=xyz", confidence: "signed" }]);
  });

  it("deduplicates across patterns, keeping the first confidence seen", () => {
    const found = extractStreamingUrlsFromText('file: "https://cdn.example/a.mp4?token=1"');
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe("extension");
  });
});

describe("needsBackgroundProxy", () => {
  it.each([
    ["https://r1.googlevideo.com/videoplayback", true],
    ["https://cdn.example.akamaihd.net/x", true],
    ["https://d123.cloudfront.net/x", true],
    ["https://nixcdn.com/x", true],
    ["https://mediacdn.vn/x", true],
    ["https://example.com/a.mp4", false],
    ["", false],
    [null, false],
  ])("needsBackgroundProxy(%j) === %j", (input, expected) => {
    expect(needsBackgroundProxy(url(input))).toBe(expected);
  });
});
