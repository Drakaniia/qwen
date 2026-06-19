# Qwin Any-Video Download Spec

> **Status:** Draft v2 (reviewed & refined)
> **Date:** 2026-06-19
> **Goal:** Extend Qwin Video Downloader to download **any video on the web with no exception**, including DRM-protected content from major streaming platforms.

---

## 1. Overview

Qwin currently downloads videos from sites that yt-dlp, aria2c, N_m3u8DL-RE, Streamlink, and gallery-dl can handle. This spec extends Qwin to cover **all remaining gaps** — DRM-protected streams, anti-bot-restricted content, obscure custom players, and sites yt-dlp does not support.

The fundamental strategy is a **tiered approach**: primary tools (yt-dlp, aria2c) → fallback tools (N_m3u8DL-RE, Streamlink, gallery-dl, direct HTTP) → **CDP-based URL extraction** (dynamic players, anti-bot sites) → **CDM-proxy key extraction** (Widevine L3 DRM) → **screen recording** (Widevine L1 / last resort).

---

## 2. Architecture

### 2.1 Current Architecture (unchanged)

```
Browser Extension (JS)
    ↕ Native Messaging
Python Native Host (host.py → host_dispatch.py → download_manager.py → DownloadTask)
    ↕
yt-dlp / aria2c / ffmpeg / Streamlink / N_m3u8DL-RE / gallery-dl
```

The existing message dispatch in `host_dispatch.py` uses a clean `match message_type` pattern. New message types (`capture`, `record`, `cdmStatus`) will be added alongside existing ones (`magnet`, `torrentFile`, `download`, etc.).

### 2.2 Target Architecture

```
Browser Extension (JS)
    ↕ Native Messaging (primary channel: extension ↔ Python)
Python Native Host (existing)             Go Companion Binary (new: qwin-capture.exe)
    ↕                                         ↕
yt-dlp / aria2c / ffmpeg / Streamlink     CDP browser attachment (via chrome.debugger relay)
N_m3u8DL-RE / gallery-dl / direct HTTP    CDM-proxy / Widevine key capture
                                           Screen recording (tabCapture pipe → HW encode)
                                           Stream re-assembly
```

**Communication:**
- The Python host spawns the Go binary as a subprocess when CDM/recording is needed.
- Stdio pipes carry JSON messages between Python and Go.
- CDP commands from Go are relayed through Python → extension (via native messaging) → browser (via `chrome.debugger` API). The Go binary does **not** connect directly to the browser's CDP WebSocket — Chrome 119+ restricts this. Instead, it sends CDP commands through the established native messaging channel.
- The Go binary does **not** register as a separate native messaging host. All communication flows through the existing Python host.

### 2.3 Python ↔ Go IPC Protocol

Messages use JSON over stdio, matching the same framing as native messaging (4-byte length prefix + UTF-8 JSON).

**Python → Go commands:**

```jsonc
// Attach to browser CDP
{"type": "cdp_attach", "id": "...", "wsUrl": "..."}  // wsUrl provided by extension via chrome.debugger.getTargets()

// Start CDM-proxy extraction
{"type": "start_capture", "id": "...", "pageUrl": "...", "manifestUrl": "..."}

// Extract keys from captured license exchange
{"type": "extract_keys", "id": "...", "licenseResponseB64": "...", "sessionId": "..."}

// Start screen recording
{"type": "start_recording", "id": "...", "tabId": 123, "outputPath": "...", "quality": "best"}

// Stop recording or capture
{"type": "stop", "id": "..."}

// Get status
{"type": "status", "id": "..."}
```

**Go → Python responses:**

```jsonc
{"type": "attached", "id": "...", "ok": true}
{"type": "keys_extracted", "id": "...", "keyId": "...", "keyB64": "..."}
{"type": "segment_decrypted", "id": "...", "segmentPath": "...", "index": 42}
{"type": "recording_progress", "id": "...", "percent": 65.2, "duration": 184, "sizeBytes": 241000000}
{"type": "done", "id": "...", "filepath": "...", "message": "..."}
{"type": "error", "id": "...", "error": "..."}
{"type": "cdm_status", "id": "...", "cdmAvailable": true, "l1Only": false, "cdmVersion": "4.10.2710.0"}
```

### 2.4 Go Companion Binary Responsibilities

The Go binary (`qwin-capture.exe`) handles:

1. **CDP browser attachment** — Commands to `chrome.debugger` API are relayed through the extension. The Go binary sends CDP method calls (e.g., `Network.enable`, `Page.addScriptToEvaluateOnNewDocument`) and receives events back.

2. **CDM-proxy / Widevine key extraction** — Intercepts CDM license exchanges via CDP network monitoring, captures decryption keys from license responses, and re-packages decrypted HLS/DASH segments.

3. **Screen recording** — Receives video frames from `chrome.tabCapture` via a local pipe/WebSocket relay. Encodes frames to H.264/H.265 using hardware encoder (NVENC/AMF/Intel QSV) when available, with software fallback.

4. **Stream re-assembly** — Stitches captured segments or recording chunks into a final MP4/MKV file.

**Go binary architecture decisions:**
- Language: Go — mature CDP libraries (`chromedp`, `rod`), easy cross-compilation (single static binary), small footprint (~8 MB).
- CDP library: `github.com/chromedp/chromedp` for Go-side CDP handling.
- Hardware encoding: `github.com/Gen2v/c4/go` for NVENC (NVIDIA), AMF (AMD), QSV (Intel).
- Screen capture pipe: Local WebSocket server (`gorilla/websocket`) receives frames from extension → feeds them to encoder.
- Not using Python for CDM/recording because Go's encoding libraries are more performant and the binary is distributable without requiring a Python runtime.

### 2.5 Browser ↔ Go CDP Relay Flow

```
Go binary                     Python host                   Extension                   Browser
    |                              |                            |                          |
    |-- cdp_command("Network...")  |                            |                          |
    |----------------------------->|                            |                          |
    |                              |-- native msg {type:        |                          |
    |                              |     "cdpCommand", ...}     |                          |
    |                              |--------------------------->|                          |
    |                              |                            |-- chrome.debugger.sendCommand(...)
    |                              |                            |------------------------->|
    |                              |                            |                          |
    |                              |                            |<-- CDP response ---------|
    |                              |<-- native msg {type:       |                          |
    |                              |     "cdpResult", ...}      |                          |
    |<-- CDP result ---------------|                            |                          |
```

This relay approach:
- Avoids needing direct WebSocket CDP access (which Chrome 119+ restricts)
- Keeps all DRM-related code outside the extension (only CDP relay passes through)
- Works with Chrome's `chrome.debugger` permission model
- Does **not** work in Firefox (Firefox doesn't support `chrome.debugger` — see §2.6)

### 2.6 Firefox Compatibility Gap

Firefox does not support the `chrome.debugger` API. For Firefox:

- **CDM-proxy extraction**: Not available. Fall through to screen recording.
- **CDP-based URL extraction**: Not available. Use injected content scripts that hook `HTMLMediaElement.prototype.src` and `MediaSource` constructor to capture dynamic URLs.
- **Screen recording**: Available via `browser.tabCapture` (Firefox MV3 supports this) with a content script → native messaging pipe approach.
- **Status indicators**: Firefox popup will show `recording available` but not `CDM capture available`.

This is a **documented limitation** — Firefox support for advanced capture is partial. Future work may include a Firefox-specific CDP shim using WebExtension experiments.

---

## 3. CDM Strategy: Widevine-proxy

### 3.1 Approach

The strategy is a man-in-the-middle on the Widevine license exchange, using CDP to monitor and intercept network traffic.

1. The extension attaches to the tab via `chrome.debugger.attach()`.
2. CDP `Network.enable` captures network requests — including Widevine license exchanges (`/license`, `/widevine`, etc.).
3. When a license challenge is detected (POST with `Content-Type: application/octet-stream` or `application/x-protobuf` to a known DRM endpoint), the challenge bytes are captured and forwarded to the Go binary.
4. The Go binary processes the challenge through a known CDM, generates a license request, and captures the decryption keys from the response.
5. Encrypted stream segments (from the manifest's `<ContentProtection>` element) are decrypted using the captured keys.
6. Decrypted segments are re-assembled into a clean MP4/MKV file.

### 3.2 CDM Sourcing (Two Approaches)

**Primary: Chrome's bundled Widevine CDM**
- Located at Chrome's installation path: `%LOCALAPPDATA%\Google\Chrome\User Data\WidevineCdm\<version>\`
- The installer (`install-cdm.ps1`) detects and validates this CDM.
- Advantages: Already compatible with the user's browser, no redistribution concerns.

**Fallback: Download a pinned standalone CDM**
- If Chrome's CDM is not found, locked, or incompatible, download a known-working standalone CDM binary to `tools/cdm/`.
- Version-pin a specific CDM release that has been validated for key extraction.
- CDM updates (by Chrome auto-update) are detected and the pinned version is re-applied via CDP.

### 3.3 Widevine L1 vs L3 — Critical Reality Check

| Level | Where | Capturable? | Quality |
|-------|-------|-------------|---------|
| L3 (Software) | Older GPUs, VMs, some laptops | Yes — keys extracted via CDP | Up to 1080p on most platforms |
| L1 (Hardware TEE) | Modern GPUs (NVENC/Intel 8th-gen+/AMD), most desktops 2020+ | **No** — keys never reach software | Falls through to screen recording |

On modern Windows systems, Widevine L1 is the norm. The spec assumes that **CDM-proxy will work primarily on L3-capable systems**. For L1 (which is most systems), the fallback will always be screen recording.

**Detection:** The Go binary will determine L1 vs L3 by attempting to initialize the CDM and checking if keys are returned in software-accessible memory. This is reported as `l1Only: true/false` in the CDM status response.

### 3.4 CDM Version Management

- CDM versions are checked on each install/upgrade.
- A known-working CDM version is pinned in the installer's configuration.
- If Chrome's auto-updated CDM is incompatible, the installer replaces it with the pinned version (by setting CDM path override via CDP).
- **Risk:** Chrome may refuse to launch or may re-download its own CDM. In this case, a separate Chrome profile with CDM control flags is used.

### 3.5 Key Technical Dependencies

Before implementation, these require prototyping and validation:

1. **CDP license interception** — Can CDP `Network.requestWillBeSent` / `Network.responseReceived` reliably capture Widevine license bytes before they reach the CDM?
2. **CDM initialization** — Can we initialize a standalone Widevine CDM with a custom path via CDP `Page.addScriptToEvaluateOnNewDocument` + CDM path override?
3. **Segment decryption** — Given keys captured from license response, can we decrypt MP4 segments (standard AES-128 CTR / CENC) without a full CDM pipeline?
4. **Existing reference implementations** — Projects to study: `pywidevine`, `wvd`, `cdm-proxy`, `Widevine-L3-Decryptor`.

---

## 4. Screen Recording Fallback

### 4.1 Flow

When CDM-proxy cannot capture the stream (Widevine L1, extraction failure, Firefox):
1. Extension requests `chrome.tabCapture` permission on the tab.
2. The captured `MediaStream` is sent frame-by-frame through a local WebSocket to the Go binary.
3. The Go binary encodes frames to H.264 using hardware encoder (NVENC/AMF/QSV) if available.
4. Audio is captured separately via `chrome.tabCapture`'s audio constraint and muxed into the output file.
5. Result: an MP4 file with best-effort quality matching source resolution.

### 4.2 Quality & Performance

- **Resolution:** Matches source (auto-detected from `<video>` element dimensions).
- **Encoding:** Hardware H.264 (NVENC/AMF/QSV), fallback to software x264.
- **Frame rate:** Target source frame rate, may drop frames under load.
- **Bitrate:** Adaptive — auto-calculated based on resolution and desired quality.
- **File size warning:** Estimated before recording starts. Default max: 4 GB per recording.

### 4.3 Limitations (Documented)

- Requires real-time playback (cannot skip/seek during recording).
- May drop frames if system is under load — auto-switches to lower quality if frame drop rate > 10%.
- Audio may drift from video on long recordings (>1 hour) — periodic re-sync applied.
- File sizes are larger than direct downloads for the same content.
- Tab must remain visible/active (Chrome may throttle background tabs).

### 4.4 Error Recovery During Recording

| Condition | Behavior |
|-----------|----------|
| Tab closed | Stop recording immediately. Save partial file with `.partial` extension. Show "Recording stopped: tab was closed." |
| Frame drop > 10% | Auto-reduce quality. Show "Recording may drop frames. Close other applications for best results." |
| Disk space low | Warning at < 500 MB free. Stop recording at < 100 MB free. |
| Network disconnect | If recording depends on stream playback, show "Stream interrupted. Saving partial recording." |
| X frames no motion | Detect static frames (slideshow) and reduce recording fps to save space, restoring when motion resumes. |

---

## 5. Non-DRM Coverage Expansion

### 5.1 Anti-bot Bypass (Maximum)

- **Auto-pass browser cookies** — Forward full browser cookie store to yt-dlp via `--cookies-from-browser` equivalent, or export cookies via CDP and pass as `--cookies` file.
- **Fingerprint impersonation** — Use yt-dlp's `--extractor-args generic:impersonate` and `curl-cffi` at maximum level.
- **CDP-based extraction** — For sites that block yt-dlp entirely, use the Go binary (via CDP relay) to load the page, wait for dynamic content, and extract media URLs directly from evaluated JavaScript (`window.__NEXT_DATA__`, `__NUXT__`, video element sources, etc.).
- **YouTube PO tokens** — Use `--remote-components ejs:github` and ensure the EJS solver downloads successfully. Verify it works after each yt-dlp update.

### 5.2 Anti-bot Error Handling

| Error | Response |
|-------|----------|
| Cloudflare challenge | "The site is protected by a Cloudflare challenge. Retrying with browser impersonation..." → fall back to CDP extraction. |
| YouTube PO token required | "YouTube requires a PO token. Running EJS challenge solver..." → retry after solver completes. |
| Rate limited | "Too many requests. Waiting 60 seconds before retry..." → exponential backoff, max 5 min. |

### 5.3 MSE / Blob URL Extraction

**Status:** Included (was deferred in v1 — now bumped in priority).

**Approach:**
1. Inject a content script that overrides `MediaSource` constructor and `URL.createObjectURL`.
2. When `MediaSource` is created, intercept the source buffers and capture the raw segments appended via `SourceBuffer.appendBuffer()`.
3. Re-assemble captured segments into a playable file.

**Why bumped:** This is technically simpler than CDM-proxy and handles many custom players that load obfuscated video streams. It covers sites like Vimeo OTT, JW Player, and custom HTML5 players.

**Implementation note:** The content script approach means this runs in-page (within the extension's content script) — no Go binary needed. Captured segments are sent to the Python host via native messaging for assembly.

### 5.4 China / Non-Western Platforms

- Bilibili, Youku, iQiyi, Tencent Video: yt-dlp has extractors but they may be broken. Priority: keep yt-dlp updated, auto-pass browser cookies (these sites require login + regional cookies).
- Douyin (TikTok China): yt-dlp extractor exists but may require cookies.
- Fallback: CDP-based extraction when yt-dlp fails.

**Strategy:** Cookie passing is the key differentiator for these sites. The extension forwards full browser cookies for the domain. No custom extraction logic needed unless yt-dlp's extractors are broken (in which case CDP extraction kicks in).

### 5.5 Custom Player / Self-Hosted Video Pages

For pages with custom HTML5 video players that load URLs dynamically:
- Extend `page_detection.js` to scan more deeply for inline player configuration scripts (`window.playerConfig`, `__NEXT_DATA__`, etc.).
- Use the Go binary's CDP attachment to evaluate JavaScript in the page context and extract video source URLs after full page load.
- Support for pages that load video sources via XHR/fetch and feed them to a MediaSource (see §5.3 for the MSE interception approach).

### 5.6 Live Streams

The user specifically excluded live stream recording. Only **already-playing on-demand videos** should be targeted for capture. The recording system will check that the video has a defined duration (not `NaN` / `Infinity`) before initiating capture.

---

## 6. Phased Target Platform Priorities

### Phase 1a: Quick Wins (High Priority, Shorter Timeline)

| # | Platform | Approach | Dependencies |
|---|----------|----------|-------------|
| 1 | **YouTube Premium / YouTube Music** | Cookie passing + PO token bypass | Cookie export infra (exists), EJS solver (needs testing) |
| 2 | **Niche / emerging platforms** (sites yt-dlp doesn't support) | CDP-based URL extraction | Go binary, CDP relay infra |

**Estimated effort:** 2-3 weeks for both.
**Shared dependency:** CDP attachment relay infrastructure, Go binary scaffolding.

### Phase 1b: Streaming Audio DRM (High Priority, Longer Timeline)

| # | Platform | Approach | Dependencies |
|---|----------|----------|-------------|
| 3 | **Spotify** | CDM-proxy (primary) + recording (fallback) | Full CDM pipeline, Go binary |
| 4 | **Tidal** | CDM-proxy (primary) + recording (fallback) | Full CDM pipeline, Go binary |

**Estimated effort:** 4-6 weeks.
**Note:** Spotify currently uses a YouTube search fallback. The CDM-proxy approach replaces this with direct capture.

### Phase 2: SVOD (Medium Priority)

| # | Platform | Approach | Dependencies |
|---|----------|----------|-------------|
| 5 | **Netflix** | CDM-proxy (L3) / recording (L1) | Full CDM pipeline |
| 6 | **Disney+** | Same as Netflix | Full CDM pipeline |
| 7 | **Amazon Prime Video** | Same as Netflix | Full CDM pipeline |
| 8 | **HBO Max / Max** | Same as Netflix | Full CDM pipeline |

**All L3-capturable:** CDM-proxy. **L1:** Always falls through to screen recording.
**Regional catch-up:** BBC iPlayer, ITVX, Channel 4 — same approach + cookie passing.

### Phase 3: Anime & Regional (Lower Priority)

| # | Platform | Approach |
|---|----------|----------|
| 9 | **Crunchyroll** | yt-dlp (augment with CDP) |
| 10 | **Bilibili, iQiyi, Tencent Video, Youku** | yt-dlp + cookie passing + CDP fallback |
| 11 | **Other regional platforms** | As requested |

---

## 7. User Interface

### 7.1 Recording Modes (Configurable in Settings)

Three modes, selectable via a `<select>` element in the settings panel:

| Mode | Behavior |
|------|----------|
| **Manual** | A "Record this page" button appears on the popup when DRM content is detected or no downloadable URLs are found. User clicks to start recording. |
| **Ask first** (default) | When Qwin detects DRM content or fails to find a downloadable URL, it prompts the user: "Start screen recording to capture this video?" with Yes/No. |
| **Auto** | When all other download methods fail, Qwin automatically starts recording without prompting. |

### 7.2 Settings Panel Additions

After the BitTorrent section in `#settingsPanel` (popup.html):

```html
<hr class="settings-divider" />
<label for="recordingMode">Recording mode</label>
<select id="recordingMode">
  <option value="ask">Ask first (recommended)</option>
  <option value="manual">Manual — show Record button</option>
  <option value="auto">Automatic — record without asking</option>
</select>
<p class="hint">
  When no downloadable URL is found, Qwin can record the tab's video output.
  Recording produces best-effort quality and may use significant disk space.
</p>
```

Additionally, the settings status line should show CDM/recording capability:

```
"CDM capture: available  |  Screen recording: ready"
```

### 7.3 Popup UI Changes

**Video items (in `renderVideos`):**
- Non-downloadable items show a "Record" button alongside the disabled "Unsupported" button.
- The Record button triggers the recording flow based on the configured mode.

**Downloads view (in `download_list.js`):**
- Recording jobs shown with a distinct icon (camera/record symbol) and color (red tint).
- Show recording duration alongside progress percentage.
- "Stop recording" action button for active recordings.
- Estimated file size shown before recording begins.

**Zero-detect pages:**
- When Qwin detects a video player (`<video>` element) but finds **no downloadable URLs** and **no DRM stream**:
- The popup shows a "Record this page" button prominently in the main view.
- Clicking it triggers the recording flow based on mode.

### 7.4 Status Indicators

The popup's helper status (returned by `dependency_status()` in `host_dispatch.py`) should show:

```
"Helper ready (1.0.0, fast mode, stream fallbacks, recording available)."
"Helper ready (1.0.0, fast mode, stream fallbacks, CDM capture + recording)."
"Helper ready (1.0.0, fast mode, yt-dlp only)."
```

The `dependency_status()` function will be extended to include `"cdmCapture"` and `"recording"` booleans. The popup formats these into the status line.

### 7.5 Context Menu (Future)

Right-click on a video element → "Capture this video" option. Requires `contextMenus` permission and element target detection.

---

## 8. Dependency Management

### 8.1 Go Companion Binary

**Distribution:** Pre-compiled `qwin-capture.exe` (x86_64, Windows) downloaded from GitHub releases to `tools/capture/` by the installer. Follows the same pattern as `install-aria2.ps1`.

**Versioning:** Binary version checked against extension version on each install. Stored in `tools/capture/version.txt`.

**Build process:**
- Go source in a separate repository (or a `go/` directory in this repo).
- GitHub Actions builds for Windows x86_64 on tag push.
- Release artifact: `qwin-capture-v{version}-windows-amd64.zip`.

**Platform support (current):**
- Windows: `qwin-capture.exe` — x86_64, compiled with Go toolchain (CGo disabled for portability).

**Platform support (future):**
- macOS: Will need `qwin-capture` with AVFoundation/SCK screen capture APIs. Separate binary.

### 8.2 CDM Binaries (Managed by Installer)

A new PowerShell script `install-cdm.ps1` handles:

1. **Detect Chrome's Widevine CDM** at `%LOCALAPPDATA%\Google\Chrome\User Data\WidevineCdm\<version>\`
2. **Validate version** against a known-compatible list.
3. **If compatible:** Copy/symlink to `tools/cdm/`. Report success.
4. **If incompatible or not found:** Download a pinned standalone CDM from a trusted source. Store in `tools/cdm/`.
5. **If download fails:** Report "CDM not available. Screen recording fallback only."

The CDM path is stored in an environment variable (`QWIN_CDM_PATH`) used by the Go binary.

### 8.3 yt-dlp Auto-Update

- `install.bat` runs `yt-dlp -U` after pip install.
- On each extension startup, the Python host pings yt-dlp for version. If outdated by > 1 month, logs a warning.
- User can trigger manual update from settings: "Update yt-dlp" button (runs `yt-dlp -U`).

### 8.4 Installer Integration

`install.bat` is extended with these steps (in order):

```
1. Python dependencies (pip install yt-dlp[default,curl-cffi] imageio-ffmpeg)  ← existing
2. ffmpeg (winget / imageio fallback)                                           ← existing
3. aria2c download                                                              ← existing
4. Stream fallbacks (N_m3u8DL-RE, Streamlink)                                  ← existing
5. NEW: Go companion binary (qwin-capture.exe download)                        ← new
6. NEW: CDM detection/download (install-cdm.ps1)                               ← new
7. Build extension                                                              ← existing
8. Register native host                                                         ← existing
```

---

## 9. Error Handling & Feedback

### 9.1 Recording Errors

| Condition | User-Facing Message | Behavior |
|-----------|-------------------|----------|
| No tab to capture | "No active video tab found to record." | Return to popup. |
| Tab closed during recording | "Recording stopped: tab was closed." | Save partial `.partial` file. |
| Performance warning | "Recording may drop frames. Close other applications for best results." | Auto-reduce quality if drops persist. |
| Disk space low | "Low disk space. Recording will stop if space runs out." | Warning at 500 MB, stop at 100 MB. |
| DRM capture blocked | "This content uses hardware-level DRM (Widevine L1). Switching to screen recording." | Auto-fallthrough to recording. |

### 9.2 CDM-proxy Errors

| Condition | User-Facing Message |
|-----------|--------------------|
| CDM not found | "Widevine CDM not found. Run scripts\install.bat to install it." |
| CDM version mismatch | "CDM version is incompatible. Updating required. Run scripts\install.bat." |
| License exchange failed | "Could not obtain decryption license. The platform may have revoked this session." |
| Key extraction failed | "Decryption keys could not be captured. This stream may use hardware DRM (L1). Switching to screen recording." |
| L1-only detected | "This content uses hardware-level DRM (Widevine L1). Decryption keys cannot be captured. Switching to screen recording." |

### 9.3 Anti-bot Errors

| Condition | User-Facing Message |
|-----------|--------------------|
| Cloudflare challenge | "The site is protected by a Cloudflare challenge. Retrying with browser impersonation..." |
| YouTube PO token required | "YouTube requires a PO token. Running EJS challenge solver..." |
| Rate limited | "Too many requests. Waiting 60 seconds before retry..." |

### 9.4 Recording Quality Warnings

- **Before recording starts:** Show estimated file size based on source resolution and estimated duration.
- **During recording:** Show actual file size, duration recorded, and frame drop percentage.
- **After recording:** Show final file size, duration, average bitrate, and frame drop summary.

---

## 10. Testing Strategy

### 10.1 Unit Tests

| Component | Test Runner | What to Test |
|-----------|-------------|-------------|
| Python native host | `unittest` (`tests/native-host/`) | New message types (`cdpCommand`, `startRecord`, etc.), CDM status response, recording control |
| Go companion binary | `go test` | CDP command serialization, key extraction pipeline, recording pipe encoding, stream re-assembly |
| JS extension | Node.js (`tests/extension/`) | Record button visibility logic, recording mode persistence in settings, CDP relay message forwarding |

### 10.2 Integration Tests

| Test Scenario | How to Test |
|--------------|-------------|
| Fallback chain (yt-dlp → CDP extraction → recording) | Mock each stage failing and verify the next stage activates. |
| CDP relay roundtrip | Start a local CDP target (Chrome headless), attach via relay, send command, verify response. |
| Screen recording pipe | Start recording on a known tab, capture 10 seconds, verify output file is valid MP4 with expected resolution. |
| CDM initialization | Load a known-working CDM, verify it initializes and reports correct version. |
| License interception | Play a sample Widevine-protected stream (e.g., https://bitmovin.com/demos/stream-test), verify CDP captures license exchange. |

### 10.3 Mocking Strategy for CI

Since CDM binaries and actual DRM content cannot be included in CI:
- CDM operations are mocked in unit tests using fixture license exchange data.
- Recording pipe is tested with synthetic frame data (not live tab capture).
- CDP relay is tested against a minimal Chrome headless instance (available in GitHub Actions Windows runners).

### 10.4 Manual Testing Checklist

- [ ] YouTube Premium: Test with active Premium subscription cookies.
- [ ] Netflix free trial / sample: Test L3 vs L1 detection.
- [ ] Cloudflare-protected video site: Test anti-bot bypass.
- [ ] Custom HTML5 player (e.g., Vimeo, JW Player test page): Test MSE interception.
- [ ] Spotify: Test CDM-proxy against free/trial tier.
- [ ] Zero-detect page: Test "Record this page" flow.
- [ ] All recording modes (Manual, Ask first, Auto).
- [ ] Tab closure during recording.

---

## 11. Risks & Mitigations

### 11.1 Chrome Web Store Review Risks

| Risk | Mitigation |
|------|-----------|
| `debugger` permission triggers manual review | In review notes, document that `debugger` is used exclusively for media URL extraction on dynamically-loaded video pages — not for general browser automation. |
| `tabCapture` permission triggers manual review | Document that `tabCapture` is used for accessibility/archival purposes when direct download is not possible. |
| Extension perceived as DRM-circumvention tool | All DRM bypass logic lives **outside the extension** — in the Go companion binary. The extension only relays CDP commands/responses as opaque JSON. The extension itself contains **zero** DRM-circumvention code. |
| Reviewers find DRM-related code in Go binary | The Go binary is a separate download, not bundled in the extension package. Chrome Web Store review only covers the extension source. |

### 11.2 Technical Risks

| Risk | Mitigation |
|------|-----------|
| CDM version updates break extraction | Version-pin a known-working CDM. Use CDP to override CDM path after detection of mismatch. |
| Chrome 119+ blocks external CDP connections | Use `chrome.debugger` API relay (extension → browser). Never connect directly to CDP WebSocket. |
| Widevine L1 on most modern systems | Document clearly. Always fall through to screen recording. The spec does NOT promise CDM-proxy will work everywhere. |
| Screen recording performance on low-end systems | Auto-detect hardware encoder availability. Fall back to software encoding with quality reduction. Warn user before starting. |
| Firefox lacks `chrome.debugger` | Firefox gets screen recording only. CDM-proxy and CDP extraction are documented as Chrome-only features. See §2.6. |

### 11.3 Legal Risks

| Risk | Mitigation |
|------|-----------|
| DMCA anti-circumvention liability | Clearly document that the tool is for offline backup of legally owned content. User assumes all legal responsibility for how they use the tool. |
| CDM binary redistribution | Don't bundle CDM in extension package or installer. Installer detects Chrome's existing CDM or prompts user to download a standalone version. |
| Terms of Service violations | Qwin does not bypass authentication, login walls, or payment gates. It only downloads content the user already has authorized access to in their browser. |

### 11.4 User Experience Risks

| Risk | Mitigation |
|------|-----------|
| Large recording file sizes | Show estimated size before recording starts. Default max: 4 GB per recording. Configurable in advanced settings. |
| Disk space exhaustion | Monitor free space during recording. Warning at 500 MB. Hard stop at 100 MB. |
| User confusion about why download failed "but it plays in the browser" | Show clear error messages distinguishing DRM (L1 vs L3), anti-bot (Cloudflare, rate limit), and unsupported format cases. |
| Accidental recording start | Default mode is "Ask first" — user must confirm before recording starts. Auto mode is opt-in only. |

---

## 12. Future Considerations (Not in Scope Now)

- Cross-platform support (macOS, Linux).
- Playlist / batch download support.
- Subtitle download alongside video.
- Download scheduling / delayed start.
- Download history sync across browsers.
- Audio-only recording mode (separate from current Music mode).
- Firefox-specific CDP shim using WebExtension experiments.
- Live stream recording (excluded by user request).

---

## 13. Technical Research Required (Pre-Implementation)

Before Phase 1a implementation begins, the following must be prototyped and validated:

1. **CDP relay via `chrome.debugger`** — Can we attach to a tab, send `Network.enable`, and receive network events through the relay chain (Go → Python → extension → browser)? Latency acceptable?

2. **CDP-based media URL extraction** — Can we use `Runtime.evaluate` to extract `HTMLVideoElement.prototype.src`, `window.__NEXT_DATA__`, and `playerConfig` from dynamically-loaded pages?

3. **MSE override in content script** — Can we intercept `MediaSource` / `SourceBuffer.appendBuffer()` and capture raw segments? Test against Vimeo, JW Player, Shaka Player demos.

4. **CDM initialization from standalone binary** — Can we load a Widevine CDM (`widevinecdm.dll`) from a custom path, initialize it, and process a license request without Chrome's full sandbox?

5. **Hardware encoding availability** — What percentage of Windows systems have NVENC, AMF, or QSV? Can we reliably detect and use them from Go?

6. **tabCapture stream → file pipe** — Can we stream `chrome.tabCapture` output to a local WebSocket without significant latency or frame loss?

---

## Appendix A: User Interview Summary

| Question | Answer |
|----------|--------|
| Scope | All content including DRM |
| Motivation | Personal media library archiving |
| Legal stance | DRM-bypass included |
| DRM approach | Hybrid: CDM-proxy (primary) + screen recording (fallback) |
| Non-DRM gaps | All except live stream recording |
| Risk tolerance | Maximum capability |
| Binary management | Auto-download/manage all binaries |
| Architecture | Add Go companion binary |
| CDM integration | Trust Buffy's expertise (CDP-based proxy approach) |
| MSE/Blob | Include (was deferred in v1, bumped to included in v2) |
| Recording UX | 3 modes: Manual, Ask first, Auto (configurable) |
| Target platforms | All major + niche |
| Platform support | Windows first, macOS later |
| IPC architecture | Python orchestrates Go as subprocess |
| Recording quality | Automatic best quality |
| Browser launch | Trust Buffy's expertise |
| CDM sourcing | Both: browser CDM first, standalone fallback |
| Anti-bot bypass | Maximum (cookies + impersonation + CDP extraction) |
| Zero-detect UX | Automatic "Record this page" button |
| Extra features | None requested — scope is well-defined |

## Appendix B: Original Spec Changes (v1 → v2)

| Section | Change |
|---------|--------|
| §2.2 | Added `chrome.debugger` relay detail. Removed Go binary as separate native messaging host. |
| §2.3 | New section: IPC protocol schema defined with JSON examples. |
| §2.4 | Added Go binary architecture decisions (library choices, justification). |
| §2.5 | New section: CDP relay flow diagram and explanation. |
| §2.6 | New section: Firefox compatibility gap documented. |
| §3.3 | Added L1/L3 reality check — CDM-proxy will primarily work on L3 systems only. |
| §3.4 | New section: CDM version management strategy. |
| §3.5 | Added reference implementations to research. |
| §4.4 | New section: Error recovery during recording (tab closure, disk space, motion detection). |
| §5.2 | New section: Anti-bot error handling table. |
| §5.3 | MSE/Blob extraction changed from "Deferred" to "Included" with concrete approach. |
| §5.4 | Added China platform cookie strategy detail. |
| §6 | Phase 1 split into 1a (quick wins) and 1b (heavy CDM lift). |
| §7 | Detailed UI integration points matched to existing popup code structure. |
| §8.1 | Build process and distribution plan for Go binary. |
| §8.2 | New section: CDM binary management by installer. |
| §8.4 | Installer integration order with new steps. |
| §9.4 | New section: Recording quality warnings. |
| §10 | Expanded testing strategy with mocking guidance and manual checklist. |
| §11 | Added Chrome Web Store risks, legal mitigation, and UX risk sections. |
| §13 | New section: Pre-implementation research tasks. |
