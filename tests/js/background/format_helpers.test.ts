/**
 * `unavailableReasonFor` — the sentence the quality dialog shows *instead of* a row.
 *
 * Its predecessor was a synthetic `Best available MP4` option that could never download
 * anything, because the helper had just refused the URL. So the two things pinned here
 * are that the cause is named at all and that the causes are ordered: an MSE handle is a
 * fact about the source that the helper's own text cannot express (all it can say is
 * "only http(s) URLs"), which is why it is checked before the error mappings.
 */
import { describe, expect, it } from "vitest";

import { unavailableReasonFor } from "../../../src/background/format_helpers.js";

describe("unavailableReasonFor", () => {
  it("names the browser-managed stream for a blob source, whatever the helper said", () => {
    const reason = unavailableReasonFor(
      { id: "v1", url: "blob:https://site.example/uuid" },
      "Only http:// and https:// media, playlist, or supported video page URLs can be sent",
    );

    expect(reason).toContain("browser-managed stream");
    // The recording path was deleted on purpose (AGENTS.md); the sentence must not offer it.
    expect(reason).not.toMatch(/record/i);
  });

  it("names the browser-managed stream for a variant the row itself tagged as MSE", () => {
    expect(unavailableReasonFor({ id: "v1", url: "https://site.example/player", source: "mse-player" }, "")).toContain(
      "browser-managed stream",
    );
  });

  it("names the browser-managed stream when only a sibling variant is a blob handle", () => {
    const reason = unavailableReasonFor(
      {
        id: "v1",
        url: "https://site.example/player",
        variants: [{ id: "v2", url: "blob:https://site.example/uuid" }],
      },
      "",
    );

    expect(reason).toContain("browser-managed stream");
  });

  it("turns yt-dlp's 'Unsupported URL' into the next thing to try", () => {
    const reason = unavailableReasonFor(
      { id: "v1", url: "https://player.zxcprime.xyz/player/tw/127532/1/1" },
      "ERROR: Unsupported URL: https://player.zxcprime.xyz/player/tw/127532/1/1",
    );

    expect(reason).toContain("does not expose a downloadable video link");
    expect(reason).not.toContain("Unsupported URL");
  });

  it("says plainly that a DRM stream cannot be copied", () => {
    expect(
      unavailableReasonFor({ id: "v1", url: "https://site.example/watch" }, "ERROR: [generic] DRM protected"),
    ).toContain("DRM-protected");
  });

  it("falls back to the raw complaint rather than to nothing", () => {
    expect(unavailableReasonFor({ id: "v1", url: "https://site.example/watch" }, "some brand new yt-dlp wording")).toBe(
      "some brand new yt-dlp wording",
    );
  });

  it("still says something when there is no error at all", () => {
    expect(unavailableReasonFor({ id: "v1", url: "https://site.example/watch" }, "")).toBe(
      "No downloadable versions were found for this video.",
    );
  });
});
