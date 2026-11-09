# Download-detection alternatives (regex-free)

## What is implemented now

**A and D landed; B was already there; C was already there.** In detail:

- **A — server truth in the response gate** (`background/background_webrequest.ts`).
  The broad `onHeadersReceived` listener used to require a media `Content-Type` **and** a
  URL matching the streaming-pattern table. A real stream from `/opaque/a1b2c3` was
  therefore discarded for looking like nothing in particular. There are now four
  independent ways in, none of them a precondition for another: a named media type; the
  browser's own `type: "media"` stamp (Chrome only sets it for a request a media element
  started); `application/octet-stream` over HTTP 206; or a streaming-pattern match. The
  block list still runs first and is still authoritative.
- **B — element truth** (`content/page_detection.ts`). `buildCandidate` took the URL
  classifier's word for a `<video>`'s own source. A `<video>` that passes
  `isLikelyRealVideoBox` now vouches for its source outright, so an opaque URL becomes a
  candidate on the element's evidence rather than a pattern's. A `blob:` source is tagged
  `source: "mse-player"` — it is a MediaSource handle, not a file, and the tag is what
  lets the UI say it cannot be saved instead of offering a quality list that cannot be filled.
- **D — byte probe** (`native_host/media/media_probe.py`, `background/media_probe.ts`).
  `probeMediaUrls` answers a list of URLs with a `kind` per URL, from a `HEAD` and then a
  `Range: bytes=0-511` GET — Content-Type first, the same 512-byte magic-byte peek yt-dlp's
  `GenericIE` performs second. It runs only after native `formats` _and_ every detected
  candidate have failed, is capped at 12 URLs, and is fed from
  `probeUrls` on the page-fallback row (`content.ts:unclassifiedResourceUrls` — the
  `fetch`/`xmlhttprequest` resource-timing entries the ordinary scanners had to drop).
- **C — delegate to yt-dlp on the page URL** was already the last resort, unchanged:
  `format_helpers.ts` walks page fallback → `resolveMediaCandidates` → detected variants.

Byte probing is `D` as written — the `HEAD`/`Range` + magic-byte classifier is the one
proposed in the section below, with the same `#EXTM3U` / `ftyp` tells.

## The original analysis

Current approach (1 para): `src/shared/media_patterns.ts` + `src/shared/media_rules.ts`
hold ~5 regex tables (`VIDEO_EXTENSION_RE`, `MEDIA_BLOCK_RULES`,
`MEDIA_CLASSIFY_RULES`, `VIDEO_REQUEST_RULES`) consumed by the DOM sweep
(`src/content/page_detection.ts`) and the `webRequest` filter
(`src/background/background_webrequest.ts`). Every new CDN/ad shape
(e.g. `/cdn-cgi/`) needs a new pattern; the list only grows.
`shared/streaming_patterns.ts`'s `STREAMING_PATTERNS` is the same story at a larger scale
(~50 host shapes).

## A — Sniff headers + resource type (keep `webRequest`, drop URL guessing)

How: in `onHeadersReceived` read `details.responseHeaders` `Content-Type` and
`details.type` (`"media"`/`"xmlhttprequest"`/`"websocket"`) instead of the URL
string. [webRequest lifecycle + types](https://developer.chrome.com/docs/extensions/reference/api/webRequest) —
[DNR response-header matching, Chr128+](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/HeaderInfo).

```ts
// background_webrequest.ts: classify on what the server said, not the URL
const ct = headers["content-type"] ?? ""; // e.g. video/mp4, application/vnd.apple.mpegurl
if (/^(audio|video)\//.test(ct) || /mpegurl|mpd|ism/.test(ct) || d.type === "media") keep(d.url);
```

Pros: kills ad/CDN block-rules; `Content-Type` is server truth. Cons: needs
`webRequest` + host perms; misses `blob:`/inline players. Effort: S — one
predicate swap in `media_candidates.ts`, keep regex as fallback.

## B — Element truth: `<video>.currentSrc` + resource timing

How: `video.currentSrc` is the resolved URL after `<source>`/JS selection
([WHATWG HTML `currentSrc`](https://html.spec.whatwg.org/multipage/media.html#dom-media-currentsrc));
enumerate with `performance.getEntriesByType("resource")`
([Resource Timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance/getEntriesByType)).

```ts
// page_detection.ts: ground truth, no pattern match
const urls = [...document.querySelectorAll("video")].map((v) => v.currentSrc);
```

Pros: zero regex, immune to CDN renames, covers `blob:` handles. Cons: no
formats/quality (needs C); misses background XHR playlists. Effort: S —
already have the `<video>` sweep, just prefer `currentSrc`.

## C — Delegate to yt-dlp generic extractor on `pageUrl`

How: `GenericIE._VALID_URL = r'.*'` accepts anything, then detects from
`Content-Type` regex + first 512 bytes (`#EXTM3U`, `is_html`), then parses
RSS/SMIL/XSPF/MPD/F4M and scrapes `og:video`/`twitter:player`/JSON-LD/embeds
([generic.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/generic.py));
site extractors dispatch on `_VALID_URL` per-site
([common.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py)).
Streamlink is the opposite lesson: per-site `@pluginmatcher` URL regex
([Plugin API](https://streamlink.github.io/api/plugin.html),
[e.g. livestream.py](https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/livestream.py))
then API fetch + `HLSStream.parse_variant_playlist` — regex at dispatch only,
bytes after. Cobalt is per-service modules (`api/src/processing/services/*.js`)
behind `url-pattern` routing, no generic sniffing
([services dir](https://gitora.tech/CERBERUS/cobalt/src/branch/nicovideo/api/src/processing/services),
[services list](https://github.com/ads-mirrors/cobalt-imputnet/blob/main/api/README.md)).
VDH detects via (closed) network interception; its open companion only does
file-write/ffmpeg ([how it works](https://www.downloadhelper.net/howto?firefox=1),
[coapp repo](https://github.com/aclap-dev/vdhcoapp)).
Pros: zero extension regex for known sites; upstream maintains parsers.
Cons: 3–10 s spawn + page fetch per tab; Cloudflare-403 needs impersonation;
spam-calling it per keystroke is abusive. Effort: M — gate behind "Media view
empty / user asked" via existing `format_helpers.ts` native call.

## D — Lazy HEAD/Range probe, sniff magic bytes not URLs

How: native host sends `HEAD` (fall back to `Range: bytes=0-511`), classifies
`Content-Type` + magic (`#EXTM3U`, `<MPD`, `ftyp`, `OggS`, `ID3`)
— the same 512-byte peek GenericIE does
([generic.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/generic.py)).

```py
# native_host: probe bytes, never match the URL string
h = head(url); ct = h.get("Content-Type", "")
if "mpegurl" in ct or peek(url, 512).startswith(b"#EXTM3U"): return "HLS"
```

Pros: works on extension-classified "unknown" URLs; no per-CDN rules ever.
Cons: extra request per candidate (needs dedupe + cache); CORS/host must allow
it from host side. Effort: M — new host op + small cache.

## Recommendation (kept for the record)

Do A+B now (both S, both delete regex instead of adding it): A promotes
`Content-Type`/`resourceType` above URL match in `findMediaRule` order; B
promotes `currentSrc`/resource-timing to first-class candidates. Keep one
tiny URL table as last-resort fallback. Use C as the on-demand fallback you
already own (`format_helpers.ts` → native `formats` on `pageUrl`) when A+B
find nothing — never per-scan. Add D only if direct-URLAdvisor false-negatives
persist after A+B. Explicitly reject: `chrome.debugger` Network sniffing
([debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger))
— infobar warning + single-attach UX is unacceptable; and DNR body reading,
which the API cannot do ([DNR overview](https://developer.chrome.com/docs/extensions/mv2/reference/declarativeNetRequest)).

## Still not covered

- **`blob:` / MSE-only players.** The handle is not a file and the bytes exist only in the
  player's own buffer, so no fetch, probe or extractor can reach them. Recording what
  plays is the only mechanism that could, and AGENTS.md forbids it; such rows explain the limit.
- **DRM (Widevine / PlayReady).** The browser decrypts for playback only, so there is
  nothing for any downloader to copy. The helper's DRM error is mapped to a plain sentence
  in `background/download_fallbacks.ts` rather than shown raw. Any capture path has to
  refuse a protected element on `video.mediaKeys` — a protected surface encodes black.
- **Session/JS-gated streams.** A short-lived URL the page mints after a page load is not
  reproducible by a static client; curl_cffi impersonation covers only the TLS layer.
- **The block list's own false positives.** A URL the shared tables reject is never probed.
  Total probe coverage is deliberately the complement of the block list, not of "everything
  the browser requested".
