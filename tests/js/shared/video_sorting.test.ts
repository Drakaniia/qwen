import { describe, expect, it } from "vitest";

import {
  buildGroupedVideo,
  compareGroupedVideos,
  compareVariants,
  formatPriority,
  fullVideoPriority,
  groupedVideoSortKey,
  groupUniqueFullVideos,
  mergeVariant,
  videoSortKey,
} from "../../../src/shared/video_sorting.js";
import type { MediaCandidateLike } from "../../../src/shared/media_rules.js";

const PAGE = "https://site.example/watch";

/**
 * A minimal candidate that survives isLikelyFullLengthVideoCandidate.
 *
 * `buildGroupedVideo`'s seed slot is an *enriched* variant (every derived field filled
 * in), while these fixtures are pre-enrichment, so the return type is borrowed from the
 * function itself rather than restated here.
 */
type Seed = Parameters<typeof buildGroupedVideo>[0]["seed"];

const candidate = (patch: Record<string, unknown>): Seed =>
  ({
    source: "dom-video",
    duration: 120,
    width: 1920,
    height: 1080,
    pageUrl: PAGE,
    title: "Song",
    ...patch,
  }) as Seed;

describe("formatPriority", () => {
  it.each([
    ["YOUTUBE", 10],
    ["youtube", 10],
    ["M3U8", 8],
    ["MPD", 8],
    ["ISM", 8],
    ["PAGE", 6],
    ["MP4", 4],
    ["WEBM", 4],
    ["AUDIO", 3],
    ["mp3", 1],
    ["", 1],
    [undefined, 1],
    [null, 1],
  ])("formatPriority(%j) === %j", (format, expected) => {
    expect(formatPriority(format)).toBe(expected);
  });
});

describe("fullVideoPriority", () => {
  /** `video` is `unknown` because the last case is deliberately not a candidate at all. */
  const cases: [unknown, number][] = [
    [null, 0],
    [undefined, 0],
    [{ format: "YOUTUBE" }, 10],
    [{ format: "M3U8" }, 8],
    [{ format: "PAGE" }, 6],
    [{ format: "MP4" }, 0],
    [{ format: "AUDIO" }, 0],
    [{ format: "MP4", variants: [{ format: "M3U8" }] }, 8],
    [{ format: "MP4", variants: [{ format: "MP4" }] }, 0],
    [{ format: "MP4", variants: "not-an-array" }, 0],
  ];

  it.each(cases)("fullVideoPriority(%j) === %j", (video, expected) => {
    expect(fullVideoPriority(video as MediaCandidateLike)).toBe(expected);
  });
});

describe("sort keys", () => {
  it("videoSortKey ranks downloadable and full-video formats first", () => {
    const key = videoSortKey({ format: "MP4", downloadable: true, sizeBytes: 1000, height: 360 });
    expect(key[0]).toBe(1);
  });

  it("videoSortKey demotes sub-1MB non-stream artifacts to a size of 0", () => {
    const small = videoSortKey({ format: "MP4", downloadable: true, sizeBytes: 1000 });
    expect(small[2]).toBe(0);
  });

  it("reports 0 for small HLS manifests too — the isStreamFormat guard is redundant", () => {
    // numericVideoSize() already returns 0 for anything playlist-like, so the
    // `isStreamFormat` short-circuit in videoSortKey never changes the result.
    expect(videoSortKey({ format: "M3U8", downloadable: true, sizeBytes: 1000 })[2]).toBe(0);
  });

  it("groupedVideoSortKey has one more key than videoSortKey (duration)", () => {
    expect(groupedVideoSortKey({ format: "MP4" }).length).toBe(videoSortKey({ format: "MP4" }).length + 1);
  });

  it("compareVariants sorts larger first", () => {
    expect(
      compareVariants(
        { format: "MP4", downloadable: true, sizeBytes: 5000 },
        { format: "MP4", downloadable: true, sizeBytes: 50_000_000 },
      ),
    ).toBeGreaterThan(0);
  });

  it("compareVariants returns 0 for identical keys", () => {
    const v = { format: "MP4", downloadable: true, sizeBytes: 5000, height: 360 };
    expect(compareVariants(v, { ...v })).toBe(0);
  });

  it("compareGroupedVideos sorts larger first", () => {
    expect(
      compareGroupedVideos(
        { format: "MP4", downloadable: true, sizeBytes: 5000 },
        { format: "MP4", downloadable: true, sizeBytes: 50_000_000 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("mergeVariant", () => {
  it("keeps the existing thumbnail when the new one is empty", () => {
    expect(mergeVariant({ thumbnailUrl: "a" }, { thumbnailUrl: "" }).thumbnailUrl).toBe("a");
  });

  it("takes the new thumbnail when the existing one is empty", () => {
    expect(mergeVariant({ thumbnailUrl: "" }, { thumbnailUrl: "b" }).thumbnailUrl).toBe("b");
  });

  it("keeps the earliest firstSeen", () => {
    expect(mergeVariant({ firstSeen: 1 }, { firstSeen: 9 }).firstSeen).toBe(1);
  });

  it("falls back to next.firstSeen when existing is 0", () => {
    expect(mergeVariant({ firstSeen: 0 }, { firstSeen: 9 }).firstSeen).toBe(9);
  });

  it("takes the latest lastSeen", () => {
    expect(mergeVariant({ lastSeen: 5 }, { lastSeen: 3 }).lastSeen).toBe(5);
  });

  it("lets the new variant win on ordinary fields", () => {
    // `a`/`b` are not candidate fields at all — the point is that the merge spreads `next`.
    expect(
      mergeVariant({ a: 1 } as unknown as MediaCandidateLike, { a: 2, b: 3 } as unknown as MediaCandidateLike),
    ).toMatchObject({ a: 2, b: 3 });
  });
});

describe("buildGroupedVideo", () => {
  it("aggregates variant count and downloadability", () => {
    const grouped = buildGroupedVideo({
      id: "g1",
      seed: candidate({ url: "https://cdn.example/a.mp4" }),
      variants: [
        candidate({ url: "https://cdn.example/a.mp4", downloadable: true }),
        candidate({ url: "https://cdn.example/b.mp4", downloadable: false }),
      ],
    });
    expect(grouped.variantCount).toBe(2);
    expect(grouped.downloadable).toBe(true);
    expect(grouped.id).toBe("g1");
  });

  it("falls back to the largest variant size when the representative has none", () => {
    const grouped = buildGroupedVideo({
      id: "g1",
      seed: candidate({ url: "https://cdn.example/a.mp4" }),
      variants: [candidate({ url: "https://cdn.example/a.mp4", sizeBytes: 50_000_000 })],
    });
    expect(grouped.sizeBytes).toBe(50_000_000);
    expect(grouped.size).toBe("47.7 MB");
  });

  it("prefers the seed when there are no variants", () => {
    const seed = candidate({ url: "https://cdn.example/a.mp4" });
    const grouped = buildGroupedVideo({ id: "g1", seed, variants: [] });
    expect(grouped.variantCount).toBe(0);
    expect(grouped.url).toBe("https://cdn.example/a.mp4");
  });
});

describe("groupUniqueFullVideos", () => {
  it.each([
    ["empty array", []],
    ["null", null],
    ["undefined", undefined],
    ["non-array", "nope"],
  ])("returns [] for %s", (_label, input) => {
    expect(groupUniqueFullVideos(input)).toEqual([]);
  });

  it("drops non-candidates", () => {
    expect(groupUniqueFullVideos([candidate({ url: "https://cdn.example/a.js" })])).toEqual([]);
  });

  it("merges urls differing only by fragment into one variant", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/a.mp4#t=0" }),
      candidate({ url: "https://cdn.example/a.mp4#t=10" }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].variantCount).toBe(1);
  });

  it("keeps urls differing only by query as separate variants", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/a.mp4?token=1" }),
      candidate({ url: "https://cdn.example/a.mp4?token=2" }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].variantCount).toBe(2);
  });

  it("keeps every entry of one playlist as its own row", () => {
    // The reported bug. A yt-dlp flat enumeration gives one `watch?v=` entry per track,
    // all stamped with the same `playlistId` and the playlist URL as `pageUrl`, so the
    // page/stem heuristic read "same page, same stem (`watch`)" for every pair and folded
    // a 61-track paste into ONE row with 61 variants: the popup drew a folder captioned
    // "1 track" while the bar counted 61 selected ids that had no row to toggle.
    const playlist = "https://music.youtube.com/playlist?list=PLY5CT0";
    const track = (id: string) => ({
      id: `h_${id}`,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `Track ${id}`,
      pageUrl: playlist,
      source: "playlist",
      playlistId: playlist,
      playlistTitle: "High School Radio",
      downloadable: true,
      duration: 200,
      lastSeen: 100,
    });

    const grouped = groupUniqueFullVideos(Array.from({ length: 61 }, (_value, index) => track(`v${index}`)));

    expect(grouped).toHaveLength(61);
    expect(grouped.every((entry) => entry.variantCount === 1)).toBe(true);
    // All one folder, so the popup's `mediaRows` still folds them into a single row and
    // the header's count is the track count rather than 1.
    expect(new Set(grouped.map((entry) => (entry as { playlistId?: string }).playlistId))).toEqual(new Set([playlist]));
  });

  it("still folds a re-detection of one playlist track into that track's row", () => {
    // Identical urls are exempt from the playlist guard: that is the same track seen
    // twice, which is exactly what grouping is for.
    const playlist = "https://music.youtube.com/playlist?list=PLY5CT0";
    const entry = {
      id: "h_v0",
      url: "https://www.youtube.com/watch?v=v0",
      title: "Track v0",
      pageUrl: playlist,
      source: "playlist",
      playlistId: playlist,
      downloadable: true,
      duration: 200,
    };

    expect(groupUniqueFullVideos([entry, { ...entry, source: "dom-video" }])).toHaveLength(1);
  });

  it("groups distinct urls on the same page under one entry", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/video.mp4", sizeBytes: 5_000_000 }),
      candidate({ url: "https://cdn.example/stream.m3u8", format: "M3U8" }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].variantCount).toBe(2);
    expect(grouped[0].downloadable).toBe(true);
    expect(grouped[0].size).toBe("4.8 MB");
    expect(grouped[0].sizeBytes).toBe(5_000_000);
  });

  it("promotes the higher-priority format to the representative variant", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/video.mp4", format: "MP4", sizeBytes: 5_000_000 }),
      candidate({ url: "https://cdn.example/stream.m3u8", format: "M3U8" }),
    ]);
    expect(grouped[0].format).toBe("M3U8");
  });

  it("uses the explicit id when present, else the normalized url", () => {
    const grouped = groupUniqueFullVideos([candidate({ id: "vid-1", url: "https://cdn.example/a.mp4" })]);
    expect(grouped[0].id).toBe("vid-1");
  });

  it("derives the id from the url when there is none", () => {
    const grouped = groupUniqueFullVideos([candidate({ url: "https://cdn.example/a.mp4" })]);
    expect(grouped[0].id).toBe("https://cdn.example/a.mp4");
  });

  it("separates candidates from different pages", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/a.mp4", pageUrl: "https://a.example/p" }),
      candidate({ url: "https://cdn.example/b.mp4", pageUrl: "https://b.example/p" }),
    ]);
    expect(grouped).toHaveLength(2);
  });

  it("carries the group-wide firstSeen/lastSeen", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/video.mp4", firstSeen: 50, lastSeen: 100 }),
      candidate({ url: "https://cdn.example/stream.m3u8", firstSeen: 10, lastSeen: 20 }),
    ]);
    expect(grouped[0].firstSeen).toBe(10);
    expect(grouped[0].lastSeen).toBe(100);
  });

  it("lifts a thumbnail from any variant when the representative has none", () => {
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/video.mp4", sizeBytes: 5_000_000 }),
      candidate({ url: "https://cdn.example/stream.m3u8", thumbnailUrl: "https://cdn.example/t.jpg" }),
    ]);
    expect(grouped[0].thumbnailUrl).toBe("https://cdn.example/t.jpg");
  });

  it("sorts downloadable full-video groups ahead of audio groups", () => {
    const grouped = groupUniqueFullVideos([
      candidate({
        url: "https://cdn.example/song.mp3",
        format: "AUDIO",
        pageUrl: "https://site.example/song",
        title: "Track",
      }),
      candidate({ url: "https://cdn.example/a.mp4", pageUrl: "https://site.example/movie" }),
    ]);
    expect(grouped.map((g) => g.format)).toEqual(["MP4", "AUDIO"]);
  });
});
