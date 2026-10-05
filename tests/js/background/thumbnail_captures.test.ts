/**
 * The service-worker half of the thumbnail ladder (thumbnail-spec.md §5, D10).
 *
 * The invariant these pin: a canvas frame capture is a `data:` URL, it is never on
 * the record that `tab_state.ts` persists, and it is re-attached only on the way out
 * to the popup. Everything here is module state, so the tab ids are the isolation.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  capturesFor,
  clearCaptures,
  rememberCaptures,
  withCaptures,
} from "../../../src/background/thumbnail_captures.js";
import { groupUniqueFullVideos, mergeVariant } from "../../../src/shared/video_sorting.js";
import type { VideoRecord } from "../../../src/background/types.js";

const CAPTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
/** An ffmpeg grab (`hls-thumbnail-spec.md` §4.1) — indistinguishable from `CAPTURE` by design. */
const GRAB = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAABAAD/";
const POSTER = "https://cdn.example/poster.jpg";

/** A `VideoRecord` shaped like what `addDetectedVideo` persists: no `data:` entry ever. */
function record(id: string, patch: Partial<VideoRecord> = {}): VideoRecord {
  return { id, url: `https://cdn.example/${id}.mp4`, format: "MP4", ...patch };
}

beforeEach(() => {
  // No teardown between runs is guaranteed by tab id alone, so clear both ids these
  // tests use rather than relying on a fresh module registry.
  clearCaptures(1);
  clearCaptures(2);
});

describe("rememberCaptures", () => {
  it("stashes the data: entry of a ladder and leaves the http(s) half out of memory", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [POSTER, CAPTURE] }]);
    expect(capturesFor(1, "v1")).toEqual([CAPTURE]);
  });

  it("stores nothing for a ladder that is all http(s)", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [POSTER, "https://cdn.example/derived.jpg"] }]);
    expect(capturesFor(1, "v1")).toEqual([]);
  });

  it("stores nothing for a candidate with no ladder, an id, or a candidates field", () => {
    rememberCaptures(1, [{}, { id: "v1" }, { id: "v2", thumbnailCandidates: [] }]);
    expect(capturesFor(1, "v1")).toEqual([]);
    expect(capturesFor(1, "v2")).toEqual([]);
  });

  it("returns [] for an unknown tab or an unknown video", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [CAPTURE] }]);
    expect(capturesFor(99, "v1")).toEqual([]);
    expect(capturesFor(1, "nope")).toEqual([]);
  });

  it("keeps two videos in one tab apart", () => {
    rememberCaptures(1, [
      { id: "v1", thumbnailCandidates: [CAPTURE] },
      { id: "v2", thumbnailCandidates: ["data:image/jpeg;base64,QkFTRTY0"] },
    ]);
    expect(capturesFor(1, "v1")).toEqual([CAPTURE]);
    expect(capturesFor(1, "v2")).toEqual(["data:image/jpeg;base64,QkFTRTY0"]);
  });
});

describe("withCaptures", () => {
  it("restores the capture at the END of the persisted ladder", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [POSTER, CAPTURE] }]);
    const merged = withCaptures(1, [record("v1", { thumbnailCandidates: [POSTER] })]);
    expect(merged[0].thumbnailCandidates).toEqual([POSTER, CAPTURE]);
  });

  it("leaves the record it is given untouched — the persisted copy has no data: URL", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [POSTER, CAPTURE] }]);
    const persisted = [record("v1", { thumbnailCandidates: [POSTER] })];
    withCaptures(1, persisted);
    expect(persisted[0].thumbnailCandidates).toEqual([POSTER]);
  });

  it("gives a capture-only row exactly its capture", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [CAPTURE] }]);
    expect(withCaptures(1, [record("v1")])[0].thumbnailCandidates).toEqual([CAPTURE]);
  });

  it("returns the same records when nothing is stashed for the tab", () => {
    const videos = [record("v1")];
    expect(withCaptures(1, videos)).toBe(videos);
  });

  it("does not duplicate a capture the record already carries", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [CAPTURE] }]);
    expect(withCaptures(1, [record("v1", { thumbnailCandidates: [POSTER, CAPTURE] })])[0].thumbnailCandidates).toEqual([
      POSTER,
      CAPTURE,
    ]);
  });

  it("keeps the capture reachable when the stored ladder is already at the cap", () => {
    // The regression that put this at index 1: `ui/format.ts` caps a supplied ladder at
    // THUMBNAIL_CANDIDATE_LIMIT, so appending a capture behind three http(s) entries put
    // it past the cut and the frame could never be reached.
    const full = [POSTER, "https://cdn.example/derived.jpg", "https://cdn.example/og.jpg"];
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [POSTER, CAPTURE] }]);
    expect(withCaptures(1, [record("v1", { thumbnailCandidates: full })])[0].thumbnailCandidates).toEqual([
      POSTER,
      CAPTURE,
      "https://cdn.example/derived.jpg",
      "https://cdn.example/og.jpg",
    ]);
  });

  it("keeps an ffmpeg frame reachable — the index-1 splice now has two producers", () => {
    // `hls-thumbnail-spec.md` §11: `withCaptures` splicing at index 1 is load-bearing for
    // *two* producers — the content script's canvas capture and `thumbnail_frames.ts`'s
    // host-side ffmpeg grab. The grab reaches here as the same `data:` URL through the
    // same `rememberCaptures`, so the cap case below is what keeps an HLS row's art from
    // being dropped whenever the stored ladder already holds three `http(s)` entries.
    const full = ["https://cdn.example/derived.jpg", "https://cdn.example/og.jpg", "https://cdn.example/site.jpg"];
    rememberCaptures(1, [{ id: "hls", thumbnailCandidates: [GRAB] }]);
    const ladder = withCaptures(1, [record("hls", { thumbnailCandidates: full })])[0].thumbnailCandidates || [];
    expect(ladder[1]).toBe(GRAB);
    // The popup slices a supplied ladder to THUMBNAIL_CANDIDATE_LIMIT; a capture at
    // index 1 survives that cut, which is the entire reason §5.2 needed no new code.
    expect(ladder.slice(0, 3)).toContain(GRAB);
  });
});

describe("clearCaptures", () => {
  it("empties one tab only", () => {
    rememberCaptures(1, [{ id: "v1", thumbnailCandidates: [CAPTURE] }]);
    rememberCaptures(2, [{ id: "v1", thumbnailCandidates: [CAPTURE] }]);
    clearCaptures(1);
    expect(capturesFor(1, "v1")).toEqual([]);
    expect(capturesFor(2, "v1")).toEqual([CAPTURE]);
  });
});

describe("grouping keeps a ladder", () => {
  const candidate = (patch: Record<string, unknown>) =>
    ({
      source: "dom-video",
      duration: 120,
      width: 1920,
      height: 1080,
      pageUrl: "https://site.example/watch",
      title: "Song",
      ...patch,
    }) as Parameters<typeof mergeVariant>[0];

  it("lifts a sibling variant's ladder when the representative has no art", () => {
    // The representative is picked on size and format, not on whether it brought art:
    // the 5MB `.mp4` outranks the `.m3u8` that is the only variant with a ladder.
    const grouped = groupUniqueFullVideos([
      candidate({ url: "https://cdn.example/video.mp4", sizeBytes: 5_000_000 }),
      candidate({ url: "https://cdn.example/stream.m3u8", thumbnailCandidates: [POSTER, CAPTURE] }),
    ]);
    expect((grouped[0] as { thumbnailCandidates?: string[] }).thumbnailCandidates).toEqual([POSTER, CAPTURE]);
  });

  it("keeps a re-detection's own ladder when it has one", () => {
    const merged = mergeVariant(
      candidate({ url: "https://cdn.example/a.mp4", thumbnailCandidates: [POSTER] }),
      candidate({ url: "https://cdn.example/a.mp4", thumbnailCandidates: [CAPTURE] }),
    ) as { thumbnailCandidates?: string[] };
    expect(merged.thumbnailCandidates).toEqual([CAPTURE]);
  });

  it("does not lose the earlier ladder when a re-detection brings none", () => {
    const merged = mergeVariant(
      candidate({ url: "https://cdn.example/a.mp4", thumbnailCandidates: [POSTER] }),
      candidate({ url: "https://cdn.example/a.mp4" }),
    ) as { thumbnailCandidates?: string[] };
    expect(merged.thumbnailCandidates).toEqual([POSTER]);
  });
});
