import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  initWebRequestHandlers,
  type WebRequestDeps,
} from "../../../src/background/background_webrequest.js";
import * as mediaCandidates from "../../../src/shared/media_candidates.js";
import { contentLengthFromHeaders, contentTypeFromHeaders } from "../../../src/background/video_utils.js";
import * as videoUtils from "../../../src/background/video_utils.js";

function makeDeps(addDetectedVideo: ReturnType<typeof vi.fn>): WebRequestDeps {
  return {
    clearTab: vi.fn(),
    addDetectedVideo: addDetectedVideo as unknown as WebRequestDeps["addDetectedVideo"],
    detectFormat: (url: string, ct = "") => videoUtils.detectFormat(url, ct),
    isLikelyVideoRequest: (url: string, rt: string, ct = "") =>
      mediaCandidates.isLikelyVideoRequest(url, rt, ct),
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
