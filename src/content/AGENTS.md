# src/content

Content scripts injected into web pages. Responsible for video element detection, page analysis, MSE/EME interception, P2P detection, and overlay UI.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| **Entry point** | `content.js` | Boot: installs observers, starts scan loop |
| **Page detection** | `page_detection.js` | URL analysis, format detection, candidate builder |
| **Media Source intercept** | `media_source_intercept.js` | MSE blob URL capture for custom players |
| **EME intercept** | `eme_intercept.js` | Encrypted Media Extensions (DRM) interception |
| **P2P detection** | `p2p_detection.js` | WebRTC/P2P-based stream detection |
| **Overlay UI** | `content_overlay.js` | Download button overlay on video elements |

## CONVENTIONS

- All files are raw `.js` (no TypeScript) — bundled by esbuild.
- Shares contracts with background via `src/shared/` modules.
- Communicates with background via `chrome.runtime.sendMessage` (one-way) and `onMessage` (request/response).
- No access to `chrome.downloads` or `chrome.tabs` — content script context limitations.
- MutationObserver-driven detection on `src`/`type` attribute changes.

## ANTI-PATTERNS

- No DOM event listener leaks — remove listeners when content script disconnects.
- No synchronous `XMLHttpRequest` — use async messaging to background.
- No direct calls to native host — all host communication routed through background.
- No assumptions about page framework (React, Vue, etc.) — works on vanilla pages.
