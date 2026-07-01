# src/popup

Extension popup UI — single-page HTML app rendered in a browser action popup. Entry point is `popup.html` which loads `popup.bundle.js` (esbuild bundle of all JS modules).

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| **Entry / boot** | `popup.html` → `popup.js` | HTML shell + init bootstrap |
| **UI rendering** | `popup_renderer.js` | Video list, download list rendering |
| **UI elements** | `popup_elements.js` | DOM element creation utilities |
| **Event handlers** | `popup_events.js` | All user interaction handlers |
| **State management** | `popup_state.js` | Shared popup state (singleton) |
| **Background events** | `popup_background_events.js` | Listens for background script messages |
| **URL events** | `popup_url_events.js` | Manual URL input handling |
| **Batch helpers** | `popup_batch_helpers.js` | Batch download UI logic |
| **Download list** | `download_list.js` | Download history/recent list |
| **Sync history** | `popup_sync_history.js` | Cross-device download history sync |
| **Helpers** | `popup_helpers.js` | init(), utility functions |
| **UI utilities** | `popup_ui.js` | DOM updates, animation helpers |
| **Styling (base)** | `popup-base.css` | Reset + layout |
| **Styling (components)** | `popup-components.css` | Video cards, dialogs, buttons |
| **Styling (theme)** | `popup-theme.css` | Colors, typography, dark mode |
| **Styling (main)** | `popup.css` | Imports all CSS via @import |

## CONVENTIONS

- Single HTML file (`popup.html`) — no routing, no SPA framework.
- JS split into focused modules (events, state, rendering, helpers) — imported via esbuild.
- CSS split by concern: base → components → theme — loaded via CSS `@import`.
- Communication with background via `chrome.runtime.sendMessage`/`onMessage`.
- State stored in `popup_state.js` singleton — accessed by all modules.

## ANTI-PATTERNS

- No direct DOM manipulation from background event handlers — route through state updates.
- No inline styles — all styling in CSS modules.
- No `chrome.storage` reads in hot paths — cache in popup state.
