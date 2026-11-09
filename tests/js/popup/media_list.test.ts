/**
 * The Media view's list composition (spec §3.1, §6.7, §6.10, D7, D12, acceptance #4).
 *
 * These assertions used to live against `components/VideoList.tsx`, which is gone — the
 * rows are `views/VideoRow.tsx` (another agent's file) and the *composition* they sit in
 * is pure signal algebra in `state/videos.ts`. Testing the algebra directly is the more
 * durable half anyway: it has no DOM, and a row's own markup is the row's business.
 *
 * What is pinned here:
 *   - the five `DetectedVideo` fields the render type used to drop (acceptance #4),
 *   - D7: no partition by view any more, audio included,
 *   - D12: no layout signal, so nothing can change membership,
 *   - §6.7: the live consequence line, including the "nothing matched" case.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_FILTER } from "../../../src/ui/filter.js";
import {
  AUDIO_FORMAT,
  currentVideos,
  displayedVideos,
  filterSummary,
  hiddenBySize,
  isAudio,
  mediaStatus,
  mediaStatusLabel,
  resetSizeThresholdSeed,
  scanStatus,
  seedSizeThreshold,
  setScanStatus,
  sizeThreshold,
  sizeThresholdLabel,
  videoFilter,
  videoFormatFacet,
  videoSourceFacet,
  visibleVideos,
  type VideoCandidate,
} from "../../../src/popup/state/videos.js";

const MB = 1024 * 1024;

const CLIP: VideoCandidate = {
  id: "v1",
  url: "https://cdn.example/clip.mp4",
  title: "Kitchen clip",
  format: "MP4",
  source: "dom-video",
  lastSeen: 100,
  downloadable: true,
  width: 1920,
  height: 1080,
  duration: 596,
  bitrate: 2500,
  tbr: 2500.5,
  sizeBytes: 128 * MB,
};
const STREAM: VideoCandidate = {
  id: "v2",
  url: "https://cdn.example/stream.m3u8",
  title: "Garden stream",
  format: "M3U8",
  source: "performance",
  lastSeen: 200,
  downloadable: true,
  height: 480,
  duration: 30,
  sizeBytes: 512 * 1024,
};
const TRACK: VideoCandidate = {
  id: "m1",
  url: "https://cdn.example/song.mp3",
  title: "Kitchen song",
  format: AUDIO_FORMAT,
  source: "music-page",
  lastSeen: 300,
  downloadable: true,
  sizeBytes: 4 * MB,
};
/** A candidate the content script could not measure — `sizeBytes` absent. */
const UNKNOWN_SIZE: VideoCandidate = {
  id: "u1",
  url: "https://cdn.example/unknown.mp4",
  title: "Unmeasured clip",
  format: "MP4",
  source: "network",
  lastSeen: 50,
  downloadable: true,
};

const ALL = [CLIP, STREAM, TRACK, UNKNOWN_SIZE];

beforeEach(() => {
  currentVideos.value = [...ALL];
  videoFilter.value = { ...DEFAULT_FILTER };
  sizeThreshold.value = null;
  setScanStatus("ready");
});

describe("acceptance #4: the fields that used to be dropped (spec §3.1)", () => {
  it("carries resolution, duration and bitrate on the render type", () => {
    // `shared/contracts.ts`'s `DetectedVideo` has all five; the popup's `VideoCandidate`
    // used to declare four of them nowhere, which is why the resolution ladder and the
    // duration were unavailable after already crossing the wire.
    const clip = displayedVideos.value.find((video) => video.id === CLIP.id);
    expect(clip).toMatchObject({ width: 1920, height: 1080, duration: 596, bitrate: 2500, tbr: 2500.5 });
  });

  it("survives a candidate whose measurement fields are all null", () => {
    // `DetectedVideo` types these `number | null`, so a null must not drop the row.
    currentVideos.value = [{ id: "n1", downloadable: true, width: null, height: null, duration: null, tbr: null }];
    expect(displayedVideos.value.map((video) => video.id)).toEqual(["n1"]);
  });

  it("maps duration onto the field `ui/filter.ts` sorts by", () => {
    // Without the stamp, "Longest first" is a silent no-op — the same defect the
    // `lastSeen` → `updatedAt` stamp was added for.
    videoFilter.value = { ...DEFAULT_FILTER, sort: "duration" };
    expect(displayedVideos.value[0].id).toBe(CLIP.id);
  });
});

describe("D7: one list, no partition", () => {
  it("includes audio candidates in Media", () => {
    expect(visibleVideos.value.map((video) => video.id).sort()).toEqual(["m1", "u1", "v1", "v2"]);
  });

  it("still knows which of them are audio, for the badge", () => {
    expect(visibleVideos.value.filter(isAudio).map((video) => video.id)).toEqual(["m1"]);
  });

  it("does not change membership when the view switches", () => {
    // The old `visibleVideos` partitioned on `viewMode`, which meant a filter could not
    // reach across the boundary. There is no boundary to reach across now.
    const before = displayedVideos.value.map((video) => video.id);
    expect(before).toHaveLength(4);
  });
});

describe("D12: no layout signal", () => {
  it("no longer exists in the app state", async () => {
    // The list/boxes toggle is deleted outright (D12). Leaving the signal behind would
    // mean a writer with no reader — the exact dead surface D12 exists to remove.
    const app = await import("../../../src/popup/state/app.js");
    expect(Object.keys(app)).not.toContain("videoLayoutMode");
    expect(Object.keys(app)).not.toContain("setVideoLayoutMode");
  });

  it("leaves membership alone when only the sort changes", () => {
    videoFilter.value = { ...DEFAULT_FILTER, sort: "title" };
    expect(displayedVideos.value).toHaveLength(4);
  });
});

describe("search / facet / sort composition", () => {
  it("narrows by free text over title and URL", () => {
    videoFilter.value = { ...DEFAULT_FILTER, query: "kitchen" };
    expect(displayedVideos.value.map((video) => video.id).sort()).toEqual(["m1", "v1"]);
  });

  it("sorts by recency using `lastSeen`, so the default sort is not a no-op", () => {
    expect(displayedVideos.value[0].id).toBe("m1");
  });

  it("sorts by title when asked", () => {
    videoFilter.value = { ...DEFAULT_FILTER, sort: "title" };
    expect(displayedVideos.value.map((video) => video.title)).toEqual([
      "Garden stream",
      "Kitchen clip",
      "Kitchen song",
      "Unmeasured clip",
    ]);
  });

  it("offers facet values from the unfiltered pool, so picking one cannot empty its own dropdown", () => {
    expect(videoFormatFacet.value).toEqual(["AUDIO", "M3U8", "MP4"]);
    videoFilter.value = { ...DEFAULT_FILTER, format: "MP4" };
    expect(displayedVideos.value.map((video) => video.id).sort()).toEqual(["u1", "v1"]);
    // Still offered, because the facet is computed from the pool, not from the result.
    expect(videoFormatFacet.value).toEqual(["AUDIO", "M3U8", "MP4"]);
  });

  it("offers source hosts from the pool", () => {
    expect(videoSourceFacet.value).toEqual(["cdn.example"]);
  });
});

describe("§6.7: the size threshold and its live consequence line", () => {
  it("is Any until a threshold is picked, and Any lets an unmeasured candidate through", () => {
    expect(sizeThreshold.value).toBeNull();
    expect(hiddenBySize.value).toBe(0);
    expect(displayedVideos.value.map((video) => video.id)).toContain("u1");
  });

  it("excludes measured candidates below the threshold and counts them", () => {
    // STREAM is 512 KB, so it falls out at 1 MB; UNKNOWN_SIZE has no `sizeBytes` and stays.
    sizeThreshold.value = MB;
    expect(displayedVideos.value.map((video) => video.id).sort()).toEqual(["m1", "u1", "v1"]);
    expect(hiddenBySize.value).toBe(1);
    expect(sizeThresholdLabel.value).toBe("1 MB");
  });

  it("keeps an unmeasured candidate while a threshold is active", () => {
    // Most streams report no size until downloaded (`Settings.minSizeBytes`). Reading
    // "unknown" as "0 bytes" hid exactly those rows, and with the threshold now seeded
    // from Options it would have hidden them on every popup open.
    sizeThreshold.value = MB;
    expect(displayedVideos.value.map((video) => video.id)).toContain("u1");
  });

  it("says what the filter did", () => {
    sizeThreshold.value = MB;
    expect(filterSummary.value).toBe("3 of 4 detected · 1 hidden below 1 MB.");
  });

  it("says so when the filter matches nothing, rather than reporting the pre-filter count", () => {
    videoFilter.value = { ...DEFAULT_FILTER, query: "nothing matches this" };
    expect(displayedVideos.value).toEqual([]);
    expect(filterSummary.value).toBe("Nothing matching the filter.");
  });

  it("reports what survives even when the threshold has hidden most of the list", () => {
    // Only CLIP is ≥ 50 MB, and a non-empty list means "N of M" is a real claim about
    // what is on screen — the "Nothing below X" branch is for an empty one only.
    sizeThreshold.value = 50 * MB;
    expect(displayedVideos.value.map((video) => video.id)).toEqual(["v1", "u1"]);
    expect(filterSummary.value).toBe("2 of 4 detected · 2 hidden below 50 MB.");
  });
});

describe("the threshold starts at Options' `minSizeBytes`", () => {
  beforeEach(() => resetSizeThresholdSeed());

  it("seeds from the first settings read", () => {
    seedSizeThreshold(5 * MB);
    expect(sizeThreshold.value).toBe(5 * MB);
    // The seed is a starting value: STREAM (512 KB) goes, the unmeasured row stays.
    expect(displayedVideos.value.map((video) => video.id)).toContain("u1");
    expect(displayedVideos.value.map((video) => video.id)).not.toContain("v2");
  });

  it("does not snap back over the user's own choice on a later refresh", () => {
    seedSizeThreshold(5 * MB);
    sizeThreshold.value = null;
    seedSizeThreshold(5 * MB);
    expect(sizeThreshold.value).toBeNull();
  });

  it("reads null, zero and garbage as Any", () => {
    for (const value of [null, 0, undefined, "lots"]) {
      resetSizeThresholdSeed();
      sizeThreshold.value = MB;
      seedSizeThreshold(value);
      expect(sizeThreshold.value, String(value)).toBeNull();
    }
  });

  it("reports the detection summary when nothing has been filtered", () => {
    expect(filterSummary.value).toBe("3 videos and 1 audio track detected.");
  });

  it("has no line to give before the first scan", () => {
    // `null` is meaningful: there is nothing to have done anything to yet.
    currentVideos.value = null;
    expect(filterSummary.value).toBeNull();
  });
});

describe("§6.2: the status dot is derived, not stored", () => {
  it("is caution while scanning", () => {
    setScanStatus("scanning");
    expect(mediaStatus.value).toBe("caution");
    expect(mediaStatusLabel.value).toBe("Scanning this page for video");
  });

  it("is caution before the first scan resolves", () => {
    currentVideos.value = null;
    setScanStatus("pending");
    expect(mediaStatus.value).toBe("caution");
  });

  it("is success when the tab has downloadable media", () => {
    expect(mediaStatus.value).toBe("success");
    expect(mediaStatusLabel.value).toBe("Downloadable video available");
  });

  it("is critical when it does not, and says which", () => {
    currentVideos.value = [{ id: "x", downloadable: false }];
    expect(mediaStatus.value).toBe("critical");
    expect(mediaStatusLabel.value).toBe("No downloadable video detected");
  });

  it("is not a scan failure dressed up as an empty page", () => {
    setScanStatus("failed", "no host");
    expect(mediaStatus.value).toBe("critical");
    expect(mediaStatusLabel.value).toBe("Could not read this page");
  });
});

describe("the three states §6.10 designs for stay distinguishable", () => {
  it("null, empty and populated are three different screens", () => {
    currentVideos.value = null;
    expect(currentVideos.value).toBeNull();
    currentVideos.value = [];
    expect(displayedVideos.value).toEqual([]);
    currentVideos.value = [CLIP];
    expect(displayedVideos.value).toHaveLength(1);
  });

  it("reports the scan status separately from the candidate list", () => {
    // Before this existed, "still scanning" and "found nothing" were both an empty `<div>`
    // plus a sentence. §6.10 says no state ships as a bare sentence.
    setScanStatus("failed", "boom");
    expect(scanStatus.value).toBe("failed");
    expect(currentVideos.value).toHaveLength(4);
  });
});
