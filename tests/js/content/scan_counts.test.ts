/**
 * Phase 8 candidate-count instrumentation (spec §5 Phase 8, D12 — "measurement first").
 *
 * Two things are pinned, because the p99 they exist to produce can only be read off a
 * real browser and this file is the only automated proof that the number is real:
 *
 *   1. `page_detection.js` counts a discovery *per candidate handed over*, before the
 *      `seenUrls` collapse — so a repeat is counted twice and appears once.
 *   2. `content.js` emits one `[<epochMs>] [INFO] candidate-count ...` line per scan,
 *      in `logs/debug.log`'s own shape.
 *
 * The end-to-end case imports the real content script and fires a real scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as videoFilters from "../../../src/shared/video_filters.js";
import { create, type VideoCandidate } from "../../../src/content/page_detection.js";

describe("scan counter", () => {
  it("counts every discovery, not every distinct URL", () => {
    const scanStats = { discovered: 0 };
    const detection = create({ document, location, videoFilters, seenUrls: new Map(), scanStats });
    const candidates: VideoCandidate[] = [];

    detection.addCandidate(candidates, "https://cdn.example/a.mp4", "dom-video", "video/mp4");
    detection.addCandidate(candidates, "https://cdn.example/a.mp4", "dom-video", "video/mp4");
    detection.addCandidate(candidates, "https://cdn.example/b.mp4", "dom-video", "video/mp4");

    // Three discoveries, two URLs: `seenUrls` is what collapses the repeat.
    expect(scanStats.discovered).toBe(3);
    expect(candidates).toHaveLength(2);
  });

  it("resets with the caller's object, so a second scan starts from zero", () => {
    const scanStats = { discovered: 0 };
    const detection = create({ document, location, videoFilters, seenUrls: new Map(), scanStats });

    detection.addCandidate([], "https://cdn.example/a.mp4", "dom-video", "video/mp4");
    scanStats.discovered = 0;
    detection.addCandidate([], "https://cdn.example/a.mp4", "dom-video", "video/mp4");

    expect(scanStats.discovered).toBe(1);
  });

  it("counts nothing for a URL the filters reject", () => {
    const scanStats = { discovered: 0 };
    const detection = create({ document, location, videoFilters, seenUrls: new Map(), scanStats });

    detection.addCandidate([], "https://ads.example/pixel.gif", "performance", "image/gif");

    expect(scanStats.discovered).toBe(0);
  });
});

const LINE = /^\[\d{10,}\] \[INFO\] candidate-count host=\S+ discovered=\d+ unique=\d+$/;

describe("scan count logging", () => {
  let lines: string[];

  beforeEach(() => {
    document.body.innerHTML = `
      <video src="https://cdn.example/clip.mp4"></video>
      <script>window.cfg = { hls: "https://cdn.example/live/master.m3u8" };</script>
      <script>window.cfg2 = { hls: "https://cdn.example/live/master.m3u8" };</script>
      <script>window.cfg3 = { hls: "https://cdn.example/live/other.m3u8" };</script>
    `;
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("emits one line per scan, in logs/debug.log's shape", async () => {
    await import("../../../src/content/content.js");

    // `start()` kicks off a scan of its own once its `getSettings` round-trip
    // settles. Let it land, then clear, so this assertion is about the scan asked
    // for below and not about which one happened to finish first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    lines = [];

    window.dispatchEvent(new window.Event("qwin-video-scan-now"));

    const scanLines = lines.filter((line) => line.includes("candidate-count"));
    expect(scanLines).toHaveLength(1);
    expect(scanLines[0]).toMatch(LINE);

    // Printed so `npm test` output shows the real format rather than only asserting it.
    console.info(`scan-count line: ${scanLines[0]}`);

    // The repeated HLS URL is discovered by more than one scanner and survives once,
    // so `discovered` must exceed `unique` on this fixture.
    const fields = Object.fromEntries(
      scanLines[0]
        .split(" ")
        .slice(3)
        .map((pair) => pair.split("=")),
    );
    expect(Number(fields.discovered)).toBeGreaterThan(Number(fields.unique));
    expect(Number(fields.unique)).toBe(3);
  });
});
