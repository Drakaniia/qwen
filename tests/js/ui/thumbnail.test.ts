/**
 * The thumbnail ladder (spec `thumbnail-spec.md` §3, §4).
 *
 * These are the pins for the thing that was broken: `thumbnailUrl` used to be a
 * single URL read from two metadata sources, so a 403 or an unrecognisably small
 * image was terminal. The ladder is what makes "not showing for all videos" fixable
 * without asking yt-dlp about every candidate.
 */
import { describe, expect, it } from "vitest";

import { videoThumbnailCandidates, videoThumbnailUrl } from "../../../src/ui/format.js";
import {
  THUMBNAIL_CANDIDATE_LIMIT,
  dedupeThumbnailUrls,
  deriveSiteThumbnail,
} from "../../../src/ui/thumbnail_sources.js";

describe("deriveSiteThumbnail", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://youtu.be/dQw4w9WgXcQ", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    ["https://vimeo.com/76979871", "https://vumbnail.com/76979871.jpg"],
    ["https://player.vimeo.com/video/76979871", "https://vumbnail.com/76979871.jpg"],
    ["https://dai.ly/x8hxfnq", "https://www.dai.ly/thumbnail/video/x8hxfnq"],
    ["https://www.dailymotion.com/video/x8hxfnq", "https://www.dai.ly/thumbnail/video/x8hxfnq"],
    ["https://www.dailymotion.com/embed/video/x8hxfnq", "https://www.dai.ly/thumbnail/video/x8hxfnq"],
  ])("deriveSiteThumbnail(%j) === %j", (input, expected) => {
    expect(deriveSiteThumbnail(input)).toBe(expected);
  });

  it.each([
    ["a YouTube page with no id", "https://www.youtube.com/feed/trending"],
    ["a YouTube id of the wrong shape", "https://www.youtube.com/watch?v=!!"],
    ["a Vimeo path that is not a video id", "https://vimeo.com/channels/staffpicks"],
    ["a host this table does not know", "https://cdn.example/poster.jpg"],
    ["a bare mp4", "https://cdn.example/video.mp4"],
    ["a non-URL", "not a url"],
    ["", ""],
    [null, ""],
  ])('deriveSiteThumbnail returns "" for %s', (_label, input) => {
    expect(deriveSiteThumbnail(input)).toBe("");
  });

  // A `v=` on a non-YouTube host is somebody else's query parameter, not a video id.
  it("does not treat a lookalike host as YouTube", () => {
    expect(deriveSiteThumbnail("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBe("");
  });
});

describe("dedupeThumbnailUrls", () => {
  it("keeps first-seen order and drops empties and repeats", () => {
    expect(dedupeThumbnailUrls(["b", "", "a", "b", null, "a"])).toEqual(["b", "a"]);
  });
});

describe("videoThumbnailCandidates", () => {
  it("uses the content script's ladder when it supplied one", () => {
    const candidates = videoThumbnailCandidates({
      thumbnailUrl: "https://cdn.example/poster.jpg",
      thumbnailCandidates: [
        "https://cdn.example/frame.jpg",
        "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        "https://cdn.example/og.jpg",
      ],
      pageUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    // The supplied ladder wins outright — the content script saw the element and its
    // order already accounts for the frame capture.
    expect(candidates).toEqual([
      "https://cdn.example/frame.jpg",
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "https://cdn.example/og.jpg",
    ]);
  });

  it("puts video-specific art before page metadata when deriving", () => {
    expect(videoThumbnailCandidates({ thumbnailUrl: "https://cdn.example/poster.jpg" })).toEqual([
      "https://cdn.example/poster.jpg",
    ]);
  });

  it("derives site art from the page URL before the media URL", () => {
    expect(
      videoThumbnailCandidates({
        pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        url: "https://r1---sn-x.googlevideo.com/videoplayback?id=dQw4w9WgXcQ",
      }),
    ).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]);
  });

  it("keeps a frame capture ahead of derived art", () => {
    // A `data:` capture is the only source that is specific to *this* video element,
    // so it never loses to a site guess.
    expect(
      videoThumbnailCandidates({
        thumbnailUrl: "data:image/jpeg;base64,AAA",
        pageUrl: "https://vimeo.com/76979871",
      }),
    ).toEqual(["data:image/jpeg;base64,AAA", "https://vumbnail.com/76979871.jpg"]);
  });

  it("caps the ladder at the request budget", () => {
    const candidates = videoThumbnailCandidates({
      thumbnailCandidates: [
        "https://cdn.example/1.jpg",
        "https://cdn.example/2.jpg",
        "https://cdn.example/3.jpg",
        "https://cdn.example/4.jpg",
      ],
    });
    expect(candidates).toHaveLength(THUMBNAIL_CANDIDATE_LIMIT);
    expect(candidates).not.toContain("https://cdn.example/4.jpg");
  });

  it("deduplicates so a repeat never burns a retry", () => {
    expect(
      videoThumbnailCandidates({
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        pageUrl: "https://youtu.be/dQw4w9WgXcQ",
      }),
    ).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]);
  });

  it("drops unwinnable schemes and non-http values from a supplied ladder", () => {
    expect(
      videoThumbnailCandidates({
        thumbnailCandidates: [
          "blob:https://x/uuid",
          "javascript:alert(1)",
          "ftp://cdn.example/a.png",
          "https://cdn.example/ok.jpg",
        ],
      }),
    ).toEqual(["https://cdn.example/ok.jpg"]);
  });

  it.each([
    ["a candidate with nothing", {}],
    ["a candidate whose only art is a blob poster", { thumbnailUrl: "blob:https://x/uuid" }],
    ["a candidate on an unknown host", { pageUrl: "https://x.test/p" }],
    ["null", null],
  ])("returns [] for %s", (_label, video) => {
    expect(videoThumbnailCandidates(video)).toEqual([]);
  });
});

describe("videoThumbnailUrl is the ladder's first entry", () => {
  it.each([
    [{ thumbnailUrl: "https://cdn.example/a.png" }, "https://cdn.example/a.png"],
    [{ poster: "http://cdn.example/a.png" }, "http://cdn.example/a.png"],
    [{ image: "https://cdn.example/a.png" }, "https://cdn.example/a.png"],
    // blob: is gone on purpose — an extension page cannot resolve a page-origin blob.
    [{ thumbnailUrl: "blob:https://x/uuid" }, ""],
    [{ thumbnailUrl: "data:image/png;base64,AAA" }, "data:image/png;base64,AAA"],
    [{ thumbnailUrl: "ftp://cdn.example/a.png" }, ""],
    [{ thumbnailUrl: "javascript:alert(1)" }, ""],
    [{ thumbnailUrl: "", poster: "https://cdn.example/b.png" }, "https://cdn.example/b.png"],
    [{ pageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"],
    [{}, ""],
    [null, ""],
  ])("videoThumbnailUrl(%j) === %j", (video, expected) => {
    expect(videoThumbnailUrl(video)).toBe(expected);
  });
});
