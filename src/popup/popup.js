"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import { elements, qualityChooser, api, INDICATOR_STATES, PopupStateHelpers } from "./popup_elements.js";
import { init, setDownloadIndicator, setMessage } from "./popup_helpers.js";

// Import event listeners (side-effects: registers all listeners, subscribes to PopupState)
import "./popup_events.js";

// ─── Boot ───────────────────────────────────────────────────────────────────
init();
