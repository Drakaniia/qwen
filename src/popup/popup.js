"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import { init } from "./popup_helpers.js";

// Import event listeners (side-effects: registers all listeners, subscribes to PopupState)
import "./popup_events.js";

// ─── Boot ───────────────────────────────────────────────────────────────────
init();
