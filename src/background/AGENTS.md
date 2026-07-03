# src/background

> ⚡ **PRIMARY BROWSER: Yandex** — Background service worker is tested and debugged against Yandex Browser first.

Extension service worker (Manifest V3). Handles all background processing: download orchestration, CDM intercept, CDP relay, native host communication, and filter integration.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| **Download orchestration** | `download_orchestration.js` | Main coordinator |
| **Download queue** | `download_queue.js` | Sequential queue with priority |
| **Download state** | `download_state.js` | Tracks active/completed downloads |
| **Download operations** | `download_operations.js` | Individual download lifecycle |
| **CDM key extraction** | `cdm_key_extraction.js` | Widevine key extraction |
| **CDM CDP debugger** | `cdm_cdp_debugger.js` | Debugger-based CDM intercept |
| **CDP relay** | `cdp_relay.js` | CDP ←→ native host bridge |
| **CDP extraction** | `cdp_extraction.js` | Media stream CDP capture |
| **CDP deep inspection** | `cdp_deep_inspection.js` | Advanced stream inspection |
| **Native requests** | `native_requests.js` | Native messaging I/O |
| **Batch orchestration** | `batch_orchestration.js` | Batch download coordination |
| **Browser download** | `browser_download.js` | Browser's native download API |
| **Segment capture** | `segment_capture.js` | HLS/DASH segment capture |
| **Filter integration** | `filter_integration.js` | Video source filtering |
| **Tab state** | `tab_state.js` | Per-tab state management |
| **Message router** | `message_router.js` | Internal message routing |
| **Recording** | `recording.js` | Screen recording support |
| **WebRequest** | `background_webrequest.js` | network request intercept |
| **Init** | `background_init.js` | Service worker initialization |

## CONVENTIONS

- All files are raw `.js` (no TypeScript, no bundler for background).
- Communication with popup via `chrome.runtime.sendMessage`/`onMessage`.
- Communication with native host via `chrome.runtime.connectNative`.
- Uses `chrome.tabs`, `chrome.webRequest`, `chrome.debugger` APIs.
- State stored per-tab in `tab_state.js` (no global singletons).

## ANTI-PATTERNS

- No `chrome.storage` for transient state (use in-memory tab_state).
- No direct DOM access (not a content script).
