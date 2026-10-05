import { describe, expect, it } from "vitest";

import {
  CDN_HINT_RE,
  DASH_RE,
  DIRECT_VIDEO_EXTENSION_RE,
  HLS_RE,
  VIDEO_EXTENSION_RE,
  classifyMediaUrl,
  isBlockedMediaUrl,
  isBlockedMediaUrlWithExceptions,
  isDownloadableMediaUrl,
  isLikelyAudioUrl,
  isLikelyVideoRequest,
  isPlaylistLike,
  isYouTubeVideoPageUrl,
  normalizeYouTubeVideoPageUrl,
} from "../../../src/shared/media_candidates.js";

/**
 * `isBlockedMediaUrlWithExceptions` takes a `Set`; the array/`null`/string inputs below
 * are the pre-`Set` shapes it is being pinned against, and an array still iterates, so
 * the cast documents the intent rather than changing what runs.
 */
const exceptionDomains = (value: unknown) => value as Set<string> | null | undefined;

describe("classifyMediaUrl", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "", "YOUTUBE"],
    ["https://youtu.be/dQw4w9WgXcQ", "", "YOUTUBE"],
    ["https://www.youtube.com/shorts/abc123", "", "YOUTUBE"],
    ["https://www.youtube.com/live/abc123", "", "YOUTUBE"],
    ["https://www.youtube-nocookie.com/embed/abc123", "", "YOUTUBE"],
    ["https://cdn.example.com/master.m3u8", "", "M3U8"],
    ["https://cdn.example.com/master.m3u8?token=1", "", "M3U8"],
    ["https://cdn.example.com/manifest.mpd", "", "MPD"],
    ["https://cdn.example.com/smooth.ism/Manifest", "", "ISM"],
    ["https://cdn.example.com/clip.webm", "", "WEBM"],
    ["https://cdn.example.com/clip.mp4", "", "MP4"],
    ["https://cdn.example.com/clip.m4v", "", "MP4"],
    ["https://cdn.example.com/song.mp3", "", "AUDIO"],
    ["https://cdn.example.com/song.m4a", "", "AUDIO"],
    ["https://spotifycdn.com/track/xyz", "", "AUDIO"],
    ["https://audio.example.com/stream", "", "AUDIO"],
    ["blob:https://site.example/8f0e-uuid", "", "BLOB"],
    ["https://cdn.example.com/opaque", "", "VIDEO"],
    ["", "", "VIDEO"],
    ["not a url", "", "VIDEO"],
    ["https://cdn.example.com/opaque", "video/x-matroska", "X-MATROSKA"],
    ["https://cdn.example.com/a.mp4", "video/mp2t", "MP4"],
    ["https://cdn.example.com/clip", "application/x-mpegURL", "M3U8"],
    ["https://cdn.example.com/clip", "application/dash+xml", "MPD"],
    ["https://cdn.example.com/clip", "video/webm", "WEBM"],
    // A music-CDN host carrying a video extension still classifies as video.
    ["https://audio.example.com/clip.mp4", "", "MP4"],
  ];

  it.each(cases)("classifyMediaUrl(%j, %j) === %j", (url, type, expected) => {
    expect(classifyMediaUrl(url, type)).toBe(expected);
  });
});

describe("isBlockedMediaUrl", () => {
  const blocked = [
    ["", ""],
    ["https://cdn.example.com/player.js", ""],
    ["https://cdn.example.com/player.mjs", ""],
    ["https://cdn.example.com/site.css", ""],
    ["https://cdn.example.com/vast.js", ""],
    ["https://cdn.example.com/ad-plugin/core.js", ""],
    ["https://doubleclick.net/ads/tag.js", ""],
    ["https://cdn.example.com/a.mp4", "text/html"],
    ["https://cdn.example.com/a.mp4", "text/javascript"],
    ["https://cdn.example.com/a.mp4", "application/json"],
    ["https://cdn.example.com/a.mp4", "image/png"],
    ["https://cdn.example.com/a.mp4", "font/woff2"],
    ["https://r1.googlevideo.com/videoplayback", ""],
    ["https://foo.googlevideo.com/videoplayback", ""],
    ["https://cdn.example.com/thumb.gif", ""],
    ["https://cdn.example.com/manifest.json", ""],
    ["https://cdn.example.com/site.webmanifest", ""],
    ["https://cdn.example.com/seg-1.ts", ""],
    ["https://cdn.example.com/chunk_000001.m4s", ""],
    ["https://cdn.example.com/a.mp4", "video/mp2t"],
    ["https://cdn.example.com/hls/000001.mp4", ""],
    ["https://cdn.example.com/dash/000001.mp4", ""],
    ["https://player.hanime.tv/embed/1", ""],
    ["https://vidsrc-embed.ru/embed/1", ""],
    ["https://vidfast.pro/abc", ""],
    ["https://flashx.to/abc", ""],
    ["https://douyu.com/1", ""],
    ["https://huya.cn/1", ""],
    ["https://twitch.tv/somebody", ""],
    ["https://kick.com/somebody", ""],
    ["https://douyucdn.cn/seg-1.ts", ""],
    ["https://site.example/front-publish/stream-sdk-lib-master/x.js", ""],
    ["https://x.example/ads/y.mp4", ""],
    ["https://example.com/ad/video.mp4", ""],
    ["https://lulust.com/cdn-cgi/challenge-platform/h/b/precursor/d76008a69eab/0.608:1791187520:x/a45b54e3094435b2", ""],
    ["https://site.example/cdn-cgi/beacon.min.js", ""],
    ["https://site.example/cdn-cgi/rum", ""],
  ];

  it.each(blocked)("blocks %j (%j)", (url, type) => {
    expect(isBlockedMediaUrl(url, type)).toBe(true);
  });

  const allowed = [
    ["https://cdn.example.com/clip.mp4", ""],
    ["https://cdn.example.com/master.m3u8", ""],
    ["https://www.youtube.com/watch?v=abc", ""],
    ["https://foo.googlevideo.com/videoplaybackX", ""],
    // Manifests inside an HLS path stay allowed — only numbered segments are cut.
    ["https://cdn.example.com/hls/000001.m3u8", ""],
    ["https://vidfast.pro/abc.mp4", ""],
    ["https://douyucdn.cn/clip.mp4", ""],
    ["https://twitch.tv/clip.mp4", ""],
    ["https://cdn.example.com/mypath/000001.mp4", ""],
    // "playlist" is not a fragment-context word, so a numbered file under /playlist/ survives.
    ["https://cdn.example.com/playlist/000001.mp4", ""],
    // The ad pattern needs a delimiter before "ad"; a hostname like ads.example.com is not enough.
    ["https://ads.example.com/x", ""],
  ];

  it.each(allowed)("allows %j (%j)", (url, type) => {
    expect(isBlockedMediaUrl(url, type)).toBe(false);
  });
});

describe("isBlockedMediaUrlWithExceptions", () => {
  it("unblocks an exact host match", () => {
    expect(isBlockedMediaUrlWithExceptions("https://example.com/a.js", "", exceptionDomains(["example.com"]))).toBe(
      false,
    );
  });

  it("unblocks a subdomain match", () => {
    expect(isBlockedMediaUrlWithExceptions("https://cdn.example.com/a.js", "", exceptionDomains(["example.com"]))).toBe(
      false,
    );
  });

  it("keeps blocking when the domain does not match", () => {
    expect(isBlockedMediaUrlWithExceptions("https://example.com/a.js", "", exceptionDomains(["other.com"]))).toBe(true);
  });

  it.each([
    ["empty list", exceptionDomains([])],
    ["null", exceptionDomains(null)],
    ["undefined", exceptionDomains(undefined)],
    ["non-object", exceptionDomains("example.com")],
  ])("keeps blocking with an %s exception set", (_label, domains) => {
    expect(isBlockedMediaUrlWithExceptions("https://example.com/a.js", "", domains)).toBe(true);
  });

  it("stays blocked for an unparseable url even with exceptions", () => {
    // "ads.js" trips the static-asset pattern but is not parseable as a URL.
    expect(isBlockedMediaUrlWithExceptions("ads.js", "", exceptionDomains(["example.com"]))).toBe(true);
  });

  it("never reports an unblocked url as unblocked (already-allowed pass-through)", () => {
    expect(
      isBlockedMediaUrlWithExceptions("https://cdn.example.com/a.mp4", "", exceptionDomains(["example.com"])),
    ).toBe(false);
  });

  it("returns false for a url that was never blocked, without consulting exceptions", () => {
    expect(isBlockedMediaUrlWithExceptions("not a url", "", exceptionDomains(["example.com"]))).toBe(false);
  });
});

describe("isDownloadableMediaUrl", () => {
  it.each([
    ["https://cdn.example.com/a.mp4", true],
    ["blob:https://site.example/uuid", true],
    ["ws://cdn.example.com/socket", true],
    ["ftp://cdn.example.com/a.mp4", false],
    ["file:///c/video.mp4", false],
    ["not a url", false],
    ["", false],
    ["https://cdn.example.com/a.js", false],
  ])("isDownloadableMediaUrl(%j) === %j", (url, expected) => {
    expect(isDownloadableMediaUrl(url)).toBe(expected);
  });
});

describe("isLikelyAudioUrl", () => {
  it.each([
    ["https://cdn.example.com/song.mp3", "", true],
    ["https://cdn.example.com/song.opus", "", true],
    ["https://spotifycdn.com/track/xyz", "", true],
    ["https://audio.example.com/stream", "", true],
    ["https://audio.example.com/clip.mp4", "", false],
    ["https://cdn.example.com/clip", "audio/mpeg", true],
    ["https://cdn.example.com/clip.mp4", "", false],
    ["", "", false],
  ])("isLikelyAudioUrl(%j, %j) === %j", (url, type, expected) => {
    expect(isLikelyAudioUrl(url, type)).toBe(expected);
  });
});

describe("isLikelyVideoRequest", () => {
  it.each([
    ["https://cdn.example.com/a.mp4", "", "", true],
    ["https://cdn.example.com/a.webm", "", "", true],
    ["https://cdn.example.com/opaque", "", "video/mp4", true],
    ["https://cdn.example.com/opaque", "", "application/x-mpegURL", true],
    ["https://cdn.example.com/playlist/xyz", "media", "", true],
    ["https://cdn.example.com/opaque", "media", "", false],
    ["https://cdn.example.com/player.js", "media", "", false],
    ["", "", "", false],
  ])("isLikelyVideoRequest(%j, %j, %j) === %j", (url, resourceType, type, expected) => {
    expect(isLikelyVideoRequest(url, resourceType, type)).toBe(expected);
  });
});

describe("isPlaylistLike", () => {
  it.each([
    [{ format: "M3U8" }, true],
    [{ format: "mpd" }, true],
    [{ format: "ISM" }, true],
    [{ format: "YOUTUBE" }, true],
    [{ format: "PAGE" }, true],
    [{ url: "https://cdn.example.com/a.m3u8" }, true],
    [{ url: "https://cdn.example.com/a.mpd" }, true],
    [{ url: "https://cdn.example.com/a.ism/Manifest" }, true],
    [{ contentType: "application/x-mpegURL" }, true],
    [{ contentType: "application/dash+xml" }, true],
    [{ url: "https://cdn.example.com/a.mp4" }, false],
    [{}, false],
    [null, false],
    ["M3U8", false],
  ])("isPlaylistLike(%j) === %j", (details, expected) => {
    expect(isPlaylistLike(details)).toBe(expected);
  });
});

describe("youtube page urls", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", true],
    ["https://youtube.com/watch?v=abc", true],
    ["https://m.youtube.com/watch?v=abc", true],
    ["https://youtu.be/abc", true],
    ["https://www.youtube.com/shorts/abc", true],
    ["https://www.youtube.com/live/abc", true],
    ["https://www.youtube.com/embed/abc", true],
    ["https://www.youtube-nocookie.com/embed/abc", true],
    ["https://www.youtube.com/", false],
    ["https://www.youtube.com/feed/subscriptions", false],
    ["https://notyoutube.com/watch?v=abc", false],
    ["https://www.youtube.com/watch", false],
    ["not a url", false],
    ["", false],
  ])("isYouTubeVideoPageUrl(%j) === %j", (url, expected) => {
    expect(isYouTubeVideoPageUrl(url)).toBe(expected);
  });

  it.each([
    ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=abc", "https://www.youtube.com/watch?v=abc"],
    ["https://www.youtube.com/shorts/abc", "https://www.youtube.com/shorts/abc"],
    ["https://www.youtube.com/live/abc", "https://www.youtube.com/live/abc"],
    ["https://www.youtube-nocookie.com/embed/abc", "https://www.youtube.com/watch?v=abc"],
    // searchParams decode, so a raw unicode id survives normalization once.
    ["https://www.youtube.com/watch?v=vidéo", "https://www.youtube.com/watch?v=vid%C3%A9o"],
    // youtu.be takes the raw path segment, which is already percent-encoded —
    // so a unicode/space id gets double-encoded. Real ids are [A-Za-z0-9_-]{11}.
    ["https://youtu.be/vidéo id", "https://www.youtube.com/watch?v=vid%25C3%25A9o%2520id"],
    ["https://site.example/watch", ""],
    ["not a url", ""],
  ])("normalizeYouTubeVideoPageUrl(%j) === %j", (url, expected) => {
    expect(normalizeYouTubeVideoPageUrl(url)).toBe(expected);
  });
});

describe("re-exported regex constants", () => {
  it.each([
    ["VIDEO_EXTENSION_RE", VIDEO_EXTENSION_RE, "https://x/a.mp4", true],
    ["VIDEO_EXTENSION_RE", VIDEO_EXTENSION_RE, "https://x/a.mp3", false],
    ["HLS_RE", HLS_RE, "https://x/a.m3u8?x=1", true],
    ["DASH_RE", DASH_RE, "https://x/a.mpd#f", true],
    ["CDN_HINT_RE", CDN_HINT_RE, "https://r1.googlevideo.com/videoplayback", true],
    ["DIRECT_VIDEO_EXTENSION_RE", DIRECT_VIDEO_EXTENSION_RE, "https://x/a.m3u8", false],
    ["DIRECT_VIDEO_EXTENSION_RE", DIRECT_VIDEO_EXTENSION_RE, "https://x/a.m4v", true],
  ])("%s.test(%j) === %j", (_name, re, url, expected) => {
    expect(re.test(url)).toBe(expected);
  });
});
