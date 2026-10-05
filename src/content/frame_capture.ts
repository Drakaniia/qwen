/**
 * Canvas frame capture (spec `thumbnail-spec.md` §5, D5/D9/D10).
 *
 * The third rung of the thumbnail ladder, for the players that set no `poster` and
 * publish no `og:image` — MSE players and most SPAs. `drawImage` on the element is
 * the only source of art that needs no third-party request, so it earns its place
 * above the site-derived URL.
 *
 * Deliberately absent: `crossOrigin` is *not* set on the element. Setting it is a
 * mutation of the page's own DOM that would change how the page's media loads, and
 * this spec does not take that side effect. A cross-origin frame without CORS
 * headers taints the canvas instead, and the resulting `SecurityError` is caught
 * below — the row simply falls through to the site/page tiers.
 *
 * Every DOM property is read defensively: the module is imported by a content
 * script and by happy-dom tests that hand it objects which are not real players.
 */

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — the first state with a decodable frame. */
const HAVE_CURRENT_DATA = 2;

/** Longest edge of the captured frame, in CSS pixels. D9 — the row renders ~40px. */
const LONGEST_EDGE_PX = 160;

/** JPEG quality for the capture. Small tiles do not survive better than this. */
const JPEG_QUALITY = 0.6;

/**
 * Elements that have already been through a capture attempt, so the six scanners in
 * `page_detection.ts` re-handing the same `<video>` cost one draw per page lifetime.
 *
 * A `WeakSet` because there is nothing to evict: the entry dies with the element, so
 * a re-scanned SPA keeps its captures and a removed player leaks nothing. Elements
 * are only marked once a capture is actually attempted, so a video whose frame is
 * not decoded yet can still be captured by a later scan.
 */
const attempted = new WeakSet<HTMLVideoElement>();

/**
 * A `data:image/jpeg;base64,…` URL for the video's current frame, or `""` when no
 * frame is available — not decoded yet, not sized yet, or the canvas is tainted.
 *
 * No polling and no retry timer (D9): the poster path covers the common case, and a
 * player with no frame at scan time will have one by the time the popup opens, which
 * re-runs the scan.
 */
export function captureFrame(video: HTMLVideoElement): string {
  if (!video || attempted.has(video)) {
    return "";
  }

  const sourceWidth = Number(video.videoWidth) || 0;
  const sourceHeight = Number(video.videoHeight) || 0;
  if (!sourceWidth || !sourceHeight || (Number(video.readyState) || 0) < HAVE_CURRENT_DATA) {
    return "";
  }

  attempted.add(video);

  const ownerDocument = video.ownerDocument || (typeof document === "undefined" ? null : document);
  if (!ownerDocument || typeof ownerDocument.createElement !== "function") {
    return "";
  }

  try {
    // Longest edge to 160px, aspect preserved; a source already smaller than that
    // keeps its own size rather than being upscaled into a blur.
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    const scale = Math.min(1, LONGEST_EDGE_PX / longestEdge);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      return "";
    }

    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY) || "";
  } catch (_error) {
    // `SecurityError` on a tainted canvas; also the shape a stubbed/missing
    // 2d context throws in. Either way the row falls through to site/page art.
    return "";
  }
}
