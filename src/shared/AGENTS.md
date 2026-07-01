# src/shared

Shared JavaScript contracts used by both the extension (service worker/background) and content scripts. Must stay in sync — changes here affect multiple consumer modules. Also mirrored in Python native host (`src/native_host/`) for some modules.

## WHERE TO LOOK

| Module | File | Consumers |
|--------|------|-----------|
| **Media candidates** | `media_candidates.js` | background, popup, native host (Python) |
| **Video filters** | `video_filters.js` | background, content |
| **Video identity** | `video_identity.js` | background, content, native host |
| **Video picker** | `video_picker.js` | popup, content |
| **Video sorting** | `video_sorting.js` | popup |
| **Quality format** | `quality_format.js` | popup, content, native host |
| **Quality dialog** | `quality_dialog.js` | popup, content |
| **Batch state** | `batch_state.js` | popup, background |
| **Popup state** | `popup_state.js` | popup, background |
| **Popup API** | `popup_api.js` | popup, background |
| **Download sync** | `download_sync.js` | popup, background |
| **Filter lists** | `filter_list_*.js` | background |
| **Playlist detection** | `playlist_detection.js` | popup |
| **Browser API** | `browser_api.js` | Shared browser compat layer |
| **Overlay CSS** | `qwin_overlay.css` | Extension overlay UI |

## CONVENTIONS

- ES module syntax (`export`/`import`) — bundled by esbuild.
- 2-space indent, trailing commas, double quotes.
- No `chrome.*` API calls — must be browser-agnostic.
- Python mirror files in `src/native_host/` must implement identical logic.

## ANTI-PATTERNS

- No DOM manipulation — shared modules are pure logic.
- No platform-specific APIs — extensions/content scripts must add their own bridging.
- Don't edit Python mirrors independently — both sides must stay in sync.
