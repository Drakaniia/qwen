"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import { elements, qualityChooser, api, INDICATOR_STATES, PopupStateHelpers } from "./popup-elements.js";
import { init, setDownloadIndicator, setMessage } from "./popup-helpers.js";

// Import event listeners (side-effects: registers all listeners, subscribes to PopupState)
import "./popup-events.js";

// ─── Boot ───────────────────────────────────────────────────────────────────
init();
