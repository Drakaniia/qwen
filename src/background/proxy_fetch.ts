import type { ProxyFetchMessage } from "../shared/contracts.js";

// ── CORS proxy: content script fetch requests ──────────────────────────
//
// Coc Coc's approach: when content scripts encounter CORS-blocked media URLs, they proxy
// the request through the background service worker, which has no CORS restrictions.
//
// Message format:
//   { type: "proxyFetch", url: string, method?: string, headers?: object, includeCredentials?: boolean }
// Response:
//   { ok: true, body: string, contentType: string, status: number }
//   { ok: false, error: string }
//
// The worker holds host permissions for every site, so an unrestricted proxy was a way
// for any page's content-script context to read any URL with the user's cookies. The one
// caller (`content.ts:verifyStreamingUrlsViaProxy`) sends a credential-less HEAD to probe
// a CDN's Content-Type, so the proxy now allows exactly that shape of request:
//
// - only from a content script running in a real tab (`sender.tab`);
// - only `http:` / `https:` targets;
// - only `GET` / `HEAD`;
// - credentials only to the sender tab's own origin — never to a third-party host.

export type ProxyFetchResult =
  | { ok: true; body: string; contentType: string; status: number }
  | { ok: false; error: string };

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch (_error) {
    return "";
  }
}

export async function proxyFetch(
  message: ProxyFetchMessage,
  sender: chrome.runtime.MessageSender | undefined,
): Promise<ProxyFetchResult> {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return { ok: false, error: "proxyFetch is only available to content scripts in a tab." };
  }
  if (!message.url) {
    return { ok: false, error: "Missing URL" };
  }
  let target: URL;
  try {
    target = new URL(message.url);
  } catch (_error) {
    return { ok: false, error: "Invalid URL" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs can be fetched." };
  }
  const method = String(message.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: `Method ${method} is not allowed.` };
  }
  const sameOrigin = originOf(sender.tab.url) === target.origin;

  try {
    const fetchHeaders: Record<string, string> = { Accept: "*/*" };
    if (message.headers && typeof message.headers === "object") {
      Object.assign(fetchHeaders, message.headers);
    }

    const response = await fetch(target.href, {
      method,
      headers: fetchHeaders,
      credentials: message.includeCredentials && sameOrigin ? "include" : "omit",
    });

    return {
      ok: true,
      body: await response.text(),
      contentType: response.headers.get("Content-Type") || "",
      status: response.status,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message || String(error) };
  }
}
