/**
 * The popup's shared value types — the download-status predicates and the contract for
 * every reply that crosses `popup_api.js`.
 *
 * The reply shapes live here rather than in each of `popup_helpers.ts`,
 * `popup_actions.ts` and `popup_url_events.ts` because all three read the same envelope
 * and two of them read the same format response; three copies of `{ ok?, error? }` is
 * how they drift apart.
 */
import type { Settings } from "../shared/contracts.js";
// R11: this set used to be defined here, which forced `background/download_helpers.js`
// to import the popup. One definition, in the layer both sides are allowed to use.
import { ACTIVE_DOWNLOAD_STATUSES } from "../shared/download_statuses.js";
import type { DownloadJob } from "./state/downloads.js";
import type { SyncEntry, SyncInfo } from "./state/filters.js";
import type { VideoCandidate } from "./state/videos.js";

/**
 * Check if a response error is the stale-background "Unknown message type" error.
 *
 * Typed `unknown` because it is handed whatever a message reply happened to be —
 * `null`, a bare string, or a `{ ok, error }` record all reach it from the popup's
 * defensive `!response.ok` branches.
 */
export function isUnknownMessageTypeError(response: unknown): boolean {
  const error = (response as { error?: unknown } | null | undefined)?.error;
  return /unknown message type/i.test(String(error || ""));
}

// ─── The extension boundary ─────────────────────────────────────────────────
//
// `popup_api.js` is the popup's only channel to the background, and every reply
// crosses a process boundary where a key can be missing — hence every field below is
// optional. These are the shapes the popup actually reads; nothing else needs to know
// more, and none of them is reimplemented anywhere else in the layer.

/** The bare envelope every handler answers with: `ok` plus an optional message. */
export interface PopupResponse {
  ok?: boolean;
  error?: string;
}

/**
 * `qwinSettings` as the *settings form* reads it: the shared {@link Settings} plus the
 * two keys the form itself writes and the popup chrome mirrors. `contracts.ts` models
 * only what the background owns, so the form's own keys live here rather than widening
 * the shared record for every other layer.
 */
export type PopupSettingsForm = Partial<Settings> & {
  backend?: string;
  downloadSubtitles?: boolean;
};

/** `getVideoFormats` / `getFormatsForUrl` reply. The picked `videoId` rides along. */
export interface FormatsResponse extends PopupResponse {
  videoId?: string;
  title?: string;
  formats?: unknown[];
  nativeError?: string;
  /** Why `formats` is empty, in one sentence — rendered instead of the table. */
  unavailableReason?: string;
  /** The video's length in seconds, when the helper reported one. Shown in the dialog header. */
  duration?: number | null;
  hasSubtitles?: boolean;
}

/** `getVideos` reply — the one response that fills every list in the popup. */
export interface GetVideosResponse extends PopupResponse {
  videos?: VideoCandidate[];
  downloads?: DownloadJob[];
  settings?: PopupSettingsForm;
}

/** `getDownloadSyncHistory` reply. */
export interface SyncHistoryResponse extends PopupResponse {
  history?: SyncEntry[];
  syncInfo?: SyncInfo;
}

/** `getHelperStatus` reply; the popup reads the dependency table out of it. */
export interface HelperStatusResponse extends PopupResponse {
  connected?: boolean;
  version?: string;
  dependencies?: Record<string, unknown>;
}

export { ACTIVE_DOWNLOAD_STATUSES };
