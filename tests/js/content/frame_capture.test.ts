/**
 * Canvas frame capture and the content-script half of the thumbnail ladder
 * (spec `thumbnail-spec.md` §3 and §5).
 *
 * The interesting part is not that the capture works — that is the browser's job —
 * but that it happens **once per element** and that a candidate carries the whole
 * ordered ladder. Both are asserted here, plus the failure modes a content script
 * must survive silently: no decoded frame yet, and a cross-origin frame whose canvas
 * taints.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { captureFrame } from "../../../src/content/frame_capture.js";
import { create, type VideoCandidate } from "../../../src/content/page_detection.js";
import * as videoFilters from "../../../src/shared/video_filters.js";

const FRAME = "data:image/jpeg;base64,ZnJhbWU=";
const HAVE_CURRENT_DATA = 2;

interface FakeVideoOptions {
  width?: number;
  height?: number;
  readyState?: number;
  poster?: string;
}

/** A `<video>` with the media properties happy-dom does not model. Configurable, so a test can re-arm it mid-life. */
function fakeVideo({ width = 640, height = 360, readyState = HAVE_CURRENT_DATA, poster = "" }: FakeVideoOptions = {}) {
  const video = document.createElement("video");
  video.setAttribute("poster", poster);
  Object.defineProperties(video, {
    videoWidth: { value: width, configurable: true },
    videoHeight: { value: height, configurable: true },
    readyState: { value: readyState, configurable: true },
  });
  return video;
}

describe("captureFrame", () => {
  let toDataURL: ReturnType<typeof vi.spyOn>;
  let canvases: HTMLCanvasElement[];

  beforeEach(() => {
    canvases = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    });
    toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(FRAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("returns a JPEG data URL for a decoded frame", () => {
    expect(captureFrame(fakeVideo())).toBe(FRAME);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.6);
  });

  it('returns "" when the video has no frame yet (sized 0×0)', () => {
    expect(captureFrame(fakeVideo({ width: 0, height: 0 }))).toBe("");
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('returns "" below HAVE_CURRENT_DATA, without a timer or a retry', () => {
    expect(captureFrame(fakeVideo({ readyState: HAVE_CURRENT_DATA - 1 }))).toBe("");
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("captures an element once, however many scanners re-hand it over", () => {
    const video = fakeVideo();

    expect(captureFrame(video)).toBe(FRAME);
    expect(captureFrame(video)).toBe("");
    expect(captureFrame(video)).toBe("");

    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it("still captures a different element", () => {
    captureFrame(fakeVideo());
    captureFrame(fakeVideo());

    expect(toDataURL).toHaveBeenCalledTimes(2);
  });

  it("swallows a tainted canvas and reports no frame", () => {
    toDataURL.mockImplementation(() => {
      throw new Error("SecurityError: tainted canvas");
    });

    expect(captureFrame(fakeVideo())).toBe("");
  });

  it("scales the longest edge to 160px, preserving aspect ratio", () => {
    captureFrame(fakeVideo({ width: 1280, height: 720 }));

    expect(canvases[0].width).toBe(160);
    expect(canvases[0].height).toBe(90);
  });

  it("does not upscale a source smaller than 160px", () => {
    captureFrame(fakeVideo({ width: 80, height: 60 }));

    expect(canvases[0].width).toBe(80);
    expect(canvases[0].height).toBe(60);
  });

  it("leaves the page's own element untouched (no crossOrigin, spec §5)", () => {
    const video = fakeVideo();

    captureFrame(video);

    expect(video.getAttribute("crossorigin")).toBeNull();
    expect(video.crossOrigin).toBeNull();
  });

  it("reports no frame when the canvas has no 2d context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    expect(captureFrame(fakeVideo())).toBe("");
    expect(toDataURL).not.toHaveBeenCalled();
  });
});

/** `page_detection.js` reads the location off the injected option, not the global. */
function detectionAt(href: string) {
  return create({
    document,
    location: { href } as Location,
    videoFilters,
    seenUrls: new Map(),
  });
}

function ladderFor(detection: ReturnType<typeof detectionAt>, video: HTMLVideoElement | null): string[] {
  const candidate = detection.buildCandidate("https://cdn.example/clip.mp4", "dom-video", "video/mp4", video);
  return candidate?.thumbnailCandidates || [];
}

describe("thumbnailCandidates ladder (spec §3, D12)", () => {
  // The derived URL is asserted as `thumbnail_sources.js` spells it (`vumbnail.com`,
  // per spec §4), not as the host a reader might expect — the derivation table itself
  // is `tests/js/ui/thumbnail.test.ts`'s business, not this file's.
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(FRAME);
    document.body.innerHTML = '<meta property="og:image" content="https://cdn.example/hero.jpg">';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("1. poster beats the captured frame", () => {
    const ladder = ladderFor(
      detectionAt("https://vimeo.com/12345678"),
      fakeVideo({ poster: "https://cdn.example/p.jpg" }),
    );

    expect(ladder[0]).toBe("https://cdn.example/p.jpg");
    expect(ladder[1]).toBe(FRAME);
  });

  it("2. a captured frame beats the site-derived art (D12a)", () => {
    const ladder = ladderFor(detectionAt("https://vimeo.com/12345678"), fakeVideo());

    expect(ladder[0]).toBe(FRAME);
    expect(ladder).toContain("https://vumbnail.com/12345678.jpg");
  });

  it("3. site-derived art beats page metadata", () => {
    // No decoded frame, so the ladder starts at tier 3 rather than tier 2.
    const ladder = ladderFor(detectionAt("https://vimeo.com/12345678"), fakeVideo({ readyState: 0 }));

    expect(ladder[0]).toBe("https://vumbnail.com/12345678.jpg");
    expect(ladder[1]).toBe("https://cdn.example/hero.jpg");
  });

  it("caps the ladder at three entries even when all four tiers exist", () => {
    const ladder = ladderFor(
      detectionAt("https://vimeo.com/12345678"),
      fakeVideo({ poster: "https://cdn.example/p.jpg" }),
    );

    expect(ladder).toEqual(["https://cdn.example/p.jpg", FRAME, "https://vumbnail.com/12345678.jpg"]);
  });

  it("dedupes an og:image that is the same file as the derived art", () => {
    document.body.innerHTML = '<meta property="og:image" content="https://vumbnail.com/12345678.jpg">';

    const ladder = ladderFor(detectionAt("https://vimeo.com/12345678"), fakeVideo({ readyState: 0 }));

    expect(ladder).toEqual(["https://vumbnail.com/12345678.jpg"]);
  });

  it("gives a candidate with no element the site and page tiers", () => {
    const ladder = ladderFor(detectionAt("https://youtu.be/dQw4w9WgXcQ"), null);

    expect(ladder).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "https://cdn.example/hero.jpg"]);
  });

  it("gives an unknown host only the page tier", () => {
    const ladder = ladderFor(detectionAt("https://news.example/article"), null);

    expect(ladder).toEqual(["https://cdn.example/hero.jpg"]);
  });

  it("keeps thumbnailUrl as the head of the ladder for the existing callers", () => {
    const detection = detectionAt("https://vimeo.com/12345678");
    const candidate = detection.buildCandidate("https://cdn.example/clip.mp4", "dom-video", "video/mp4", fakeVideo());

    expect(candidate?.thumbnailUrl).toBe(FRAME);
    expect(candidate?.thumbnailUrl).toBe(candidate?.thumbnailCandidates?.[0]);
  });

  it("re-emits a candidate whose frame only became capturable on a later scan", () => {
    // Without the ladder in `candidateMetadataSignature` the second scan looks
    // unchanged and the popup never learns the capture exists.
    const detection = detectionAt("https://vimeo.com/12345678");
    const video = fakeVideo({ readyState: 0 });
    const candidates: VideoCandidate[] = [];

    detection.addCandidate(candidates, "https://cdn.example/clip.mp4", "dom-video", "video/mp4", video);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].thumbnailCandidates).not.toContain(FRAME);

    Object.defineProperty(video, "readyState", { value: HAVE_CURRENT_DATA, configurable: true });
    detection.addCandidate(candidates, "https://cdn.example/clip.mp4", "dom-video", "video/mp4", video);

    expect(candidates).toHaveLength(2);
    expect(candidates[1].thumbnailCandidates).toContain(FRAME);
  });
});

/**
 * The two content-script halves of `hls-thumbnail-spec.md` §3.
 *
 * These import the real `content.js` instead of calling `captureFrame` directly, because
 * both halves are about *when* an attempt happens — what one attempt does is pinned above.
 * `scan_counts.test.ts` sets the precedent for importing the module under test.
 */
describe("content-script capture retry (hls-thumbnail-spec.md §3)", () => {
  const HLS_URL = "https://cdn.example/live/master.m3u8";
  type ContentListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown;

  let toDataURL: ReturnType<typeof vi.spyOn>;
  let contentListener: ContentListener;

  beforeAll(async () => {
    // Module side effect: `content.js` registers its `runtime.onMessage` listener at
    // import, and vitest caches the module, so the listener is read exactly once. This
    // has to be a `beforeAll`, not a `beforeEach` — `vitest.setup.ts`'s `resetChromeMocks`
    // empties `addListener.mock.calls` before every test.
    await import("../../../src/content/content.js");
    contentListener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as ContentListener;
  });

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(FRAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** An MSE/HLS player as the content script first meets it: `readyState` 0, no poster. */
  function hlsPlayer({ readyState = 0 } = {}) {
    const video = document.createElement("video");
    video.src = HLS_URL;
    Object.defineProperties(video, {
      videoWidth: { value: 0, configurable: true },
      videoHeight: { value: 0, configurable: true },
      readyState: { value: readyState, configurable: true },
    });
    document.body.appendChild(video);
    return video;
  }

  /** The player has a decoded frame now, however long after the scan first met it. */
  function decodeFrame(video: HTMLVideoElement) {
    Object.defineProperties(video, {
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 360, configurable: true },
      readyState: { value: HAVE_CURRENT_DATA, configurable: true },
    });
  }

  /** One MutationObserver turn plus `scheduleScan`'s 250ms debounce. */
  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 400));
  }

  /** Every `contentDetectedVideos` payload the script has sent, oldest first. */
  function emittedLadders(): string[][] {
    type Detected = { type: string; videos?: { url: string; thumbnailCandidates?: string[] }[] };
    return vi
      .mocked(chrome.runtime.sendMessage)
      .mock.calls.map(([message]) => message as unknown as Detected)
      .filter((message) => message.type === "contentDetectedVideos")
      .map((message) => message.videos?.find((video) => video.url === HLS_URL)?.thumbnailCandidates || []);
  }

  function rescanForFrames() {
    contentListener({ type: "rescanForFrames" }, {}, () => undefined);
  }

  it("§3.1 captures once across loadeddata, playing and seeked", async () => {
    const video = hlsPlayer();
    await settle();

    // The reported bug: at scan time the frame has not decoded, so the capture rung
    // bails and the ladder is empty.
    expect(toDataURL).not.toHaveBeenCalled();

    decodeFrame(video);
    for (const eventName of ["loadeddata", "playing", "seeked"]) {
      video.dispatchEvent(new Event(eventName));
    }
    await settle();

    // Three events, one draw — `captureFrame`'s own `attempted` WeakSet.
    expect(toDataURL).toHaveBeenCalledTimes(1);
    // …and one of the scans it triggered carried the capture up to the background,
    // where `rememberCaptures` stashes it and `candidateMetadataSignature` re-emits it.
    expect(emittedLadders().some((ladder) => ladder.includes(FRAME))).toBe(true);
  });

  it("§3.1 draws nothing more when the player fires the events again", async () => {
    const video = hlsPlayer();
    decodeFrame(video);
    await settle();

    for (const eventName of ["loadeddata", "playing", "seeked", "loadeddata", "playing"]) {
      video.dispatchEvent(new Event(eventName));
    }
    await settle();

    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it("§3.1 treats a bare scrub as a capture trigger", async () => {
    // The one event of §3.1's three the pre-existing watcher list did not carry, and
    // the only one a `preload="none"` player can reach without ever firing `play`.
    const video = hlsPlayer();
    await settle();

    decodeFrame(video);
    video.dispatchEvent(new Event("seeked"));
    await settle();

    expect(toDataURL).toHaveBeenCalledTimes(1);
  });

  it("§3.2 re-emits the candidate with the data URL once a frame exists", async () => {
    const video = hlsPlayer();
    await settle();
    expect(emittedLadders().at(-1)).not.toContain(FRAME);

    decodeFrame(video);
    // Synchronous, so the script's own 3s interval cannot land in between and capture
    // the frame first — that is what makes this the handler's doing.
    rescanForFrames();

    expect(emittedLadders().at(-1)).toEqual([FRAME]);
  });

  it("§3.2 re-sends the same ladder for a video with no frame yet", async () => {
    hlsPlayer();
    await settle();
    const before = vi.mocked(chrome.runtime.sendMessage).mock.calls.length;

    rescanForFrames();

    expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.length).toBeGreaterThan(before);
    expect(emittedLadders().every((ladder) => !ladder.includes(FRAME))).toBe(true);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("§3.2 does not answer the message — the popup never waits on it", () => {
    hlsPlayer();
    const sendResponse = vi.fn();

    const result = contentListener({ type: "rescanForFrames" }, {}, sendResponse);

    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
