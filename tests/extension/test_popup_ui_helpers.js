"use strict";

import assert from "node:assert/strict";

// ─── These imports will fail — the modules don't exist yet (RED phase) ──────
import * as PopupUI from "../../src/popup/popup-ui.js";

// ─── shortenUrl ─────────────────────────────────────────────────────────────

{
  assert.equal(
    PopupUI.shortenUrl("https://example.com/video.mp4"),
    "example.com/video.mp4",
    "shortenUrl must return hostname + path for a normal URL",
  );
}

{
  assert.equal(
    PopupUI.shortenUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=2"),
    "www.youtube.com/watch?...",
    "shortenUrl must append ?... for URLs with search params",
  );
}

{
  const long = "https://example.com/" + "a".repeat(60) + "/" + "b".repeat(40) + ".mp4";
  const result = PopupUI.shortenUrl(long);
  assert.ok(
    result.length < long.length,
    "shortenUrl must truncate paths longer than 74 characters",
  );
}

{
  assert.equal(
    PopupUI.shortenUrl(""),
    "",
    "shortenUrl must return empty string for empty input",
  );
}

{
  const result = PopupUI.shortenUrl("not-a-valid-url");
  assert.ok(
    result.length <= 95,
    "shortenUrl must fall back to slicing for invalid URLs",
  );
}

// ─── videoThumbnailUrl ──────────────────────────────────────────────────────

{
  assert.equal(
    PopupUI.videoThumbnailUrl({ thumbnailUrl: "https://example.com/thumb.jpg" }),
    "https://example.com/thumb.jpg",
    "videoThumbnailUrl must return thumbnailUrl when set",
  );
}

{
  assert.equal(
    PopupUI.videoThumbnailUrl({ poster: "https://example.com/poster.jpg" }),
    "https://example.com/poster.jpg",
    "videoThumbnailUrl must fall back to poster when thumbnailUrl is absent",
  );
}

{
  assert.equal(
    PopupUI.videoThumbnailUrl({ image: "https://example.com/image.jpg" }),
    "https://example.com/image.jpg",
    "videoThumbnailUrl must fall back to image when thumbnailUrl and poster are absent",
  );
}

{
  assert.equal(
    PopupUI.videoThumbnailUrl({}),
    "",
    "videoThumbnailUrl must return empty string when no thumbnail is available",
  );
}

{
  assert.equal(
    PopupUI.videoThumbnailUrl(null),
    "",
    "videoThumbnailUrl must return empty string for null input",
  );
}

{
  assert.equal(
    PopupUI.videoThumbnailUrl({ thumbnailUrl: "ftp://example.com/file" }),
    "",
    "videoThumbnailUrl must reject non-http/https/blob/data protocols",
  );
}

// ─── normalizeManualUrl ─────────────────────────────────────────────────────

{
  assert.equal(
    PopupUI.normalizeManualUrl("https://example.com/page"),
    "https://example.com/page",
    "normalizeManualUrl must return valid http/https URLs unchanged",
  );
}

{
  assert.equal(
    PopupUI.normalizeManualUrl(""),
    "",
    "normalizeManualUrl must return empty string for empty input",
  );
}

{
  assert.equal(
    PopupUI.normalizeManualUrl("   "),
    "",
    "normalizeManualUrl must return empty string for whitespace-only input",
  );
}

{
  assert.equal(
    PopupUI.normalizeManualUrl("not-a-url"),
    "",
    "normalizeManualUrl must return empty string for invalid URLs",
  );
}

{
  assert.equal(
    PopupUI.normalizeManualUrl("ftp://example.com/file"),
    "",
    "normalizeManualUrl must reject non-http/https protocols",
  );
}

{
  // URL with trailing whitespace
  assert.equal(
    PopupUI.normalizeManualUrl("  https://example.com/page  "),
    "https://example.com/page",
    "normalizeManualUrl must trim whitespace",
  );
}

// ─── videoTitle ────────────────────────────────────────────────────────────

{
  assert.equal(
    PopupUI.videoTitle({ title: "My Video", url: "https://example.com/video.mp4" }),
    "My Video",
    "videoTitle must return the title when set",
  );
}

{
  const result = PopupUI.videoTitle({ url: "https://example.com/video.mp4", format: "MP4" });
  assert.ok(result.includes("example.com"), "videoTitle must fall back to shortenUrl when title is absent");
}

{
  const result = PopupUI.videoTitle({ url: "https://example.com/track", format: "AUDIO" });
  assert.ok(result.includes("example.com"), "videoTitle must fall back to shortenUrl for AUDIO format when URL is present");
}

{
  const result = PopupUI.videoTitle({ format: "AUDIO" });
  assert.equal(result, "Music", "videoTitle must return 'Music' for AUDIO format without title or URL");
}

{
  const result = PopupUI.videoTitle({});
  assert.equal(result, "Video", "videoTitle must return 'Video' for unknown format without title/url");
}

{
  const result = PopupUI.videoTitle(null);
  assert.equal(result, "Video", "videoTitle must return 'Video' for null input");
}

// ─── displayFormat ──────────────────────────────────────────────────────────

{
  const result = PopupUI.displayFormat({ format: "MP4" });
  assert.ok(typeof result === "string", "displayFormat must return a string");
}

// ─── sourceLabel ────────────────────────────────────────────────────────────

{
  const result = PopupUI.sourceLabel({ format: "MP4" });
  assert.ok(typeof result === "string", "sourceLabel must return a string");
}

// ─── videoSizeLabel ─────────────────────────────────────────────────────────

{
  const result = PopupUI.videoSizeLabel({});
  assert.equal(result, "", "videoSizeLabel must return empty string for no size info");
}

console.log("popup-ui helpers tests passed");
