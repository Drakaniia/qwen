# Troubleshooting

## Helper Not Connected

Run the installer again, then restart the browser:

```bash
npm run setup
```

Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi` in
`browser://extensions` (Yandex) or `chrome://extensions` (Chrome). If it differs, the native
host's `allowed_origins` will not match and every request is rejected.

`Access to native host is forbidden` in the service worker log is the same problem: the
extension is running under a different ID.

> **Firefox is not supported** and is not a possible cause — there is no Firefox manifest,
> build target or registry registration.

## Missing yt-dlp, ffmpeg or aria2c

Run `npm run setup` again and make sure Python and `pip` are on `PATH`. The installer tries
to provide:

- `yt-dlp` (with the `curl-cffi` extra), `imageio-ffmpeg`, `certifi`, `streamlink` via `pip`
- system `ffmpeg` via `winget`, when available
- `tools\aria2\aria2c.exe` from the aria2 GitHub release
- `tools\n_m3u8dl-re\N_m3u8DL-RE.exe` from its GitHub release

If `winget` is unavailable the helper falls back to the `imageio-ffmpeg` binary that `pip`
installed.

The **Options** page → Native helper section lists all five tools individually, so you can
tell exactly which one is missing rather than guessing from the popup banner.

## Missing Stream Fallbacks

If the popup says `yt-dlp only`, the N_m3u8DL-RE and Streamlink fallbacks are unavailable.
Downloads still work — these only add best-effort fallbacks for accessible HLS, DASH and
Smooth Streaming manifests that `yt-dlp` cannot use.

Check:

- `tools\n_m3u8dl-re\N_m3u8DL-RE.exe` exists, or that `QWIN_N_M3U8DL_RE` points at a valid
  executable.
- `streamlink` is installed for the _same_ Python the native host runs under.

## Fast Mode Not Available

Fast mode means `aria2c` was found. Without it every download is slower and direct-media
downloads lose their segmented transfer.

1. Run `npm run setup` again.
2. Check that `tools\aria2\aria2c.exe` exists.
3. Or set `QWIN_ARIA2C` to a valid `aria2c.exe` path before starting the browser.

The resolver order is: `QWIN_ARIA2C` → `aria2c` on `PATH` → `tools\aria2\aria2c.exe`.

## Browser-Only Or Blob URLs

If the popup only shows `blob:`, `data:`, or local file URLs, start playback and wait a few
seconds so the extension can see the underlying media requests. On YouTube watch / embed /
shorts pages, Qwin should list the YouTube page itself rather than the temporary
`googlevideo.com` playback URL.

A `blob:` row is detected by the content script and tagged internally (`source: mse-player`)
rather than handed to the helper, because the handle points at the player's own buffer and
there is no file behind it — `blob:`, `data:` and `file:` cannot be sent to `yt-dlp` at all.
Qwin cannot save those rows; the row says so instead of offering a Download button. If the
site itself is supported by yt-dlp, the page's own row can still download it.

Some pages never expose a reusable media URL at all. The quality dialog now says which of
these it is instead of offering a download that cannot work (see **Zero Formats Returned**).

## Manual Link Fails

The link box sends the pasted URL to `yt-dlp` first, then may use the stream fallbacks for
supported manifest URLs. If everything fails, the usual causes are:

- The installed `yt-dlp` version does not support that site or URL shape.
- The video needs login, age, region, app-only, or bot-check access the helper cannot
  reproduce.
- The video is DRM-protected or otherwise encrypted.
- The site blocked the request from the helper even though playback in the browser works.

For YouTube, Qwin enables yt-dlp's EJS challenge helper with `--remote-components ejs:github`.
The first YouTube extraction may download yt-dlp's solver script from GitHub. If GitHub or the
JavaScript runtime is blocked on the machine, YouTube may return only storyboard/image
formats.

## Zero Formats Returned

If the popup shows no quality options for a video it did detect, the native host answered but
returned no usable formats. The dialog shows one sentence explaining why **instead of** the
version table — it no longer offers a synthetic "Best available MP4", which was a row the
helper had already refused and which always failed on click.

What each sentence means:

- **"This page does not expose a downloadable video link"** — the helper was handed a page
  URL, not a media URL, and has no extractor for that host (`Unsupported URL`). Start
  playback so the player loads its stream, then reopen the popup.
- **"This video plays through a browser-managed stream"** — the source is a `blob:` handle
  (MSE). Nothing can fetch it, and Qwin does not record playback. Try the page URL instead.
- **"This stream is DRM-protected"** — Widevine/PlayReady. No downloader can copy it.
- **"No downloadable versions were found for this video"** — the helper reached the address
  and found nothing in it (a segment, a token-only URL, or a session-gated page).

`src/logs/downloads.jsonl` still records the raw reason (`ATTEMPT_END` / `DOWNLOAD_ERROR`
entries), and the raw text is shown under the sentence when no mapping matches. The usual
causes are:

- `yt-dlp returned response but no formats found` — the site was reached but nothing
  extractable came back. Usually the URL was not the media URL.
- `Format enumeration complete: 0 native + 0 detected format(s)` — both the native path and
  the detected-candidate path came up empty.

Before giving up, the extension already probes the URLs it could not classify: a `HEAD` plus
at most one ranged `GET` per URL, classified by Content-Type and the first 512 bytes
(`probeMediaUrls`). Only URLs that survive the block list are probed, capped at 12 per video.

Check the URL in the log line directly: paste it into **Download from link** and see whether
`yt-dlp` alone can handle it. If it cannot, the extension's classification is not the problem.

## Cloudflare / WAF Anti-Bot Challenges

### What Qwin actually does

Every `yt-dlp` command Qwin builds passes `--extractor-args generic:impersonate`
(`GENERIC_EXTRACTOR_ARGS` in `src/native_host/backends/yt_dlp/yt_dlp_command.py`). For generic
site extraction this makes yt-dlp use its bundled `curl_cffi` to match a real browser's TLS and
HTTP/2 fingerprint. The native host only builds the command — `curl_cffi` comes from the
`curl-cffi` extra of `yt-dlp[default,curl-cffi]` and the host does not probe it.

There is **no** separate curl_cffi downloader. There is no `curl_cffi_adapter.py`. If a
document or a log line claims otherwise, it is stale.

### Diagnosing curl_cffi Issues

**1. Check it is installed:**

```bat
python -c "from curl_cffi import requests; print('curl_cffi OK')"
```

If that raises `ModuleNotFoundError`, re-run the installer — it installs
`yt-dlp[default,curl-cffi]`, which pulls `curl_cffi` in as a dependency:

```bash
npm run setup
```

**2. Check the fingerprint is really being sent:**

```bat
python -c "from curl_cffi import requests; d = requests.get('https://tls.browserleaks.com/json', impersonate='chrome').json(); print('JA3:', d['ja3_hash']); print('UA:', d['user_agent'])"
```

Expect a JA3 hash and a Chrome User-Agent. A network error here means DNS or connectivity,
not curl_cffi.

**3. Compare impersonated against the default fingerprint:**

```bat
python -c "from curl_cffi import requests; a = requests.get('https://tls.browserleaks.com/json', impersonate='chrome').json()['ja3_hash']; b = requests.get('https://tls.browserleaks.com/json').json()['ja3_hash']; print(a, b, a != b)"
```

If both hashes match, impersonation is not taking effect.

### What impersonation can and cannot do

| Can help with                      | Cannot help with                            |
| ---------------------------------- | ------------------------------------------- |
| TLS fingerprint checks (JA3/JA4)   | JavaScript challenges (Turnstile, hCaptcha) |
| HTTP/2 fingerprint checks          | Behavioural detection                       |
| SSL/TLS-level bot detection        | Login- or session-based access              |
| Some Cloudflare generic challenges | DRM (PlayReady / Widevine)                  |
| Akamai fingerprint blocking        | Region blocking (needs a different network) |

When a site layers on top of TLS fingerprinting — a JavaScript challenge, behavioural
detection, or a short-lived signed URL that must be generated by a prior page load — no
static HTTP client gets through. The download then fails, or the video is simply not offered.

### Backend Fallback Chain

When the primary `yt-dlp` attempt fails, the helper tries labelled alternatives. These labels
appear in the download log (`src/logs/downloads.jsonl`) and are useful for diagnosing which
stage gave up:

```
yt-dlp (no SSL check)
yt-dlp (geo bypass)
yt-dlp (no impersonate)
yt-dlp (max retries)
yt-dlp (single fragment)
yt-dlp (generic extractor)
yt-dlp (throttle detect)
```

For stream manifests it also offers `N_m3u8DL-RE`, `Streamlink`, and a direct
`ffmpeg -c copy` of the manifest. For format enumeration it uses `yt-dlp (skip-download)`.

### Common Error Messages

| Error                                    | Likely cause                   | Fix                                             |
| ---------------------------------------- | ------------------------------ | ----------------------------------------------- |
| `curl: (6) Could not resolve host`       | DNS failure                    | Check connectivity, `nslookup <host>`           |
| `curl: (28) Connection timed out`        | Host unreachable or firewalled | Check the site in a browser                     |
| `curl: (35) SSL connect error`           | TLS handshake rejected         | The site may pin a specific browser version     |
| `curl: (56) Failure when receiving data` | Connection reset               | Often the server detected non-browser behaviour |

## Helper Download Errors

`yt-dlp`, N_m3u8DL-RE or Streamlink can all fail when the site requires:

- DRM decryption.
- A login session the helper cannot reproduce.
- Short-lived private tokens.
- Site-specific extraction that is not available from the detected URL alone.
- Headers or cookies that were not captured by the extension.

The popup translates the raw error into a readable sentence (`src/background/download_fallbacks.ts`);
if the message is unhelpful, the raw text is in that job's `ATTEMPT_END` /
`DOWNLOAD_ERROR` entries in `src/logs/downloads.jsonl`.

## Filter List Refresh Failed

The extension downloads uBO and EasyList filter lists every 5 days (1 day for the EasyList
feeds). If a download fails — network error, timeout, GitHub unreachable:

- Cached patterns from `chrome.storage.local` keep being used.
- The last successful download persists across service worker restarts.
- The next attempt is on the normal schedule.
- This is not critical: the built-in `AD_RE` and `CDN_HINT_RE` patterns in
  `src/shared/media_candidates.js` still apply.

Options → Filter list sources shows when each list was last fetched.

## Slow Downloads

Usually one of these is the bottleneck:

- The video host or CDN is throttling.
- The server does not allow multiple connections.
- The stream format cannot be segmented or resumed.
- VPN, Wi-Fi or routing.
- Disk writes are slow or the destination drive is nearly full.

Fast mode can only help when the origin server permits it. If `aria2c` is missing, segmented
transfer is not available at all.

## Many Short Clips In The Popup

Reload the extension and reload the page. The build cleans stale stored fragment detections on
startup and filters new HLS/DASH segment URLs (`.ts`, `.m4s`, `segment-*`, `chunk-*`,
`frag-*`). If a page genuinely hosts many distinct small clips, that is legitimate — use the
search box and the sort control in the popup's video list.

## Overlay Missing On A Video

- Check Options → Page integration → **Show a download button on detected video players** is
  enabled.
- The overlay is only attached to `<video>` elements that look like real players; short,
  hidden, muted-looping or GIF-like clips are deliberately skipped.
- The overlay lives in a Shadow DOM, so it is invisible to page CSS — if a hostile page's
  `* { ... !important }` rules seem to break it, that is a real bug worth reporting, not
  expected behaviour.
