import { h, render } from "preact";
import { Icon } from "../ui/Icon.js";
import {
  QualityDialog,
  type FormatLike,
  type QualityDialogView,
  type VideoLike,
} from "../ui/components/QualityDialog.js";
import OVERLAY_CSS from "../shared/qwin_overlay.css?inline";

/**
 * Content Script — Overlay UI Module
 *
 * Everything the extension draws on a third-party page lives inside one shadow
 * root (spec D8). The host element is a single `<div>` in the page's light DOM;
 * its shadow root holds the stylesheet, the per-video trigger buttons and the
 * dialog. The host page's CSS cannot reach in, and — the reason this matters —
 * nothing of ours, including Tailwind's preflight if it ever appeared here, can
 * reach out.
 *
 * Shadow roots are per-document, so `all_frames: true` / `match_about_blank: true`
 * are fine: this module runs once per frame and always uses that frame's own
 * `document`.
 */

/**
 * The response envelope the service worker answers with, widened to the fields the
 * overlay and `content.ts` read. `shared/contracts.ts` deliberately does not enumerate
 * per-message responses, so every key is optional and every access site guards.
 */
export interface RuntimeResponse {
  ok?: boolean;
  error?: string;
  contentType?: string;
  title?: string;
  videoId?: string;
  videos?: unknown;
  formats?: unknown;
  settings?: { overlayEnabled?: boolean; theme?: string };
}

/** The `deps` `content.ts` hands over; see `initOverlay`. */
export interface OverlayDeps {
  sendMessageWithResponse(message: object): Promise<RuntimeResponse>;
  getLastDetectedVideos(): VideoLike[];
}

/** The three keys a download request carries once the user has picked a format. */
interface FormatSelection {
  formatId: string;
  variantId: string;
  backend: string;
}

/** The button carries a candidate so the record knows *why* it exists; nothing reads it back. */
interface OverlayRecord {
  video: HTMLVideoElement;
  button: HTMLButtonElement;
  candidate: VideoLike | null;
}

// ─── Overlay state ─────────────────────────────────────────────────────────

const overlayByVideo = new WeakMap<HTMLVideoElement, OverlayRecord>();
const overlayRecords = new Set<OverlayRecord>();

const EMPTY_TEXT = "No downloadable video detected yet.";
const LOADING_TEXT = "Checking available video versions...";

let overlayHost: HTMLDivElement | null = null;
let overlayButtonLayer: HTMLDivElement | null = null;
let dialogMount: HTMLDivElement | null = null;
let requestSerial = 0;
let pendingChoice: ((value: FormatSelection | null) => void) | null = null;
/** `"system"` | `"light"` | `"dark"`, mirrored onto the host as `data-theme`. */
let overlayTheme = "system";

let sendMessageWithResponse: OverlayDeps["sendMessageWithResponse"] | null = null;
let getLastDetectedVideos: OverlayDeps["getLastDetectedVideos"] = () => [];

/**
 * The closed dialog state, and the only place these eight fields are written.
 *
 * `hideOverlay` resets to exactly this, and the two "open a view" entry points
 * reset to this *plus* their own overrides (`open: true` and a `title`/`view`) — so
 * a field added here reaches all three rather than needing three edits. Frozen
 * because it is a template: `dialog` below is a spread copy, and every later write
 * goes through `setDialog`, which replaces the fields it names wholesale. The two
 * array fields are therefore shared by reference across resets and never mutated in
 * place — `videos`/`formats` are only ever *replaced*, never `push`ed to, which is
 * what makes sharing one frozen empty array safe.
 */
const DEFAULT_DIALOG: {
  open: boolean;
  view: QualityDialogView;
  title: string;
  hasBack: boolean;
  statusText: string;
  nativeError: string;
  videos: VideoLike[];
  formats: FormatLike[];
} = Object.freeze({
  open: false,
  view: "loading",
  title: "",
  hasBack: false,
  statusText: LOADING_TEXT,
  nativeError: "",
  videos: [],
  formats: [],
});

const dialog = { ...DEFAULT_DIALOG };

// ─── Shadow host ───────────────────────────────────────────────────────────

/**
 * Keep the host inside whatever is currently fullscreen, so the buttons and the
 * dialog stay visible when a page enters fullscreen on its own player.
 */
function attachHostToViewport() {
  const target = document.fullscreenElement || document.body || document.documentElement;
  if (overlayHost && overlayHost.parentElement !== target) {
    target.append(overlayHost);
  }
  return overlayHost;
}

/**
 * Mirror the extension's persisted theme onto the shadow host (spec D6, §9).
 *
 * The overlay cannot read the extension's `<html data-theme>`: its stylesheet lives
 * in a shadow root on a *third-party* page, where no such element exists in scope,
 * and `theme.css` is not loaded there either. The host `<div>` is the one piece of
 * the overlay the page does own, so the attribute goes there and
 * `qwin_overlay.css` keys `:host([data-theme=…])` off it — the same three-state
 * keying `theme.css` uses, with `system` represented by *not* pinning the attribute
 * so the `prefers-color-scheme` block keeps ownership.
 */
function applyOverlayTheme() {
  if (!overlayHost) {
    return;
  }
  if (overlayTheme === "system") {
    delete overlayHost.dataset.theme;
  } else {
    overlayHost.dataset.theme = overlayTheme;
  }
}

function setOverlayTheme(theme: string | undefined) {
  overlayTheme = theme === "dark" || theme === "light" ? theme : "system";
  applyOverlayTheme();
}

function ensureOverlayHost(): HTMLDivElement {
  if (overlayHost && overlayHost.isConnected) {
    return overlayHost;
  }

  const doc = document;
  const host = doc.createElement("div");
  host.id = "qwin-video-overlay-host";

  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = OVERLAY_CSS;

  const buttonLayer = doc.createElement("div");
  buttonLayer.className = "qwin-overlay-button-layer";

  const mount = doc.createElement("div");

  shadow.append(style, buttonLayer, mount);

  overlayHost = host;
  overlayButtonLayer = buttonLayer;
  dialogMount = mount;

  attachHostToViewport();
  applyOverlayTheme();
  renderDialog();
  return host;
}

// ─── Dialog ────────────────────────────────────────────────────────────────

function renderDialog() {
  if (!dialogMount) {
    return;
  }
  render(
    h(QualityDialog, {
      open: dialog.open,
      view: dialog.view,
      title: dialog.title,
      hasBack: dialog.hasBack,
      statusText: dialog.statusText,
      nativeError: dialog.nativeError,
      emptyText: EMPTY_TEXT,
      videos: dialog.videos,
      formats: dialog.formats,
      onBack: onDialogBack,
      onCancel: hideOverlay,
      onSelectVideo: onVideoSelected,
      onSelectFormat: onFormatSelected,
    }),
    dialogMount,
  );
}

function setDialog(patch: Partial<typeof dialog>) {
  Object.assign(dialog, patch);
  renderDialog();
}

function settleChoice(value: FormatSelection | null) {
  const pending = pendingChoice;
  pendingChoice = null;
  if (pending) {
    pending(value);
  }
}

function awaitChoice(): Promise<FormatSelection | null> {
  return new Promise((resolve) => {
    pendingChoice = resolve;
  });
}

function hideOverlay() {
  // Bumping the serial invalidates any in-flight format request, which is what
  // made the old cancel-during-loading handler safe.
  requestSerial += 1;
  settleChoice(null);
  // The full reset — this is what `DEFAULT_DIALOG` is: closed, no title, no rows.
  setDialog({ ...DEFAULT_DIALOG });
}

function onDialogBack() {
  settleChoice(null);
  void showAvailableVideosOverlay();
}

function onFormatSelected(format: FormatLike) {
  settleChoice({
    formatId: format.formatId || format.id || "best",
    variantId: format.variantId || "",
    backend: format.backend || "auto",
  });
}

// ─── Quality chooser ───────────────────────────────────────────────────────

function showQualityLoadingDialog(title = "Loading versions..."): number {
  const requestToken = ++requestSerial;
  settleChoice(null);
  // `DEFAULT_DIALOG` plus the two fields this view actually changes: it opens, and
  // it names the video being resolved.
  setDialog({ ...DEFAULT_DIALOG, open: true, title });
  return requestToken;
}

function updateQualityLoadingStatus(text: string) {
  if (dialog.view !== "loading" || !dialog.open) {
    return;
  }
  setDialog({ statusText: text });
}

function isCurrentQualityRequest(requestToken: number) {
  return requestToken === requestSerial;
}

// ─── Available videos overlay ─────────────────────────────────────────────

async function showAvailableVideosOverlay() {
  if (!sendMessageWithResponse) {
    return;
  }

  // `videos: dialog.videos` is the one field this reset does NOT blank: the previous
  // list stays on screen while the fresh `getVideos` round-trip is in flight, and the
  // line below replaces it. Every other field is the reset.
  setDialog({ ...DEFAULT_DIALOG, open: true, view: "videos", title: "Available Videos", videos: dialog.videos });

  const response = await sendMessageWithResponse({ type: "getVideos" });
  const videos = response && response.ok ? response.videos : getLastDetectedVideos();
  setDialog({ videos: Array.isArray(videos) ? videos : [] });
}

// ─── Video selection / download flow ───────────────────────────────────────

/**
 * Initialize overlay with core dependencies from content.js.
 */
function initOverlay(deps: OverlayDeps) {
  sendMessageWithResponse = deps.sendMessageWithResponse;
  getLastDetectedVideos = deps.getLastDetectedVideos;
}

async function onVideoSelected(video: VideoLike) {
  if (!sendMessageWithResponse) {
    return;
  }
  const requestToken = showQualityLoadingDialog(video.title || "Video");
  const formatsResponse = await sendMessageWithResponse({
    type: "getFormatsForUrl",
    video: video,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideOverlay();
    return;
  }

  setDialog({
    open: true,
    view: "formats",
    title: formatsResponse.title ? `Compare versions: ${formatsResponse.title}` : "Compare versions",
    hasBack: true,
    statusText: LOADING_TEXT,
    nativeError: formatsResponse.error || "",
    formats: Array.isArray(formatsResponse.formats) ? formatsResponse.formats : [],
  });

  const selectedFormat = await awaitChoice();
  if (!selectedFormat) {
    await showAvailableVideosOverlay();
    return;
  }

  setDialog({ view: "loading", title: "Sending...", statusText: LOADING_TEXT, formats: [] });

  const response = await sendMessageWithResponse({
    type: "downloadVideo",
    videoId: formatsResponse.videoId,
    formatId: selectedFormat.formatId,
    variantId: selectedFormat.variantId,
    backend: selectedFormat.backend,
  });

  if (!response || !response.ok) {
    setDialog({ title: "Error" });
    window.setTimeout(() => {
      void showAvailableVideosOverlay();
    }, 1000);
    return;
  }

  setDialog({ title: "Queued" });
  window.setTimeout(hideOverlay, 700);
}

// ─── Overlay button ────────────────────────────────────────────────────────

function createOverlayButton(doc: Document): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "qwin-overlay-btn";
  button.title = "Open available video";
  button.setAttribute("aria-label", "Open available video");
  button.hidden = true;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void showAvailableVideosOverlay();
  });

  // `ui/Icon.tsx` is a Preact component, so the glyph is rendered rather than
  // string-built. Importing it costs the content bundle nothing: `Icon.tsx`'s only
  // import is `import type { JSX } from "preact"` (erased at compile time) and `preact`
  // is already here for `QualityDialog` — the overlay has rendered Preact into this
  // shadow root since Phase 6. `motion` is the dependency this bundle cannot take,
  // and `Icon.tsx` does not import it.
  const iconMount = doc.createElement("span");
  const label = doc.createElement("span");
  label.textContent = "Download";
  button.append(iconMount, label);
  render(h(Icon, { name: "download", size: 14 }), iconMount);

  return button;
}

// ─── Overlay positioning ───────────────────────────────────────────────────

function positionOverlay(record: OverlayRecord) {
  if (!record.video.isConnected) {
    removeOverlay(record.video);
    return;
  }

  const rect = record.video.getBoundingClientRect();
  const visible =
    rect.width >= 160 &&
    rect.height >= 90 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  if (!visible) {
    record.button.hidden = true;
    return;
  }

  // Ensure the host follows fullscreen and the button lives in the shadow root.
  attachHostToViewport();
  if (record.button.parentElement !== overlayButtonLayer) {
    overlayButtonLayer?.append(record.button);
  }

  const left = Math.max(8, Math.min(rect.right - 106, window.innerWidth - 114));
  const top = Math.max(8, rect.top + 8);
  // Position only — appearance lives in the shadow stylesheet.
  record.button.style.setProperty("--qwin-x", `${left}px`);
  record.button.style.setProperty("--qwin-y", `${top}px`);
  record.button.hidden = false;
}

function positionAllOverlays() {
  for (const record of Array.from(overlayRecords)) {
    positionOverlay(record);
  }
}

function removeOverlay(video: HTMLVideoElement) {
  const record = overlayByVideo.get(video);
  if (!record) {
    return;
  }
  record.button.remove();
  overlayByVideo.delete(video);
  overlayRecords.delete(record);
}

function updateOverlay(video: HTMLVideoElement, candidate: VideoLike | null, allowBestDetectedFallback = false) {
  if (!candidate && !allowBestDetectedFallback) {
    removeOverlay(video);
    return;
  }

  let record = overlayByVideo.get(video);
  if (!record) {
    ensureOverlayHost();
    const button = createOverlayButton(document);
    overlayButtonLayer?.append(button);
    record = { video, button, candidate };
    overlayByVideo.set(video, record);
    overlayRecords.add(record);
  }

  record.candidate = candidate || null;
  record.button.title = "Open available video";
  positionOverlay(record);
}

// ─── Overlay toggle ────────────────────────────────────────────────────────

function hideAllOverlays() {
  hideOverlay();
  for (const record of Array.from(overlayRecords)) {
    removeOverlay(record.video);
  }
}

function setOverlayEnabled(enabled: boolean) {
  if (enabled) {
    positionAllOverlays();
  } else {
    hideAllOverlays();
  }
}

export {
  initOverlay,
  updateQualityLoadingStatus,
  positionAllOverlays,
  updateOverlay,
  setOverlayEnabled,
  setOverlayTheme,
  ensureOverlayHost,
  hideOverlay,
  showQualityLoadingDialog,
  isCurrentQualityRequest,
  showAvailableVideosOverlay,
};
