# Universal Video Capture — Pipeline Architecture Spec

**Status:** Draft  
**Author:** Spec generation via user interview  
**Date:** 2026-07-01  
**Version:** 0.1

---

## 1. Executive Summary

yt-dlp is a powerful extractor-based downloader, but it fundamentally cannot handle:
- Sites without dedicated extractors (custom/obscure video players)
- DRM-protected streams (Widevine L3, PlayReady, FairPlay)
- Cloudflare/WAF anti-bot protected URLs
- Time-limited signed tokens on HLS/DASH manifests
- MediaSource Extensions (MSE)-based blob URLs
- WebSocket-delivered or P2P-based video segments

This spec describes a **multi-layered universal capture pipeline** that operates in parallel — each layer attempts to capture the video, with fallbacks to the next layer. The pipeline aims to capture **any on-demand video playing in the browser**, regardless of format (MP4, WebM, HLS/M3U8, DASH/MPD, Smooth Streaming, MSE blob), protection (Cloudflare, signed URLs, token auth), or DRM (Widevine L3/PlayReady/FairPlay), by combining:

1. **Network-level capture** (Service Worker interception, CDP Network monitoring)
2. **Browser-level extraction** (CDP Runtime injection, page scanning)
3. **EME/CDM key extraction** (Go binary with Widevine L3 CDM)
4. **MSE/fMP4 demuxing** (SourceBuffer buffer capture → proper reassembly)
5. **Session cookie/token extraction** (CDP Cookie domain, header recycling)
6. **Browser-tunneled download** (via chrome.debugger Network domain)

---

## 2. Scope & Constraints

### 2.1 In Scope
- **Content type:** On-demand pre-recorded video (movies, shows, clips, user-uploaded)
- **Formats:** MP4, WebM, HLS (M3U8), DASH (MPD), Smooth Streaming (ISM), MSE/blob URLs, fMP4 segments, CMAF
- **Protection levels:**
  - No protection (direct HTTP download)
  - Cloudflare anti-bot/WAF/Turnstile
  - Time-limited signed URLs / token-authenticated manifests
  - Referrer/CORS/origin-restricted CDNs
  - Widevine L3 DRM (software-based CDM)
  - PlayReady SL2000 (software-based)
  - FairPlay (Safari/macOS — FPS 1.0/2.0)
- **Protocols:** HTTP/1.1, HTTP/2, HTTP/3 (QUIC — via browser)

### 2.2 Out of Scope
- Live streaming (Twitch, YouTube Live, Trovo, Kick — separate concern)
- P2P streaming (Douyu, Huya — Chinese P2P protocol)
- Hardware-backed DRM (Widevine L1 — TEE-only, no known extraction for modern devices)
- Server-side watermarking / forensic tracking removal

### 2.3 Output
- **Container:** Preserve original format (MP4 stays MP4, TS stays TS, M4S reassembled to MP4)
- **Quality:** Auto-select highest available bitrate/resolution
- **Metadata:** Preserve HDR metadata, multiple audio tracks, subtitles where container supports it

---

## 3. Architecture Overview

The pipeline has **7 layers**, attempted in parallel where possible, with sequential fallback:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LAYER 0: Detection                          │
│  (Content script scans DOM, network, performance entries, configs)  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     LAYER 1: Parallel Probes                        │
│  (yt-dlp │ curl_cffi │ N_m3u8DL-RE │ Streamlink │ ffmpeg)          │
│  Checks if URL is directly downloadable by existing backends.       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (if probes fail)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│               LAYER 2: CDP Source Extraction                        │
│  (chrome.debugger → Runtime.evaluate → script injection)            │
│  Finds video URLs from DOM, __NEXT_DATA__, player configs.          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (if no direct URLs found)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│               LAYER 3: Service Worker Capture                       │
│  (Register SW on page, intercept all fetch/XHR, capture media       │
│   responses with content-type video/*, application/x-mpegURL, etc.) │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (if media delivered but segmented)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              LAYER 4: MSE/fMP4 Demuxing Pipeline                    │
│  (SourceBuffer.appendBuffer capture → init segment parsing →        │
│   moof/mdat extraction → nal unit reassembly → MP4 muxing)         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (if DRM-protected)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              LAYER 5: EME/CDM Key Extraction                        │
│  (EME intercept → PSSH capture → license challenge capture →        │
│   Go binary CDM → key extraction → segment decryption)              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ (if Cloudflare/blocked)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              LAYER 6: Browser-Tunneled Download                     │
│  (CDP attach → Network.enable → fetch via Page.downloadBehavior     │
│   or Network.streamResourceContent → tunnel bytes through browser)  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 Data Flow — End to End

```
[Content Script]
  ├── DOM scan → direct URLs → [Layer 0/1] → download
  ├── MSE intercept → captured segments → [Layer 4] → demux → MP4
  ├── EME intercept → PSSH + license → [Layer 5] → CDM → keys → decrypt
  └── Service Worker → captured responses → [Layer 3] → assemble → MP4

[Background Script]
  ├── CDP extraction → page URLs → [Layer 2] → retry Layer 1
  ├── CDP Network → response bodies → [Layer 3/6] → assemble
  └── CDP Cookie → tokens/headers → [Layer 1/6] → inject into probes

[Native Host (Python)]
  ├── Parallel probes → yt-dlp/curl_cffi/N_m3u8DL-RE/Streamlink → download
  ├── Page scanning → URL extraction → media candidates → download
  └── Cookie/header injection → recycled session → authenticated download

[Go Binary]
  ├── CDM init → Widevine L3 initialization
  ├── Key extraction → license response → decryption keys
  ├── Segment decryption → AES-128 CTR/CBC → decrypted segments
  └── Segment assembly → concatenate → final MP4 file
```

---

## 4. Detailed Layer Specifications

### 4.1 Layer 0 — Detection (Content Script)

**Purpose:** Find any video-related URLs in the page — direct URLs, manifest URLs, player configs, iframe embeds.

**Current state:** Good existing implementation in `src/content/` — DOM scanning, performance entries, inline scripts, iframe detection, music platform detection.

**Required additions:**
- Enhanced blob URL detection and tracking (blob → MediaSource mapping)
- Detection of Service Worker scope for potential SW registration
- Detection of WebSocket URLs for WS-based streaming
- Detection of Fetch/XHR requests that carry media data
- Detection of `transferMode: "stream"` responses in fetch events

**Implementation plan:**
```
src/content/
├── content.js                 # Enhanced blob detection, SW scope detection
├── page_detection.js          # Broader media URL patterns in scripts
├── media_source_intercept.js  # Enhanced fMP4 init segment detection
├── eme_intercept.js           # Enhanced PSSH/key system detection
├── service_worker_capture.js  # NEW: SW registration + message relay
└── fetch_intercept.js         # NEW: fetch/XHR response stream capture
```

---

### 4.2 Layer 1 — Parallel Probes (Existing)

**Purpose:** Quickly check if the URL is directly downloadable by existing backends.  
**Current state:** Fully implemented in `probe_runner.py` and `download_manager.py`.

**Required additions:**
- Enhanced Cloudflare detection (check response body for challenge pages)
- Cookie recycling from browser session for probes
- TLS fingerprint rotation (multiple Chrome version impersonations)
- Fallback variants with referrer/origin header permutations

**Backend priority order (after probe winner selection):**
1. yt-dlp with aria2c (primary)
2. N_m3u8DL-RE (for HLS/DASH manifests)
3. Streamlink (for HLS livestreams — though live is out of scope, useful for on-demand HLS too)
4. ffmpeg direct stream copy
5. curl_cffi direct download (with browser impersonation)
6. you-get (Asian media platforms)
7. lux (Go-based, Asian media)
8. yt-dlp with native downloader (no aria2c)

---

### 4.3 Layer 2 — CDP Source Extraction (Existing)

**Purpose:** Use Chrome DevTools Protocol to extract video URLs from JavaScript-heavy pages where yt-dlp can't find them.  
**Current state:** Implemented in `cdp_extraction.js` — attaches CDP, injects extraction script via Runtime.evaluate.

**Required additions:**
- Recursive page navigation: navigate to embedded iframe URLs and extract from there
- Shadow DOM traversal: many custom players render inside shadow roots
- Mutation watching via CDP: wait for player JS to finish initializing before extraction
- Event simulation: trigger `load`/`play` events on video elements to populate `currentSrc`
- `__NEXT_DATA__` / `__NUXT__` / `window.__INITIAL_STATE__` extraction with full JSON parsing

```
[CDP Extraction Flow]

tabId → chrome.debugger.attach
  → Page.enable
  → wait for domContentEventFired (or frameStoppedLoading)
  → Runtime.evaluate(extractionScript)
  → if empty: iterate iframes and run same script inside each
  → send results to background → add as detected videos
```

---

### 4.4 Layer 3 — Service Worker Capture (NEW)

**Purpose:** Register a service worker on the page that intercepts ALL network requests and captures response bodies for media content. This catches:
- Fetches to M3U8/MPD manifests
- Segment fetches (TS, M4S, CMFA, CMFV)
- Direct MP4/WebM requests
- Range requests (HTTP 206 Partial Content)
- Streamed responses with `Content-Type: video/*`

**Architecture:**
```
[Service Worker Script] ← registered on page origin
       │
       ├── fetch event → check if response Content-Type matches media
       │   ├── yes → clone response, send body (or metadata) to content script via message channel
       │   └── no  → pass through normally
       │
       ├── cache manifest → save M3U8/MPD content for later parsing
       │
       └── message channel → relay captured data to content script
                              → content script → background → native host
```

**Key considerations:**
- SW scope is limited to the page origin — cannot intercept cross-origin CDN requests directly
- For cross-origin CDNs: SW can still see the fetch event but may not access the response body if CORS is restrictive
- Workaround for cross-origin: use CDP `Network.enable` as backup for cross-origin CDN traffic
- SW + CDP run in parallel for maximum coverage

**File: `src/content/service_worker_capture.js`**
```
// Register SW from content script
function registerCaptureSW(scope) {
  // Install SW script as blob URL to avoid needing a separate file
  const swCode = generateSWCode();
  const blob = new Blob([swCode], { type: 'application/javascript' });
  const swUrl = URL.createObjectURL(blob);
  navigator.serviceWorker.register(swUrl, { scope });
}

function generateSWCode() {
  // Returns SW code as string that:
  // 1. Listens for 'fetch' events
  // 2. Checks response Content-Type
  // 3. For video/*, application/x-mpegURL, etc.:
  //    - Clones response
  //    - Reads full body as ArrayBuffer
  //    - Sends to client via postMessage
  //    - Returns original response to page
  // 4. For range requests (206): reassembles partial content
  // 5. Limits: max 500MB per response, 2GB total per session
}
```

---

### 4.5 Layer 4 — MSE/fMP4 Demuxing Pipeline (Enhanced)

**Purpose:** For videos delivered through MediaSource Extensions (custom players using MSE), capture the raw appended buffers from SourceBuffer and reconstruct a valid MP4 file.

**Current state:** Implemented in `media_source_intercept.js` — captures base64-encoded segments, sends to background.

**Required additions — Full fMP4 Demuxing:**

```
[SourceBuffer.appendBuffer Capture]
       │
       ▼
[Init Segment (ftyp + moov)] → Parse:
  ├── ftyp box → major brand, compatible brands
  ├── moov box → tracks, codecs, timescale, sample descriptions
  ├── Track headers → width, height, language
  └── Sample table → stsd, stts, stsc, stsz, stco (needed for reassembly)
       │
       ▼
[Media Segments (moof + mdat)] → Parse each:
  ├── moof box → track fragment header, sample sizes, durations, flags
  └── mdat box → raw sample data (video NAL units or audio frames)
       │
       ▼
[Reassembly]:
  ├── Collect all init segments + media segments in order
  ├── Build new ftyp + moov from parsed metadata
  ├── Concatenate media segments (moof + mdat) in sequence
  └── Write output MP4 file (or pass to ffmpeg for remuxing)
```

**Implementation approach:**
- Build a proper fMP4 parser in the native host (Python) using `construct` library or manual box parsing
- The Go binary currently does AES-128 decryption + segment assembly — extend it to handle fMP4 moof/mdat parsing
- Support both fMP4 (fragmented) and flat MP4 (non-fragmented) structures
- Handle CMAF tracks (.cmfa for audio, .cmfv for video) — these are fMP4 with specific CMAF constraints

**Edge cases:**
- Multiple track fragments interleaved (audio + video in alternating segments)
- Segment index gaps (player skipped segments — detect via sequence numbers in tfhd)
- Encrypted segments (sinf/frma boxes in init segment → route to Layer 5)
- Codec-specific quirks (AVC/H.264: nal unit length field; HEVC/H.265: vps/sps/pps; AAC: ADTS headers)

---

### 4.6 Layer 5 — EME/CDM Key Extraction (Existing + Enhanced)

**Purpose:** For DRM-protected streams, intercept the Encrypted Media Extensions API, capture PSSH init data and license exchange, extract decryption keys using the Go CDM binary, and decrypt segments.

**Current state:**
- Content script (`eme_intercept.js`): intercepts `requestMediaKeySystemAccess`, proxies sessions, captures init data + license request
- Background (`cdm_network_intercept.js`): CDP-based Network domain capture of license responses
- Go binary (`go/`): CDM init, key extraction from license response, AES-128 CTR decryption, segment assembly
- Native host (`cdm_capture.py`): API layer for Go binary commands
- Capture manager (`capture_manager.py`): Subprocess management + CDP relay

**Required additions:**

```
[EME Intercept Flow — Enhanced]
       │
       ▼
1. Page calls navigator.requestMediaKeySystemAccess(keySystem, config)
   ├── Intercepted by eme_intercept.js
   ├── Record: keySystem ("com.widevine.alpha", "com.microsoft.playready", etc.)
   ├── Record: initDataTypes, videoCapabilities, audioCapabilities
   └── Return proxied MediaKeySystemAccess
       │
       ▼
2. Page calls MediaKeySession.generateRequest(initDataType, initData)
   ├── Intercepted: capture PSSH init data (array buffer → base64)
   ├── Forward to background: { type: "emeCapturedSession", initData, keySystem, sessionId }
   └── Call original generateRequest → license server gets the challenge
       │
       ▼
3. MediaKeySession receives 'message' event (type: "license-request")
   ├── Intercepted: capture license challenge (POST body)
   ├── Forward to background: { type: "licenseRequest", sessionId, message }
   └── Continue normal EME flow → browser sends to license server
       │
       ▼
4. License server responds → CDP Network.loadingFinished fires
   ├── cdm_network_intercept.js captures response via Network.getResponseBody
   ├── Response contains encrypted keys (license)

5. Background sends to native host:
   ├── { type: "extractKeys", sessionId, responseB64, challengeB64, initDataB64 }
   └── Native host → Go binary → CDM unwraps keys → returns decryption keys
       │
       ▼
6. Background sends to native host:
   ├── { type: "decryptSegments", jobId, segments, keys }
   └── Native host → Go binary → AES-128 CTR decrypt segments
       │
       ▼
7. Decrypted segments assembled into playable file (Go binary assembleSegments)
```

**Required enhancements:**
- FairPlay support: detect `com.apple.fps.*` key systems, handle `sinf` init data type
- PlayReady SL2000: detect `com.microsoft.playready` key system, handle `mspr:` init data
- Multi-key sessions: some streams use different keys for different tracks/subtitles
- Session recycling: license response may have `session_id` binding — ensure matching
- L1 detection: if Go binary reports L1-only CDM, skip Layer 5 and fall back to Layer 6 (browser tunnel — can still download the encrypted stream but play starts)
- Error handling: license server may return error codes (too many devices, geo-blocked, expired subscription)

---

### 4.7 Layer 6 — Browser-Tunneled Download (Enhanced)

**Purpose:** When all other layers fail (Cloudflare blocks, token expires, DRM can't extract keys), fall back to downloading through the actual browser session — using the browser's authenticated network stack.

**Two sub-strategies:**

#### Strategy A: CDP Tunnel (Existing — via chrome.debugger)

```
[CDP Tunnel Flow]
       │
       ▼
1. Attach chrome.debugger to tab (already implemented)
2. Enable Network domain
3. For each segment/URL:
   ├── Inject iframe with the URL to trigger the browser's fetch
   ├── OR use Page.downloadBehavior (if available) 
   ├── OR inject fetch() call via Runtime.evaluate:
   │     fetch(url, { credentials: 'include', headers: ... })
   │       .then(r => r.arrayBuffer())
   │       .then(buf => { /* send back via CDP */ })
   └── Capture response via CDP or message channel
4. Reassemble captured segments
```

#### Strategy B: Cookie/Header Extraction + External Download (Existing)

```
[Cookie Extraction Flow]
       │
       ▼
1. CDP: Network.getCookies() → extract all cookies for the domain
2. CDP: Runtime.evaluate → extract localStorage/IndexedDB tokens
3. Inject extracted cookies + headers into native host download requests:
   ├── aria2c: --header="Cookie: ..." --header="User-Agent: ..."
   ├── yt-dlp: --add-header="Cookie:..."
   └── curl_cffi: reuse as-is
4. If Cloudflare still blocks: rotate user-agent, TLS fingerprint, IP (proxy rotation?)
```

**Required additions:**
- Auto-detect when Cloudflare blocks and immediately escalate to browser tunnel
- Rate limit browser tunnel usage (each fetch consumes tab resources)
- Progress reporting through browser tunnel (CDP events or SW messages)
- Concurrent segment downloads through browser tunnel (max 4 concurrent)
- Memory management: stream large responses to disk via IndexedDB temporary storage

---

## 5. Cloudflare Anti-Bot Bypass — Combined Strategy

Cloudflare protection is the most common blocker. From the interview, ALL approaches should be implemented:

### 5.1 TLS Fingerprint Impersonation (Existing — curl_cffi)
- Currently uses `chrome` or `chrome{VERSION}` impersonation
- Extend to rotate between Chrome 120, 124, 127, 131 fingerprints
- Also add Safari and Firefox fingerprints for diversity
- Implement retry with different fingerprint on 403

### 5.2 Cookie Recycling from Browser Session (NEW)
- At download start, extract full cookie jar via CDP: `Network.getAllCookies()`
- Also extract localStorage/IndexedDB tokens that may be used for API auth
- Pass cookies to ALL download backends (yt-dlp, aria2c, curl_cffi, N_m3u8DL-RE)
- Rate-limit polling: re-extract cookies every 60 seconds during download

### 5.3 Browser-Solver (NEW)
- When Cloudflare Turnstile/CAPTCHA is detected in response body:
  1. Open page in a hidden incognito window or the active tab
  2. Wait for user to solve the challenge (or detect if already solved)
  3. Extract the cf_clearance cookie from the solved session
  4. Inject cookie into download backends
- This is the most reliable approach for tough Cloudflare targets

### 5.4 Headless Browser Proxy (Optional — Future)
- Spin up a Playwright/Puppeteer-controlled browser as a download proxy
- All download requests go through this browser's network stack
- Pro: handles all JS challenges, fingerprinting, and CAPTCHAs
- Con: very resource-intensive, slow, requires Playwright system dependency
- Consider only for specific high-value sites where other methods fail

### 5.5 Detection Enhancement
- Improve Cloudflare detection in probe backends:
  - Check response body for `cf-browser-verification`, `cf-challenge`, `cloudflare` + `just a moment`
  - Check response body for Turnstile widget HTML
  - Differentiate between WAF block (403) vs. JS challenge (503 with `cf-browser-verification`)

---

## 6. Service Worker Capture — Detailed Design

### 6.1 Registration Strategy

```javascript
// src/content/service_worker_capture.js

// Attempt to register a SW that captures media responses.
// SW scope must match the page origin. We register with the
// narrowest possible scope (page path) to avoid interfering
// with any existing SW on the site.

async function initMediaCaptureSW() {
  // Check if SW is supported
  if (!('serviceWorker' in navigator)) return false;

  // Check if page already has a controlling SW
  const existingSW = navigator.serviceWorker.controller;
  if (existingSW) {
    // Try to communicate with existing SW about media capture
    // (if the site's own SW cooperates — rare)
    return false;  // Don't override existing SW
  }

  // Generate capture SW code as a blob URL
  const swBlob = new Blob([generateCaptureSWCode()], {
    type: 'application/javascript'
  });
  const swURL = URL.createObjectURL(swBlob);

  try {
    const registration = await navigator.serviceWorker.register(swURL, {
      scope: window.location.pathname  // Narrow scope to current page
    });

    // Set up communication channel
    setupMessageChannel(registration);
    return true;
  } catch (e) {
    // SW registration failed — fall back to CDP capture
    console.warn('[Qwin] SW capture registration failed:', e);
    return false;
  }
}
```

### 6.2 Service Worker Capture Code

```javascript
// Generated SW code (runs in SW context)
function generateCaptureSWCode() {
  return `
    const MEDIA_TYPES = /^(video\\/|application\\/(x-mpegURL|vnd\\.apple\\.mpegURL|dash\\+xml|x-mpegURL))|\\/(m3u8|mpd|m4s)$/i;
    let capturedCount = 0;
    const MAX_CAPTURES = 5000;

    self.addEventListener('fetch', (event) => {
      const url = event.request.url;
      const contentType = '';  // Not available until response

      // Pass through normally — we'll inspect the response
      const responsePromise = handleFetch(event);
      if (responsePromise) {
        event.respondWith(responsePromise);
      }
    });

    async function handleFetch(event) {
      try {
        const response = await fetch(event.request);
        const contentType = response.headers.get('content-type') || '';

        // Check if this is media content
        if (MEDIA_TYPES.test(contentType) || looksLikeSegment(event.request.url)) {
          if (capturedCount < MAX_CAPTURES) {
            capturedCount++;
            // Clone the response so we can read the body
            const clonedResponse = response.clone();
            const body = await clonedResponse.arrayBuffer();

            // Send to client via message channel
            const clientId = event.resultingClientId || event.clientId;
            if (clientId) {
              const client = await self.clients.get(clientId);
              if (client) {
                client.postMessage({
                  type: 'mediaResponse',
                  url: event.request.url,
                  contentType: contentType,
                  bodyLength: body.byteLength,
                  body: bufferToBase64(body),
                  status: response.status,
                  headers: [...response.headers.entries()],
                });
              }
            }
          }
        }
        return response;
      } catch (e) {
        return fetch(event.request);
      }
    }

    function looksLikeSegment(url) {
      return /\\.(ts|m4s|cmfv|cmfa)(\\?|$)/i.test(url) ||
             /\\/seg(ment)?[-_]?\\d+/i.test(url);
    }

    function bufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }
  `;
}
```

### 6.3 Edge Cases
- **Cross-origin CDN requests:** SW cannot access response body for opaque responses (no CORS). Fall back to CDP capture for cross-origin media.
- **Range requests (206 Partial Content):** Player requests byte ranges. SW must correctly proxy these. Capture only the final assembled response.
- **Large responses:** >500MB will crash SW. Limit capture to first 100MB and use Content-Length/Range headers to estimate total size.
- **Multiple SW instances:** Only register SW if no existing SW controls the page. If existing SW exists, try to communicate via postMessage instead.

---

## 7. MSE/fMP4 Demuxing — Detailed Design

### 7.1 Current Approach
Current `media_source_intercept.js` captures SourceBuffer.appendBuffer calls, converts to base64, and sends to background. The segments are then forwarded to the Go binary for assembly. This works for simple cases but doesn't properly handle fMP4 structure.

### 7.2 Required: Proper fMP4 Parsing

Build a proper fMP4 parser in Python (or extend Go binary). The parser must handle:

**ISO BMFF Box Hierarchy:**
```
ftyp → File Type Box (major brand, compatible brands)
moov → Movie Box (global metadata — needed once)
├── mvhd → Movie Header (timescale, duration)
├── trak → Track (one per audio/video/subtitle)
│   ├── tkhd → Track Header (width, height, language)
│   └── mdia → Media
│       ├── mdhd → Media Header
│       ├── hdlr → Handler (video, audio, subtitle)
│       └── minf → Media Information
│           └── stbl → Sample Table
│               ├── stsd → Sample Description (codec config — needed for playback)
│               ├── stts → Time-to-Sample
│               ├── stsc → Sample-to-Chunk
│               ├── stsz → Sample Sizes
│               └── stco → Chunk Offsets
moof → Movie Fragment Box (per segment)
├── mfhd → Movie Fragment Header (sequence number)
└── traf → Track Fragment
    ├── tfhd → Track Fragment Header (track ID, flags, base data offset)
    ├── tfdt → Track Fragment Base Media Decode Time
    └── trun → Track Fragment Run (sample sizes, durations, flags)
mdat → Media Data Box (raw sample bytes)
```

**Reassembly Algorithm:**

```
Input: [initSegment, seg1, seg2, seg3, ...] (each is a buffer of moof+mdat or ftyp+moov)

1. Parse ftyp + moov from init segment → extract tracks, codecs, timescale, sample table
2. For each subsequent segment:
   a. Parse moof → get sequence number, track ID, sample count, sample sizes
   b. Read mdat at correct offset → extract sample bytes
   c. Group samples by track ID (usually 1=video, 2=audio)
3. Build new output file:
   Option A (Quick): Concatenate init segment + all moof+mdat pairs
     → May work if segment order is correct and no gaps
   Option B (Robust): Build fresh ftyp + moov from parsed metadata
     → Concatenate all samples in decode order
     → Write new moov with correct sample table
     → Write concatenated mdat
   Option C (ffmpeg-based): Write raw bitstream (annex-b for H.264) + AAC ADTS
     → Pipe to ffmpeg for remuxing
     → Most reliable for unusual codecs/structures
```

### 7.3 Implementation in Python

```python
# src/native_host/fmp4_demuxer.py

class ISOBox:
    """Represents a single ISO BMFF box."""
    def __init__(self, size, type, data, children=None):
        self.size = size
        self.type = type  # 4-char code: 'ftyp', 'moov', 'moof', etc.
        self.data = data  # raw bytes for leaf boxes
        self.children = children or []  # child boxes for container boxes

class FMP4Demuxer:
    """Demuxes fragmented MP4 streams into playable files."""

    def parse_init_segment(self, data: bytes) -> dict:
        """Parse ftyp + moov → return track info."""

    def parse_moof(self, data: bytes) -> list[dict]:
        """Parse movie fragment → extract sample info per track."""

    def read_mdat_samples(self, data: bytes, samples: list[dict], offset: int=0) -> list[bytes]:
        """Extract raw sample data from mdat box."""

    def demux_streams(self, init_seg: bytes, media_segs: list[bytes]) -> dict[int, list[bytes]]:
        """Group samples by track ID across all segments."""

    def remux_to_mp4(self, tracks: dict[int, list[bytes]], init_info: dict) -> bytes:
        """Build a valid flat MP4 from demuxed tracks."""

    def remux_to_raw(self, tracks: dict[int, list[bytes]], init_info: dict) -> dict[int, bytes]:
        """Extract raw bitstreams (annex-b H.264, AAC ADTS) for ffmpeg."""
```

### 7.4 Segment Assembly in Go (Existing + Extended)

The Go binary (`decrypt.go`) currently handles AES-128 CTR decryption and segment concatenation. Extend it to:

1. Parse fMP4 boxes (ftyp, moov, moof, mdat)
2. Handle Common Encryption (cenc/cbcs) — detect `sinf`, `schm`, `tenc` boxes
3. Decrypt sample data from `mdat` using keys from License
4. Re-encrypt into clear MP4 or write decrypted samples into new moof+mdat

---

## 8. CDM Key Extraction — Enhanced Flow

### 8.1 Current Capabilities (Go binary)
- CDM init: Load widevinecdm.dll, detect version, check L1 status
- Key extraction: Parse license response, unwrap keys using session key
- Segment decryption: AES-128 CTR mode (for HLS) + AES-128 CBC (for DASH CENC)
- Segment assembly: Concatenate decrypted segments into .mp4

### 8.2 Required Enhancements

**Multi-DRM Support:**
- PlayReady SL2000: Parse PlayReady object, handle AES-128 CTR/CBC
- FairPlay: Handle SINF data, FPS key system (requires macOS/iOS-specific handling)

**Challenge Caching:**
- Cache init data (PSSH) per session to avoid redundant CDM init
- Store challenge → response mappings for session reuse

**Error Recovery:**
- If key extraction fails (e.g., L1-only content, revoked CDM, device limit):
  1. Report error with clear message
  2. Fall back to Layer 6 (browser tunnel — user watches, we capture frames)

**Key Handling:**
- Support multiple keys per session (some streams have per-track keys)
- Support key rotation (new key per segment/timestamp)
- Key format: `key_id:key_value` (hex) for Go binary, `kid:k` (base64) for mp4decrypt

---

## 9. Browser-Tunneled Download — Detailed Design

### 9.1 Smart Hybrid Strategy

```
┌──────────────────────────────┐
│   Request segment download   │
└──────────┬───────────────────┘
           ▼
    ┌──────────────┐
    │ Try external  │  ← Try curl_cffi/aria2c first
    │ download      │
    └──────┬───────┘
           │
     ┌─────┴─────┐
     │  Success? │
     └─────┬─────┘
      Yes  │  No (403/401/blocked)
       │   │
       │   ▼
       │  ┌──────────────────┐
       │  │ Extract cookies   │  ← CDP Network.getCookies()
       │  │ + headers from    │
       │  │ browser session   │
       │  └──────┬───────────┘
       │         ▼
       │  ┌──────────────────┐
       │  │ Retry external    │  ← Retry with cookies + headers
       │  │ with session data │
       │  └──────┬───────────┘
       │         ▼
       │    ┌─────────┐
       │    │ Success? │
       │    └────┬────┘
       │    Yes  │ No
       │     │   │
       │     │   ▼
       │     │  ┌──────────────────┐
       │     │  │ Tunnel through   │  ← CDP fetch + capture
       │     │  │ browser (CDP)    │
       │     │  └──────┬───────────┘
       │     │         ▼
       │     │    Downloaded!
       ▼     ▼
  Complete!  Complete!
```

### 9.2 CDP Fetch Tunnel Implementation

```javascript
// src/background/cdp_tunnel_download.js

async function tunnelSegmentDownload(tabId, url, requestHeaders) {
  // Strategy: inject a fetch() call via CDP Runtime.evaluate
  // that returns the response as base64

  const script = `
    (async function() {
      try {
        const response = await fetch(${JSON.stringify(url)}, {
          method: 'GET',
          credentials: 'include',
          headers: ${JSON.stringify(requestHeaders || {})}
        });
        if (!response.ok) return { ok: false, status: response.status };
        const blob = await response.blob();
        return { ok: true, data: await blob.arrayBuffer(), type: blob.type };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    })()
  `;

  const result = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: script,
    returnByValue: false,  // returns handle to object
    awaitPromise: true,
    timeout: 30000,
  });

  // Convert ArrayBuffer handle to base64 via another call
  // ... (CDP can't transfer ArrayBuffers directly, need conversion)
}
```

**Alternative: Stream resource content via CDP**

```javascript
// Use Network.loadNetworkResource or Fetch.enable + pattern matching
// to stream downloads through the browser without injecting JS

await sendCommand(tabId, 'Fetch.enable', {
  patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }]
});
// Then process Fetch.requestPaused events for media URLs
```

---

## 10. Error Handling & Recovery

### 10.1 Layered Fallback Chain

```
Layer 1 (Probes)       → FAIL? → Layer 2 (CDP extract)
Layer 2 (CDP extract)  → FAIL? → Layer 3 (SW capture)
Layer 3 (SW capture)   → FAIL? → Layer 4 (MSE demux)
Layer 4 (MSE demux)    → FAIL? → Layer 5 (CDM decrypt)
Layer 5 (CDM decrypt)  → FAIL? → Layer 6 (Browser tunnel)
Layer 6 (Browser tunnel)→ FAIL? → Report "Cannot capture this video"
```

### 10.2 Error Classification

| Error Type | Meaning | Action |
|---|---|---|
| `cloudflare_block` | Cloudflare JS challenge/Turnstile | Extract cf_clearance cookie, retry + escalate to browser tunnel |
| `token_expired` | Signed URL has expired | Fast parallel download of remaining segments |
| `l1_only_drm` | Hardware-backed DRM, can't extract keys | Fall back to browser tunnel (browser can play it) |
| `no_segments` | MSE intercept found no segments | Try CDP Runtime.evaluate to trigger player load |
| `cors_blocked` | SW can't read cross-origin response body | CDP Network capture for that domain |
| `license_denied` | License server refused (geo-block, expired sub) | Report specific error to user |
| `unknown_protection` | Unrecognized protection mechanism | Capture raw bytes for analysis |

### 10.3 Reporting
- Each layer reports its result (success/failure/reason) to the download log
- Final error message tells the user which layers were attempted and what failed
- Detect common patterns (e.g., "This site uses Widevine L1 DRM — try playing the video in the tab and use 'capture screen' as fallback")

---

## 11. File Changes & New Files Summary

### New Files to Create

| File | Purpose | Layer |
|---|---|---|
| `src/content/service_worker_capture.js` | Register + communicate with media capture SW | 3 |
| `src/native_host/fmp4_demuxer.py` | fMP4 box parsing + track demuxing + MP4 reassembly | 4 |
| `src/background/cdp_tunnel_download.js` | CDP-based browser tunnel for downloads | 6 |
| `src/background/sw_relay.js` | Relay SW-captured segments from content → native host | 3 |
| `src/shared/media_protocols.js` | Shared patterns for protocol detection (CMS, transfer modes) | 0 |
| `go/fmp4.go` | Go-based fMP4 box parsing for decrypted segment assembly | 4/5 |
| `tests/native-host/test_fmp4_demuxer.py` | Tests for fMP4 demuxer | 4 |
| `tests/extension/background/test_cdp_tunnel.js` | Tests for CDP tunnel download | 6 |
| `tests/extension/content/test_service_worker_capture.js` | SW capture tests | 3 |

### Existing Files to Modify

| File | Changes | Layer |
|---|---|---|
| `src/content/content.js` | Add SW capture init, enhanced blob detection | 0/3 |
| `src/content/media_source_intercept.js` | Enhanced fMP4 init detection, better segment ordering | 4 |
| `src/content/eme_intercept.js` | FairPlay/PlayReady support, multi-key, session caching | 5 |
| `src/background/cdm_network_intercept.js` | Enhanced license response capture, key rotation detection | 5 |
| `src/background/download_orchestration.js` | Add new layer fallbacks, SW tunnel flow | All |
| `src/native_host/download_manager.py` | SW segment processing, fMP4 assembly integration | 4 |
| `src/native_host/capture_manager.py` | Multi-session CDM support | 5 |
| `src/native_host/media_resolver.py` | Enhanced page scanning with SW-extracted data | 0 |
| `src/background/cdp_extraction.js` | Shadow DOM, iframe recursion, mutation waiting | 2 |
| `src/native_host/probe_backends.py` | Enhanced Cloudflare detection, cookie injection | 1 |
| `src/native_host/host_dispatch.py` | New message types for SW segments, fMP4 assembly | All |
| `go/commands.go` | fMP4 handling, multi-key support | 5 |
| `go/decrypt.go` | CENC decrypt, fMP4-aware decryption | 5 |

---

## 12. Implementation Phases

### Phase 1 — Foundation (Weeks 1-3)
1. Enhanced Cloudflare detection in probe backends + cookie injection
2. SW capture registration and message relay (basic capture working)
3. CDP tunnel download (basic working for single segments)
4. Cookie extraction and injection into download backends

### Phase 2 — MSE/DRM Enhancement (Weeks 4-7)
1. fMP4 demuxer in Python (parse init + moof/mdat, reassembly)
2. Enhanced EME intercept (multi-key, session caching)
3. Go binary fMP4 handling (CENC decrypt aware of fMP4 structure)
4. FairPlay/PlayReady detection and handling
5. L1 DRM detection and browser tunnel fallback

### Phase 3 — Robustness & Integration (Weeks 8-11)
1. Full layered fallback chain in download orchestration
2. SW + CDP parallel capture for maximum coverage
3. Token expiry handling (real-time parallel segment capture)
4. Browser tunnel with progress reporting and memory management
5. Comprehensive error reporting to user

### Phase 4 — Polish & Edge Cases (Weeks 12-14)
1. Shadow DOM and iframe recursion in CDP extraction
2. Service Worker recovery (page navigation, SW lifecycle)
3. fMP4 edge cases (multiple tracks, strange segment orders)
4. Performance optimization (parallel segment downloads, memory limits)
5. Extensive testing with real-world sites of varying complexity

---

## 13. Testing Strategy

### Unit Tests
- fMP4 demuxer: parse known-good fragments, verify sample data extraction
- CDP extraction script: test with mock DOM and config objects
- SW capture: test with mock fetch events and response types
- CDM key extraction: test with known license responses

### Integration Tests
- End-to-end with test streams (unencrypted HLS, DASH, direct MP4)
- Cloudflare-protected test URLs (using test sites that implement CF)
- MSE-based players (Shaka Player demo, HLS.js demo)
- DRM test streams (Widevine test content with known keys)

### Real-World Testing
- Top 50 video sites across categories (streaming, social, learning, adult)
- Measure: detection rate, capture success rate, file integrity (playable/complete)
- Performance: memory usage, download speed, CPU usage during SW capture

---

## 14. Risk & Limitations

### Known Limitations
1. **L1 DRM**: Cannot extract keys from hardware-backed Widevine L1. Only option: browser tunnel (user plays + we capture frames via canvas recording — lower quality, higher CPU)
2. **Cross-origin CDN + no CORS**: SW cannot read opaque cross-origin responses. CDP Network capture may also fail if CDP isn't attached to the right target
3. **SW lifecycle**: Service Workers can be killed by the browser after 30s of inactivity. Need keepalive mechanisms or re-registration
4. **Memory**: Capturing large files through SW or CDP tunnel can consume GBs of memory. Need streaming-to-disk or segment limits
5. **Browser performance**: CDP tunnel and SW capture both add overhead to the user's browsing session. The user will notice if many segments are being captured simultaneously

### Mitigation Strategies
- Memory limit: 2GB total capture buffer, spill to disk via IndexedDB
- CPU limit: batch capture requests, limit to 4 concurrent tunnels
- SW keepalive: periodic ping + small dummy fetch to keep SW awake
- L1 fallback: offer "record tab as video" (screen capture) option for hard DRM
- User notification: show capture status in popup (how many segments captured, estimated size)

---

## Appendix A: Flow Diagrams

### A.1 Decision Tree for URL Detection

```
[URL Detected]
    │
    ├── Direct MP4/WebM → [Layer 1] try direct download
    │
    ├── M3U8/MPD/ISM → [Layer 1] try stream backends
    │                   │
    │                   └── Fail → [Layer 3] SW manifest capture
    │                             └── [Layer 6] browser tunnel
    │
    ├── YouTube URL → [Layer 1] yt-dlp
    │
    ├── Blob URL → [Layer 4] MSE demux
    │
    ├── Page URL → [Layer 2] CDP extraction → [Layer 0] rescan
    │
    └── Iframe URL → [Layer 2] recursive extraction
```

### A.2 DRM Flow Diagram

```
[EME Intercepted — initData captured]
    │
    ▼
[Wait for license response via CDP]
    │
    ├── Response captured → [Go binary] extractKeys
    │                       │
    │                       ├── Keys found → [Go binary] decryptSegments
    │                       │               │
    │                       │               └── Success → assemble MP4
    │                       │
    │                       └── L1 only → [Layer 6] browser tunnel
    │
    └── No response (timeout) → [Layer 6] browser tunnel
```
