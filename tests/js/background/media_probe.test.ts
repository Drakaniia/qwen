/**
 * `background/media_probe.ts` — the only detection layer that asks the server.
 *
 * What matters here is the *filter*, not the transport: this function is handed a mixed
 * bag of a page's resource URLs after every other detector has already failed, so it has
 * to drop what must never be touched (`isBlockedMediaUrl`), drop what cannot be fetched,
 * de-duplicate, cap, and turn the host's kind vocabulary into the format labels the rest
 * of the system compares against — all without ever throwing, because its caller is
 * already explaining a failure to the user.
 */
import { describe, expect, it, vi } from "vitest";

import { PROBE_URL_LIMIT, probeMediaUrls, type MediaProbeDeps } from "../../../src/background/media_probe.js";

function makeDeps(overrides: Partial<MediaProbeDeps> = {}): MediaProbeDeps {
  return {
    nativeRequest: vi.fn(async () => ({ results: [] })),
    isBlockedMediaUrl: () => false,
    normalizeUrl: (url: string) => url,
    nativeRequestHeadersForVideo: async () => [],
    userAgent: "test-agent",
    pageUrl: "https://site.example/watch",
    ...overrides,
  };
}

/** The `urls` array of the single request the fake host received. */
function sentUrls(deps: MediaProbeDeps): string[] {
  const payload = vi.mocked(deps.nativeRequest).mock.calls[0][0] as { urls: string[] };
  return payload.urls;
}

describe("which URLs get asked about", () => {
  it("drops schemes the helper cannot fetch and duplicates", async () => {
    const deps = makeDeps();
    await probeMediaUrls(
      [
        "blob:https://site.example/uuid",
        "data:video/mp4;base64,AAAA",
        "https://cdn.example/a",
        "https://cdn.example/a",
      ],
      deps,
    );

    expect(sentUrls(deps)).toEqual(["https://cdn.example/a"]);
  });

  it("never hands a blocked URL to the host at all", async () => {
    const deps = makeDeps({ isBlockedMediaUrl: (url) => url.includes("/cdn-cgi/") });
    await probeMediaUrls(["https://site.example/cdn-cgi/challenge", "https://cdn.example/a"], deps);

    expect(sentUrls(deps)).toEqual(["https://cdn.example/a"]);
  });

  it("caps the list and makes no request when nothing survives the filter", async () => {
    const deps = makeDeps();
    await probeMediaUrls(
      Array.from({ length: PROBE_URL_LIMIT + 8 }, (_value, index) => `https://cdn.example/${index}`),
      deps,
    );
    expect(sentUrls(deps)).toHaveLength(PROBE_URL_LIMIT);

    const quiet = makeDeps();
    expect(await probeMediaUrls(["blob:https://site.example/uuid"], quiet)).toEqual([]);
    expect(quiet.nativeRequest).not.toHaveBeenCalled();
  });

  it("asks for a probe, with the page as the referer source", async () => {
    const deps = makeDeps();
    await probeMediaUrls(["https://cdn.example/a"], deps);

    const [payload, timeout] = vi.mocked(deps.nativeRequest).mock.calls[0] as [
      Record<string, unknown>,
      number | undefined,
    ];
    expect(payload.type).toBe("probeMediaUrls");
    expect(payload.pageUrl).toBe("https://site.example/watch");
    expect(payload.userAgent).toBe("test-agent");
    expect(typeof payload.id).toBe("string");
    expect(timeout).toBeGreaterThan(0);
  });
});

describe("what comes back", () => {
  it("maps the host's kinds to format labels, manifests first", async () => {
    const deps = makeDeps({
      nativeRequest: vi.fn(async () => ({
        results: [
          { url: "https://cdn.example/file", kind: "mp4", contentType: "video/mp4" },
          { url: "https://cdn.example/master", kind: "hls", contentType: "application/vnd.apple.mpegurl" },
          { url: "https://cdn.example/second", kind: "dash", contentType: "application/dash+xml" },
        ],
      })),
    });

    const sources = await probeMediaUrls(
      ["https://cdn.example/file", "https://cdn.example/master", "https://cdn.example/second"],
      deps,
    );

    expect(sources.map((source) => source.format)).toEqual(["M3U8", "MPD", "MP4"]);
    expect(sources[0].url).toBe("https://cdn.example/master");
  });

  it("drops kinds that are answers but not downloads", async () => {
    const deps = makeDeps({
      nativeRequest: vi.fn(async () => ({
        results: [
          { url: "https://player.example/embed/1", kind: "page", contentType: "text/html" },
          { url: "https://cdn.example/x", kind: "unknown", contentType: "" },
          { url: "", kind: "mp4", contentType: "video/mp4" },
        ],
      })),
    });

    expect(await probeMediaUrls(["https://player.example/embed/1"], deps)).toEqual([]);
  });

  it("treats a dead host, a timeout and a junk reply as the same empty answer", async () => {
    const throwing = makeDeps({
      nativeRequest: vi.fn(async () => {
        throw new Error("Native helper disconnected.");
      }),
    });
    expect(await probeMediaUrls(["https://cdn.example/a"], throwing)).toEqual([]);

    // The host is a separate process answering over stdio; a reply that does not match
    // the shape is a real possibility, so the cast is the point of this case.
    const junk = makeDeps({
      nativeRequest: vi.fn(async () => ({ results: "not an array" })) as unknown as MediaProbeDeps["nativeRequest"],
    });
    expect(await probeMediaUrls(["https://cdn.example/a"], junk)).toEqual([]);
  });
});
