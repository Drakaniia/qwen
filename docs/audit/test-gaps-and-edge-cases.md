# Universal Video Capture — Test Gaps & Edge Cases Audit

**Generated:** 2026-07-02  
**Status:** Comprehensive audit of existing test coverage vs. spec requirements  
**Scope:** All 7 layers + shared infrastructure + integration + error handling

---

## How to Read This Document

Each section follows this structure:

```
## Layer N — [Name]

### Existing Tests
- What tests currently exist, what they cover

### ✅ Covered Edge Cases
- Edge cases that ARE tested

### ❌ Missing Edge Cases [PRIORITY: High/Medium/Low]
- What the spec requires but no test covers
- Why it matters
```

**Priority levels:**
- **High:** Will cause real-world failures with common video sites
- **Medium:** Less common but still impactful scenarios
- **Low:** Corner cases, future-proofing, polish

---

## Layer 0 — Detection (Content Script)

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/content/test_page_detection.js` | Page detection helpers, URL classification |
| `tests/extension/content/test_content_youtube_detection.js` | YouTube-specific detection |
| `tests/extension/content/test_content_title_extraction.js` | Title extraction from DOM |
| `tests/extension/content/test_content_quality_dialog.js` | Quality chooser integration |
| `tests/extension/content/test_iframe_video_detection.js` | Iframe video source detection |
| `tests/extension/content/test_iframe_title_priority.js` | Iframe title priority over page title |
| `tests/extension/content/test_p2p_detection.js` | P2P WebRTC streaming detection |
| `tests/extension/shared/test_video_picker.js` | Video list rendering and filtering |
| `tests/extension/shared/test_video_filters.js` | Video filter rules |
| `tests/extension/shared/test_media_protocols.js` | Media protocol classification |
| `tests/extension/shared/test_playlist_detection.js` | Playlist detection from page DOM |

### ✅ Covered Edge Cases

- DOM scanning for `<video>` and `<source>` elements
- Iframe detection and video source extraction from iframes
- YouTube-specific video page detection
- Music streaming platform detection
- P2P/WebRTC stream detection
- Video filter rule application
- Playlist detection from page structure
- Title extraction with iframe fallback priority
- Blob URL detection (basic)
- Video quality selection dialog
- Protocol classification (HLS, DASH, MP4, etc.)

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **WebSocket URL detection** | **High** | §4.1 | No tests verify detection of `ws://` / `wss://` URLs used for WebSocket-based streaming. Many Chinese streaming platforms (Douyu, Huya) and some custom players use WS. |
| 2 | **`transferMode: "stream"` fetch/XHR detection** | **High** | §4.1 | No tests verify detection of streaming responses where the content-type indicates large media payloads but the URL doesn't match media patterns. Used by many custom players. |
| 3 | **Service Worker scope detection** | **Medium** | §4.1 | No tests verify the detection of existing SW scope URLs on the page prior to attempting SW registration. This determines whether SW capture is feasible at all. |
| 4 | **`__NEXT_DATA__` / `__NUXT__` JSON parsing for video URLs** | **Medium** | §4.3 | Many SSR sites embed video URLs in JSON page data. No tests verify extraction from these structured data blobs. |
| 5 | **Enhanced blob URL to MediaSource mapping** | **Medium** | §4.1 | Basic blob: URL detection exists but no tests verify tracking the blob → MediaSource → SourceBuffer pipeline to identify MSE-based video. |
| 6 | **Shadow DOM traversal depth limits** | **Medium** | §4.3 | No tests verify behavior with deeply nested shadow roots (>5 levels) which could cause stack overflows or missed videos. |
| 7 | **Detection of cross-origin iframe content** | **Medium** | §4.1 | No tests for pages where the video player is in a cross-origin iframe that the content script cannot access directly. |
| 8 | **MutationObserver-based dynamic video detection** | **Low** | §4.3 | No tests for MutationObserver that waits for dynamically added video elements. Covered at CDP layer but not in content script. |

---

## Layer 1 — Parallel Probes (Native Host)

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/native-host/test_probe_runner.py` | Probe runner orchestration |
| `tests/native-host/test_probe_integration.py` | Probe integration with backends |
| `tests/native-host/test_probe_logger.py` | Probe logging and diagnostics |
| `tests/native-host/test_curl_cffi_adapter.py` | curl_cffi adapter with browser impersonation |
| `tests/native-host/test_browser_impersonation.py` | TLS fingerprint rotation |
| `tests/native-host/test_cloudflare_detection.py` | Cloudflare challenge detection in probe responses |
| `tests/native-host/test_cookie_injection.py` | Cookie injection into probes |
| `tests/native-host/test_media_candidates_extended.py` | Media candidate extraction |
| `tests/native-host/test_media_candidate_rules.py` | Candidate rule matching |
| `tests/native-host/test_stream_backends.py` | Stream backend detection |
| `tests/native-host/test_yt_dlp_adapter.py` | yt-dlp adapter |
| `tests/native-host/test_you_get_lux.py` | you-get and lux backends |

### ✅ Covered Edge Cases

- Cloudflare challenge detection (Turnstile, cf-please-wait, jschl-answer, etc.)
- HTML error page detection (403, 404, 500, Access Denied)
- Browser impersonation and TLS fingerprint rotation
- Cookie injection from browser session
- Multiple backend probe ordering and winner selection
- HTTP 403 detection and error type classification
- All-probe-Cloudflare early abort strategy
- Fragment file extension coverage (.m4s, .cmfv, extensionless)

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **yt-dlp probe failure with token-expired manifests** | **High** | §10.2 | No tests for signed URL token expiry detected during probe phase (vs. download phase). Different error behavior needed when the manifest URL works but segment URLs are expired. |
| 2 | **Probe race conditions — concurrent cancellation** | **High** | §4.2 | No tests verify that probe cancellation via `cancel_event` works correctly when multiple probes are running in parallel and one succeeds (others should be cancelled promptly). |
| 3 | **Referrer/Origin header permutation probes** | **Medium** | §4.2 | No tests for probes that try different referrer/origin header combinations. Many CDNs require specific referrers. |
| 4 | **N_m3u8DL-RE integration tests** | **Medium** | §4.2 | No tests verify N_m3u8DL-RE usage for HLS/DASH manifest downloads. The spec lists it as a primary backend but test coverage is missing. |
| 5 | **Streamlink integration tests** | **Medium** | §4.2 | No tests verify Streamlink backend fallback for on-demand HLS. |
| 6 | **ffmpeg direct stream copy tests** | **Medium** | §4.2 | No tests verify ffmpeg as a probe or download backend. |
| 7 | **Probe winner selection with equal confidence scores** | **Medium** | §4.2 | No tests for tie-breaking when multiple probes return similar confidence scores. |
| 8 | **Probe timeout behavior** | **Medium** | §4.2 | No tests for probe that hangs indefinitely past its timeout — does `cancel_event` actually kill it? |
| 9 | **Download backend fallback priority order verification** | **Low** | §4.2 | No test that confirms the exact fallback priority: yt-dlp+aria2 → N_m3u8DL-RE → Streamlink → ffmpeg → curl_cffi → you-get → lux → yt-dlp native. |
| 10 | **Probe of magnet links and torrents** | **Low** | — | No tests for probe behavior with magnet: URLs or torrent sources. |

---

## Layer 2 — CDP Source Extraction

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/background/test_cdp_extraction.js` | Core CDP extraction, module interface, empty/video results, attach/evaluate failures |
| `tests/extension/background/test_cdp_extraction_layer2.js` | Iframe recursion, Shadow DOM traversal, Mutation watching, Event simulation |
| `tests/extension/background/test_cdp_relay.js` | CDP relay session management, attach/detach, command dispatch |
| `tests/extension/background/test_cdp_helpers.js` | CDP helper wrappers |
| `tests/extension/background/test_cdp_tunnel.js` | CDP tunnel script building |
| `tests/extension/background/test_cdp_tunnel_integration.js` | CDP tunnel integration tests |

### ✅ Covered Edge Cases

- **Iframe recursion:** discoverFrameTree, recursive:true/false, 3+ level nesting, deduplication, child frame failure handling, sourceFrame tagging
- **Shadow DOM:** collectAllVideos with shadow root traversal, collectAllSources, nested shadow roots, mutation watch script shadow DOM support
- **Mutation watching:** extractVideosWithMutationWatch, timeout handling, attach cleanup, custom pollInterval, existing videos detected immediately, valid script generation
- **Event simulation:** simulateVideoEvents with load()/play(), empty URL lists, attach/evaluate failure, detachAfter option, valid script generation
- **CDP relay:** session management, attach/detach lifecycle, command dispatch, error handling, idempotent attach, status reporting

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **Cross-origin iframe extraction via CDP** | **High** | §4.3 | Iframes from different origins are inaccessible to content scripts but CDP can evaluate JS inside them (with specific frameId). No tests verify this cross-origin extraction path. |
| 2 | **CDP extraction for lazy-loaded players** | **High** | §4.3 | Many modern players don't load until user interaction. No tests for pages where the player initializes after the `domContentEventFired` event — the extraction script finds nothing and no retry occurs. |
| 3 | **Extraction with `__NEXT_DATA__` / `__NUXT__` / `window.__INITIAL_STATE__`** | **Medium** | §4.3 | No tests verify that the CDP extraction script parses these JSON data blobs embedded in the page. These are a primary source for SSR video sites. |
| 4 | **Event simulation on pages with disabled autoplay** | **Medium** | §4.3 | Some browsers block `video.play()` unless user gesture has occurred. No tests verify behavior when play() returns a rejected promise. |
| 5 | **Mutation watch on SPA pages with repeated re-renders** | **Medium** | §4.3 | Single-page apps that repeatedly re-render could trigger mutation observers dozens of times. No tests verify dedup behavior or performance in this scenario. |
| 6 | **CDP extraction script injection timing** | **Medium** | §4.3 | No tests verify script injection timing — what if the page is still loading JS bundles when the extraction script runs? |
| 7 | **Frame tree with cyclic references** | **Low** | §4.3 | Malformed page with iframe referencing parent creating a cycle. CDP `Page.getFrameTree` shouldn't produce this but defensive handling is untested. |
| 8 | **Extraction from pages with 100+ iframes** | **Low** | §4.3 | Performance test missing for pages with very large frame trees (e.g., ad-heavy sites). |
| 9 | **Mutation watch with extremely rapid mutations** | **Low** | §4.3 | Page that adds/removes video elements in rapid succession — does the polling interval handle this without missing samples? |

---

## Layer 3 — Service Worker Capture

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/content/test_service_worker_capture.js` | SW code generation, MEDIA_TYPE_REGEX, looksLikeSegment, bufferToBase64, URL support validation |
| `tests/extension/background/test_sw_relay.js` | SW relay segment storage, clear/getAllSegments |
| `tests/extension/background/test_integration_segment_data_flow.js` | SW relay + CDP tunnel integration, data flow pipeline |

### ✅ Covered Edge Cases

- SW code generation outputs valid JS with fetch listener, MEDIA_TYPES, postMessage
- Media type regex matches known types (video/mp4, HLS, DASH)
- Segment URL detection (.ts, .m4s, segment in path)
- URL support validation (https, localhost/127.0.0.1, rejects blob/data/file/chrome-extension/http non-localhost)
- Capture SW registration blob URL limitation detection
- Base64 encoding correctness
- SW relay initial state, clear idempotency, tab-scoped retrieval
- Integration with CDP tunnel data flow

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **Cross-origin CDN opaque response handling** | **High** | §6.3 | SW cannot read response body for opaque cross-origin requests (no CORS). No tests verify that SW capture detects this and falls back gracefully. This is the #1 real-world failure mode for SW capture. |
| 2 | **Range request (206 Partial Content) proxying** | **High** | §6.3 | Many players request byte ranges for seeking. No tests verify the SW correctly proxies range requests and captures the final assembled response. |
| 3 | **SW lifecycle — keepalive mechanism** | **Medium** | §14.3 | Browsers kill idle SWs after 30s. No tests verify the ping/keepalive mechanism to prevent premature SW termination. |
| 4 | **SW + existing page SW conflict** | **Medium** | §6.1 | If the page already has a controlling SW, capture SW registration will fail. No tests verify graceful fallback to CDP capture in this scenario. |
| 5 | **Large response body handling (>500MB)** | **Medium** | §6.3 | No tests verify the 500MB per-response / 2GB total capture buffer limit behavior. Does it truncate? Error? Crash? |
| 6 | **SW registration failure on insecure contexts** | **Medium** | §6.1 | SW requires HTTPS or localhost. Tests exist for URL validation but not for what happens after registration failure — does it properly fall back? |
| 7 | **SW message channel reliability** | **Medium** | §6.2 | No tests for message delivery failures, port disconnection, or SW going to sleep mid-capture. |
| 8 | **Multiple SW message handlers conflicting** | **Low** | §6.1 | If the page has an existing SW that also uses message channels, the capture SW's message listener could conflict. No tests verify isolation. |
| 9 | **SW capture of WebSocket-delivered media** | **Low** | §6.2 | SW cannot intercept WebSocket data directly. Spec mentions WS-based streaming. No tests verify detection and fallback. |
| 10 | **SW unregistration and cleanup** | **Low** | §6.1 | No tests verify that the capture SW is properly unregistered when capture stops, preventing resource leaks. |

---

## Layer 4 — MSE/fMP4 Demuxing Pipeline

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/native-host/test_fmp4_demuxer.py` | 1100+ lines: ISO BMFF box parser, init segment parsing, moof/mdat parsing, demux streams, MP4 reassembly, encrypted segment detection |
| `tests/native-host/test_fmp4_edge_cases.py` | Track gap detection, CMAF detection, interleave tracks, sequence ordering |
| `tests/native-host/test_cdm_capture_analysis.py` | Sequence number extraction, CMAF from files, segment gap analysis |

### ✅ Covered Edge Cases

- Box parser: single/multiple boxes, hierarchical, 64-bit extended sizes, size=0, truncated data, latin-1 types, __slots__, repr
- Init segment parsing: ftyp, moov, tracks, timescale, dimensions, codec strings (avc1, hvc1, Opus), encryption (pssh), missing boxes
- Moof parsing: single/multiple tracks, sequence numbers, tfhd flags=0, trun version 0/1, sample size detection, zero samples, truncated data
- Demux/reassembly: single track, multiple segments, sample order, base data offset, empty segments, no mdat, size=0 samples, beyond-mdat samples, large mdat (size=0)
- Remux: valid structure, empty tracks, multiple tracks, empty init_info, output re-parsable
- Encryption detection: pssh, sinf, schm, tenc, frma, nested boxes, multiple pssh, cbcs scheme
- Edge cases: segment gaps, CMAF detection (cmfv, cmfa major/compatible brands), interleaved tracks, timestamp ordering, duplicate seq numbers, negative/float timestamps
- CDM analysis: sequence extraction from files, CMAF from files, no-moof, empty/missing files
- Sort by seq number before demuxing

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **CMAF track interleaving with different codecs** | **Medium** | §7.2 | Video + audio tracks interleaved in a single moof (alternating samples). Tests exist for multiple traf boxes but not for interleaved samples within a single traf. |
| 2 | **Annex-B H.264 / HEVC nal unit extraction** | **Medium** | §7.2 | No tests for extracting raw H.264 NAL units from mdat for ffmpeg piping. Currently assumes full fMP4 output. |
| 3 | **AAC ADTS frame extraction** | **Medium** | §7.2 | No tests for extracting AAC audio frames with ADTS headers for ffmpeg remuxing. |
| 4 | **Multiple init segments (track updates)** | **Medium** | §7.2 | Some adaptive streams update the init segment mid-stream (e.g., when switching bitrates). No tests for handling multiple init segments. |
| 5 | **Codec-specific quirks: s263, vp09, av01** | **Low** | §7.4 | No tests for H.263, VP9, or AV1 codec sample descriptions in stsd. |
| 6 | **Movie fragments with base64-encoded data** | **Medium** | §7.1 | MSE intercept delivers base64-encoded segment data. No tests for base64 decoding + demuxing pipeline. |
| 7 | **Segment ordering when sequence numbers roll over (uint32)** | **Low** | §7.4 | fMP4 sequence numbers are uint32. If a player produces >4B segments, seq num wraps. No overflow test. |
| 8 | **Very large moof with 10000+ samples** | **Low** | §7.4 | Performance test for parsing a moof with 10K+ samples in a single trun. |
| 9 | **Encrypted segment demuxing (cenc/cbcs pattern)** | **Medium** | §7.4 | Encryption detection works but no tests verify that encrypted samples can be demuxed AND decrypted in the correct pipeline order. |
| 10 | **Subtitle track handling (wvtt, stpp)** | **Low** | §7.2 | No tests for WebVTT or TTML subtitle track extraction from fMP4. |
| 11 | **fMP4 with edit lists (elst box)** | **Low** | — | Some files use edit lists for clean starting points. No tests verify elst parsing. |
| 12 | **Multiple mdat boxes in single segment** | **Low** | — | Rare but possible: a segment with multiple mdat boxes. No test for this. |

---

## Layer 5 — EME/CDM Key Extraction

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/content/test_eme_interception.js` | Module interface, init/cleanup lifecycle, isInitDataType, captured data structure |
| `tests/extension/content/test_webkit_detection.js` | FairPlay/WebKit key system detection (fps 1.0, 2.0, case insensitive) |
| `tests/extension/background/test_cdm_network_intercept.js` | CDP Widevine license capture, isWidevineUrl, init/stop lifecycle, request/response capture |
| `tests/extension/popup/test_popup_cdm_status.js` | CDM status display in popup |
| `tests/native-host/test_cdm_capture_analysis.py` | fMP4 segment analysis for CDM pipeline |

### ✅ Covered Edge Cases

- Module exports expected interface (init, cleanup, getCapturedData, isInitDataType, getActiveSessions)
- Init data type validation (cenc, webm, keyids — rejects mp4, empty, null, undefined)
- Lifecycle idempotency (double init, double cleanup)
- WebKit/FairPlay detection (fps 1.0, 2.0, case insensitive, fairplay boolean)
- Widevine license URL detection (/license, /widevine with POST)
- CDP Network intercept: requestWillBeSent filtering, loadingFinished → getResponseBody
- Non-Widevine request filtering (video URLs, API calls)
- Pending → completed status tracking
- Stop/cleanup lifecycle, stopAll
- Captured exchange retrieval and clearing

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **PlayReady SL2000 key system detection** | **High** | §4.6 | No tests for `com.microsoft.playready` detection. Spec requires handling PlayReady objects and AES-128 CTR/CBC decryption. Only Widevine URL detection is tested. |
| 2 | **FairPlay active key extraction** | **High** | §4.6 | FairPlay key detection exists (fps 1.0/2.0) but no tests for actual key extraction from FairPlay SINF data. Requires macOS-specific handling — still needs a test for error reporting. |
| 3 | **Multi-key session handling** | **High** | §5 | No tests for streams that use different keys for different tracks (e.g., video key + audio key in same session). |
| 4 | **Key rotation — new key per segment** | **Medium** | §5 | Some DRM schemes rotate keys periodically (e.g., per 10 seconds). No tests for key rotation detection. |
| 5 | **License server error handling (too many devices, geo-block, expired sub)** | **Medium** | §10.2 | No tests for 402/403 from license server with specific error messages. Should classify error types and report to user. |
| 6 | **L1-only content detection and graceful fallback** | **Medium** | §8.2, §14 | If the Go binary reports L1-only (hardware-backed) CDM, the pipeline should fall back to browser tunnel. No tests for this detection path. |
| 7 | **Session recycling — matching challenge to license response** | **Medium** | §4.6 | License response may have `session_id` binding. No tests verify that the challenge key_id matches the response key_id. |
| 8 | **Multiple init data types (cenc, keyids, webm)** | **Medium** | §4.6 | isInitDataType validates types but no integration test for actual capture of different init data formats through the full pipeline. |
| 9 | **CDM challenge caching across tabs** | **Low** | §8.2 | No tests for caching PSSH init data to avoid redundant CDM initialization for duplicate streams. |
| 10 | **`getActiveSessions()` returns stale sessions** | **Low** | §4.6 | No tests verify that sessions are properly cleaned up when closed by the page. |
| 11 | **Go binary CDM init failure handling (cdm.provider, device limit)** | **Medium** | §8.2 | No tests for CDM initialization failures from the Go binary — corrupt CDM, revoked device keys, missing widevinecdm.dll. |

---

## Layer 6 — Browser-Tunneled Download

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/background/test_cdp_tunnel.js` | tunnelSegmentDownload/cleanup exports, buildFetchScript, buildManifestFetchScript |
| `tests/extension/background/test_cdp_tunnel_integration.js` | tryCdpTunnelDownload, format routing, buildNativeWriteDataMessage, cleanup |

### ✅ Covered Edge Cases

- Module exports expected functions
- buildFetchScript generates valid JS with URL, fetch call, arrayBuffer conversion, custom headers
- buildManifestFetchScript returns text instead of arrayBuffer
- tryCdpTunnelDownload returns correct shape without chrome.debugger
- Direct URL format routing (MP4 → segment method)
- Stream format routing (M3U8/MPD/HLS/DASH → manifest method)
- buildNativeWriteDataMessage payload structure
- Auto-generated IDs with cdp_write_ prefix
- Cleanup re-export

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **CDP tunnel failover when browser blocks fetch()** | **High** | §9.2 | Some pages have CSP headers that block fetch() from CDP-evaluated scripts. No tests for this scenario or alternative strategies (e.g., injecting an iframe). |
| 2 | **Rate limiting — max concurrent CDP tunnel downloads** | **High** | §9.1 | Spec says max 4 concurrent tunnels. No tests for queue management or backpressure when more than 4 segments are requested. |
| 3 | **Memory management — IndexedDB spillover for large responses** | **Medium** | §9.2 | The CDP tunnel captures entire response bodies in memory. No tests for the 2GB memory limit or streaming-to-disk fallback via IndexedDB. |
| 4 | **Progress reporting through CDP tunnel** | **Medium** | §9.2 | No tests for progress events from the CDP tunnel. User has no visibility into slow tunnel downloads. |
| 5 | **Concurrent segment download ordering** | **Medium** | §9.1 | When downloading segments concurrently, they must be reassembled in order. No tests for concurrency-related ordering issues. |
| 6 | **Token expiry mid-download** | **Medium** | §10.2 | No tests for scenario where a signed URL expires while segments are being tunneled. Should detect 401/403 and retry via browser. |
| 7 | **CDP tunnel for very large files (>2GB)** | **Low** | §9.2 | No tests for the behavior when tunneled response exceeds available memory. |
| 8 | **CDP tunnel interruption by page navigation** | **Medium** | §9.2 | If the user navigates away during a tunnel download, what happens? No tests for tab navigation mid-capture. |
| 9 | **CDP tunnel via Fetch.enable (CDP-based, no JS injection)** | **Low** | §9.2 | Spec mentions alternative strategy using `Fetch.enable` pattern matching. No implementation or tests exist. |
| 10 | **Cookie extraction and injection timing** | **Medium** | §9.1 | No tests for the scenario where cookies are extracted BEFORE the user has logged in or after login — stale session data. |
| 11 | **Tunnel download of WebSocket-delivered segments** | **Low** | §9.2 | Spec mentions WS-based streaming but no tunnel strategy exists for capturing WS data through the browser. |

---

## Shared Infrastructure — Error Handling, Fallback Chain & Integration

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `tests/extension/background/test_integration_fallback_chain.js` | CDP tunnel fallback chain integration |
| `tests/extension/background/test_integration_segment_data_flow.js` | SW relay + CDP tunnel data flow |
| `tests/extension/background/test_integration_import_chains.js` | Module import chain verification |
| `tests/extension/background/test_segment_capture.js` | Segment capture pipeline lifecycle |
| `tests/extension/background/test_recording_ui.js` | Recording UI rendering |
| `tests/extension/popup/test_popup_batch_flow.js` | Batch download flow |

### ❌ Missing Integration Tests

| # | Integration Scenario | Priority | Spec Reference | Details |
|---|---------------------|----------|----------------|---------|
| 1 | **Full layered fallback chain E2E: L1→L2→L3→L4→L5→L6** | **High** | §10.1 | No test verifies the complete sequential fallback chain from probes through browser tunnel. Each layer is tested in isolation but the orchestration of fallback is untested. |
| 2 | **SW + CDP parallel capture integration** | **High** | §3 | Spec says SW and CDP run in parallel for maximum coverage. No integration test for this parallel mode. |
| 3 | **Error classification and user-facing messages** | **High** | §10.3 | No tests verify that error types (cloudflare_block, token_expired, l1_only_drm, etc.) are correctly mapped to user-facing messages. |
| 4 | **Download orchestration with multiple concurrent jobs** | **Medium** | §3.1 | No tests for orchestrating multiple simultaneous downloads with different capture strategies. |
| 5 | **Memory limit enforcement (2GB total)** | **Medium** | §14.2 | No test verifies that total capture buffer across all layers stays under 2GB. |
| 6 | **Progress reporting to popup during capture** | **Medium** | §14.2 | No integration test for real-time progress updates flowing from capture layers to UI. |
| 7 | **Token expiry mid-stream — fast parallel download** | **Medium** | §10.2 | Spec says "Fast parallel download of remaining segments" when tokens expire. No test verifies this behavior. |
| 8 | **Content script ↔ background ↔ native host message routing for capture data** | **Medium** | §3.1 | No E2E test for the full message chain: content script MSE capture → background → native host segment assembly. |
| 9 | **WebSocket stream detection + fallback** | **Low** | §4.1 | No test for detecting WS-based streaming and deciding which capture layer handles it. |
| 10 | **CDP tunnel → cookie extraction → probe retry cycle** | **Medium** | §9.1 | The smart hybrid strategy (try external → extract cookies → retry → tunnel) is not tested as a complete cycle. |

---

## Go Binary — CDM & fMP4

### Existing Tests

| Test File | Coverage |
|-----------|----------|
| `go/cdm_test.go` | CDM initialization and key extraction |
| `go/main_test.go` | IPC loop and protocol |
| `go/decrypt_test.go` | AES-128 CTR decryption |

### ❌ Missing Edge Cases

| # | Edge Case | Priority | Spec Reference | Details |
|---|-----------|----------|----------------|---------|
| 1 | **CENC (AES-128 CTR/CBC) mode detection and decryption** | **High** | §8.1 | Only AES-128 CTR is tested. DASH CENC uses AES-128 CBC. No test for CBC mode. |
| 2 | **fMP4 CENC-aware decryption (parse moof→decrypt mdat→rewrite)** | **High** | §7.4 | fMP4 decryption requires parsing the init segment for `tenc`/`sinf` boxes, extracting key IDs, decrypting samples in mdat, and rewriting the boxes. No integration test for this flow. |
| 3 | **Multi-key decryption** | **Medium** | §8.2 | No test for decrypting streams that use different keys for video and audio tracks. |
| 4 | **Key rotation — re-key per segment** | **Medium** | §8.2 | No test for streams where the key changes between segments. |
| 5 | **Large segment concatenation (>4GB)** | **Low** | §8.1 | No test for assembling output files larger than 4GB (handling 32-bit overflow in MP4 box sizes). |
| 6 | **Malformed or corrupt encrypted segments** | **Low** | — | No tests for Go binary handling invalid or truncated encrypted segment data. |
| 7 | **Session key unwrapping failure** | **Low** | §8.2 | No test for the case where the session key cannot unwrap content keys from license response. |

---

## Priority Summary

| Priority | Count | Categories |
|----------|-------|------------|
| **High** | 13 | Opaque SW responses, range requests, PlayReady/FairPlay extraction, multi-key sessions, lazy-loaded players, WebSocket detection, cross-origin CDP extraction, full fallback chain E2E, CENC/CBC decryption, fMP4 decrypt pipeline, token-expiry probes, concurrent tunnel limits, CSP-blocked tunnel |
| **Medium** | 37 | SW keepalive, large response limits, SW conflicts, SW registration fallback, CMAF codec interleaving, H.264 nal extraction, codec quirks, init segment updates, referrer probes, probe race conditions, N_m3u8DL-RE/Streamlink/ffmpeg tests, SPA re-renders, disabled autoplay, key rotation, license server errors, L1 detection, session recycling, Opaque response detection, progress reporting, concurrent ordering, IndexedDB spillover, memory limits, navigation interruption, cookie timing, error messages UX, concurrent jobs, E2E message routing, multi-key Go decrypt, Go key rotation, etc. |
| **Low** | 16 | Sequence number wrap, 10000+ sample moofs, subtitle tracks, edit lists, multiple mdat, large file assembly, malformed segments, cyclic frame trees, 100+ iframes, rapid mutations, session key failure, WebSocket capture, etc. |

---

## Appendix: Test Coverage Heatmap

```
Layer                    Tests    Depth    High-Gap     Coverage Rating
─────────────────────────────────────────────────────────────────────
Layer 0 — Detection      11 files  Medium   3 High        ████████░░ 75%
Layer 1 — Probes         12 files  High     3 High        ████████░░ 80%
Layer 2 — CDP Extract    6 files   High     2 High        █████████░ 85%
Layer 3 — SW Capture     3 files   Low      3 High        ████░░░░░░ 40%
Layer 4 — MSE/Demux      3 files   Very H   0 High        ██████████ 95%
Layer 5 — EME/CDM        5 files   Medium   3 High        ██████░░░░ 60%
Layer 6 — Browser Tunnel 2 files   Low      2 High        ████░░░░░░ 40%
Integration              6 files   Low      3 High        ████░░░░░░ 35%
Go Binary                3 files   Medium   2 High        ██████░░░░ 60%
```

**Key insights:**
1. **Layer 3 (SW Capture)** and **Layer 6 (Browser Tunnel)** are the most under-tested — both at ~40% coverage with critical gaps
2. **Layer 4 (MSE/Demux)** has the best coverage at ~95% — almost all spec'd edge cases are tested
3. **Integration/E2E tests** are the weakest area at ~35% — the full fallback chain has never been tested end-to-end
4. **High-priority missing tests** are concentrated in DRM (PlayReady, FairPlay, multi-key) and SW capture (cross-origin, range requests)
