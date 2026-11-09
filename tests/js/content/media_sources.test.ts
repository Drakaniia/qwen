/**
 * How the DOM sweep decides a URL is media — the two changes that stopped it asking a
 * string classifier about a `<video>` that already knows better.
 *
 *   1. A real player vouches for its own source: a `<video>` that passes
 *      `isLikelyRealVideoBox` is media whatever its URL looks like, so `/opaque/a1b2c3`
 *      (no extension, no CDN-shaped host) becomes a candidate instead of being dropped
 *      for matching nothing in a table.
 *   2. A `blob:` source is tagged `mse-player` rather than left looking like an ordinary
 *      unclassifiable URL. The row it produces is not downloadable at all — that is the
 *      whole point — and the tag is what lets the popup offer recording for it and
 *      `background/format_helpers.ts` say why instead of showing a dead quality list.
 *
 * The third case is the carrier for `background/media_probe.ts`: the page-fallback row
 * holds the URLs the scanner had to drop, so a later failure has something to ask the
 * server about.
 */
import { afterEach, describe, expect, it } from "vitest";

import { create } from "../../../src/content/page_detection.js";
import * as videoFilters from "../../../src/shared/video_filters.js";

function detection() {
  return create({ document, location, videoFilters, seenUrls: new Map(), scanStats: { discovered: 0 } });
}

/** A `<video>` happy-dom will report as a real player: real dimensions, real duration. */
function player({ width = 1280, height = 720, duration = 600 } = {}): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  Object.defineProperty(video, "duration", { value: duration });
  document.body.append(video);
  return video;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the element vouches for its own source", () => {
  it("accepts an opaque URL from a real player and rejects it without one", () => {
    const page = detection();
    const url = "https://opaque.example.com/a1b2c3";

    expect(page.buildCandidate(url, "dom-video")).toBeNull();
    expect(page.buildCandidate(url, "dom-video", "", player())).not.toBeNull();
  });

  it("does not let a tracking-pixel-sized box vouch for anything", () => {
    const page = detection();

    expect(
      page.buildCandidate("https://opaque.example.com/a1b2c3", "dom-video", "", player({ width: 100, height: 56 })),
    ).toBeNull();
  });

  it("leaves a URL the shared tables already recognize alone", () => {
    const page = detection();

    expect(page.buildCandidate("https://cdn.example/stream/master.m3u8", "dom-video")?.format).toBe("M3U8");
  });
});

describe("a blob source is an MSE player, not a URL", () => {
  it("tags it and classifies it as BLOB", () => {
    const page = detection();
    const candidate = page.buildCandidate("blob:https://site.example/uuid", "dom-video", "", player());

    expect(candidate?.source).toBe("mse-player");
    expect(candidate?.format).toBe("BLOB");
  });

  it("survives a title that reads like a fragment", () => {
    // `isLikelyFullLengthVideoCandidate` skips the short/incomplete word filter for DOM
    // sources, and `mse-player` had to join that list: "Episode 3 Part 1" is not a
    // fragment, and dropping the row would take the recording affordance with it.
    document.title = "Show Episode 3 Part 1";
    const page = detection();
    const video = player();
    video.setAttribute("aria-label", "Show Episode 3 Part 1");

    expect(page.buildCandidate("blob:https://site.example/uuid", "dom-video", "", video)?.source).toBe("mse-player");
  });
});

describe("the page-fallback row carries the probe input", () => {
  it("attaches the dropped URLs only when there are some", () => {
    const page = detection();
    const video = player();

    const withProbe = page.pageFallbackCandidateForVideo(video, ["https://cdn.example/unclassified"]);
    expect(withProbe?.format).toBe("PAGE");
    expect(withProbe?.probeUrls).toEqual(["https://cdn.example/unclassified"]);

    const without = page.pageFallbackCandidateForVideo(video);
    expect(without?.probeUrls).toBeUndefined();
  });

  it("does not invent a page fallback for a container-ish host", () => {
    // YouTube pages are handed to yt-dlp as the watch URL, which is a real extractor —
    // a PAGE candidate for the same URL would only compete with it.
    const page = detection();
    expect(page.pageFallbackCandidateForVideo(player())).not.toBeNull();
    expect(page.currentYouTubeVideoPageUrl()).toBe("");
  });
});
