/**
 * `proxyFetch` is a fetch with the extension's host permissions behind it, so the policy
 * is the test: who may ask, for which URLs, with which methods, and whose cookies ride
 * along. The one real caller (`content.ts:verifyStreamingUrlsViaProxy`) is a
 * credential-less HEAD from a tab, and that must keep working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyFetch } from "../../../src/background/proxy_fetch.js";

const TAB_SENDER = { tab: { id: 3, url: "https://site.example/watch" } } as chrome.runtime.MessageSender;

function stubFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response("", {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxyFetch", () => {
  it("serves the content script's credential-less HEAD probe", async () => {
    const fetchMock = stubFetch();
    const result = await proxyFetch({ url: "https://cdn.example/v.mp4", method: "HEAD" }, TAB_SENDER);

    expect(result).toMatchObject({ ok: true, contentType: "video/mp4", status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example/v.mp4",
      expect.objectContaining({ method: "HEAD", credentials: "omit" }),
    );
  });

  it("refuses a sender that is not a content script in a tab", async () => {
    const fetchMock = stubFetch();
    const result = await proxyFetch({ url: "https://cdn.example/v.mp4" }, {} as chrome.runtime.MessageSender);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-http(s) URLs and methods other than GET/HEAD", async () => {
    const fetchMock = stubFetch();
    expect((await proxyFetch({ url: "file:///C:/secret.txt" }, TAB_SENDER)).ok).toBe(false);
    expect((await proxyFetch({ url: "https://cdn.example/x", method: "POST" }, TAB_SENDER)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends credentials only to the sender tab's own origin", async () => {
    const fetchMock = stubFetch();
    await proxyFetch({ url: "https://other.example/api", includeCredentials: true }, TAB_SENDER);
    await proxyFetch({ url: "https://site.example/api", includeCredentials: true }, TAB_SENDER);

    expect(fetchMock.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ credentials: "omit" }),
      expect.objectContaining({ credentials: "include" }),
    ]);
  });
});
