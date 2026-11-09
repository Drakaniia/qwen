import { beforeEach, describe, expect, it, vi } from "vitest";

import { initWebRequestHandlers, type WebRequestDeps } from "../../../src/background/background_webrequest.js";
import * as mediaCandidates from "../../../src/shared/media_candidates.js";
import { contentLengthFromHeaders, contentTypeFromHeaders } from "../../../src/background/video_utils.js";
import * as videoUtils from "../../../src/background/video_utils.js";

function makeDeps(addDetectedVideo: ReturnType<typeof vi.fn>): WebRequestDeps {
  return {
    clearTab: vi.fn(),
    addDetectedVideo: addDetectedVideo as unknown as WebRequestDeps["addDetectedVideo"],
    detectFormat: (url: string, ct = "") => videoUtils.detectFormat(url, ct),
    isLikelyVideoRequest: (url: string, rt: string, ct = "") => mediaCandidates.isLikelyVideoRequest(url, rt, ct),
    isBlockedMediaUrl: (url: string, ct = "") => mediaCandidates.isBlockedMediaUrl(url, ct),
    VIDEO_EXTENSION_RE: mediaCandidates.VIDEO_EXTENSION_RE,
    HLS_RE: mediaCandidates.HLS_RE,
    CDN_HINT_RE: mediaCandidates.CDN_HINT_RE,
    contentTypeFromHeaders,
    contentLengthFromHeaders,
  };
}

function beforeRequestListeners(): Array<(d: unknown) => void> {
  const mock = (
    globalThis as unknown as {
      chrome: { webRequest: { onBeforeRequest: { addListener: { mock: { calls: unknown[][] } } } } };
    }
  ).chrome.webRequest.onBeforeRequest.addListener as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.map((c) => c[0] as (d: unknown) => void);
}

/** Every `onHeadersReceived` listener the module registered, in registration order. */
function headersReceivedListeners(): Array<(d: unknown) => void> {
  const mock = (
    globalThis as unknown as {
      chrome: { webRequest: { onHeadersReceived: { addListener: { mock: { calls: unknown[][] } } } } };
    }
  ).chrome.webRequest.onHeadersReceived.addListener as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.map((c) => c[0] as (d: unknown) => void);
}

function headersDetails(url: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId: 1,
    url,
    type: "xmlhttprequest",
    statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/octet-stream" }],
    ...overrides,
  };
}

/** Fire a response at every registered listener, as the browser would. */
function receiveHeaders(details: Record<string, unknown>): void {
  for (const fn of headersReceivedListeners()) {
    fn(details);
  }
}

describe("handleBeforeRequest media gate (layer A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets an extension-less CDN URL with resourceType media through to headers confirmation", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));
    const listeners = beforeRequestListeners();
    expect(listeners.length).toBeGreaterThan(0);
    for (const fn of listeners) {
      fn({ tabId: 1, url: "https://akamaihd.example.com/stream/abc123", type: "media" });
    }
    expect(add).toHaveBeenCalled();
  });

  it("still drops the Cloudflare challenge URL", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));
    for (const fn of beforeRequestListeners()) {
      fn({
        tabId: 1,
        url: "https://lulust.com/cdn-cgi/challenge-platform/h/b/precursor/x",
        type: "xmlhttprequest",
      });
    }
    expect(add).not.toHaveBeenCalled();
  });
});

/**
 * Layer C — the broad response listener, which used to require a media Content-Type
 * *and* a URL matching one of ~50 hardcoded streaming shapes.
 *
 * A response the server labelled `video/mp4` from `/opaque/a1b2c3` was thrown away for
 * looking like nothing in particular, which is how a real stream ends up as a page the
 * user is told they cannot download.
 */
describe("handleHeadersReceivedBroad acceptance (layer C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes a named media type on a pattern-less host", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(
      headersDetails("https://opaque.example.com/play", {
        responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
      }),
    );

    expect(add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://opaque.example.com/play", source: "headers-broad" }),
    );
  });

  it("takes the browser's own media flag when the server named nothing", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(headersDetails("https://opaque.example.com/a/b/c", { type: "media" }));

    expect(add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://opaque.example.com/a/b/c", source: "media-request" }),
    );
  });

  it("takes opaque bytes when the response is ranged", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(headersDetails("https://opaque.example.com/a/b/c", { statusCode: 206 }));

    expect(add).toHaveBeenCalledWith(1, expect.objectContaining({ url: "https://opaque.example.com/a/b/c" }));
  });

  it("ignores the same opaque type when the response is not ranged", () => {
    // Same type, no partial content: this is how ordinary chunked JSON looks, so it is
    // not evidence of media and must not reach the list.
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(headersDetails("https://opaque.example.com/a/b/c", { statusCode: 200 }));

    expect(add).not.toHaveBeenCalled();
  });

  it("keeps the block list authoritative over every new way in", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(
      headersDetails("https://lulust.com/cdn-cgi/challenge-platform/h/b/precursor/x", {
        type: "media",
        statusCode: 206,
      }),
    );

    expect(add).not.toHaveBeenCalled();
  });

  it("still ignores a page", () => {
    const add = vi.fn();
    initWebRequestHandlers(makeDeps(add));

    receiveHeaders(
      headersDetails("https://site.example.com/opaque/a1b2c3", {
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      }),
    );

    expect(add).not.toHaveBeenCalled();
  });
});
