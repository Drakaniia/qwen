# Download-detection alternatives (regex-free)

Current approach (1 para): `src/shared/media_patterns.ts` + `src/shared/media_rules.ts`
hold ~5 regex tables (`VIDEO_EXTENSION_RE`, `MEDIA_BLOCK_RULES`,
`MEDIA_CLASSIFY_RULES`, `VIDEO_REQUEST_RULES`) consumed by the DOM sweep
(`src/content/page_detection.ts`) and the `webRequest` filter
(`src/background/background_webrequest.ts`). Every new CDN/ad shape
(e.g. `/cdn-cgi/`) needs a new pattern; the list only grows.

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
const urls = [...document.querySelectorAll("video")].map(v => v.currentSrc);
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

## Recommendation

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
