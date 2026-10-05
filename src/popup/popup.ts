// ─── Module references ──────────────────────────────────────────────────────
import { init } from "./popup_helpers.js";

// Side effect: registers the background-broadcast listener. The other two
// `popup_*_events` modules are gone with the chrome they wired: `popup_events.js` held
// the settings-toggle, view-nav and layout-toggle listeners on markup that no longer
// exists, and `popup_url_events.js` is now one exported function the paste box calls.
import "./popup_background_events.js";

// ─── Boot ───────────────────────────────────────────────────────────────────
void init();
