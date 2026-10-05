/**
 * Canonical download-state vocabulary (spec §5 Phase 5, R11).
 *
 * This set had five copies. Two were live in the popup (`popup/popup_state.js:4`,
 * `popup/download_list.js:3`), one was an inline array in `download_operations.js`,
 * and — the layering violation R11 calls out — `background/download_helpers.js`
 * *imported the popup's copy* and re-exported it to the service worker. That only
 * worked because esbuild bundles both into one IIFE; `shared/` is where a
 * definition belongs when two layers need it, so it lives here.
 *
 * Imports nothing: the popup gets it through Vite, the service worker through
 * esbuild, and neither pulls the other's layer in.
 *
 * The three sets are `ReadonlySet` rather than `Set` because every consumer only
 * ever asks "is this status in the set" — a widening here would let a caller mutate
 * the vocabulary for every other layer.
 */

/**
 * Statuses that mean a download is in progress: queued, running, or winding down.
 */
const ACTIVE_DOWNLOAD_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "connecting",
  "running",
  "paused",
  "pausing",
  "canceling",
]);

/**
 * Statuses a job can never be restarted from without an explicit retry.
 * The complement of the set above, listed positively because both call sites that
 * need it are asking "is this finished, one way or another?".
 */
const TERMINAL_DOWNLOAD_STATUSES: ReadonlySet<string> = new Set(["done", "error", "canceled"]);

/**
 * Statuses where a Pause action is meaningful. Deliberately narrower than
 * `ACTIVE_DOWNLOAD_STATUSES`: "pausing" and "canceling" jobs are already on their
 * way down, so a second pause would be a lie. Not a fork — a named second set.
 */
const PAUSABLE_DOWNLOAD_STATUSES: ReadonlySet<string> = new Set(["queued", "connecting", "running"]);

/**
 * Whether a job is in an active (non-terminal) state. A missing status counts as
 * "queued", matching every call site that has ever used this.
 */
function isActiveDownload(job: { status?: string } | null | undefined): boolean {
  return ACTIVE_DOWNLOAD_STATUSES.has(String((job && job.status) ?? "queued"));
}

/**
 * Clamp a raw progress value into 0..100. Non-numeric input yields NaN — callers
 * guard with a `typeof === "number"` check first. (`background/download_state.ts`
 * has a same-named helper that returns null instead; that one *is* a different
 * concern — it parses an untrusted host value — and it is no longer called this.)
 */
function clampDownloadPercent(percent: unknown): number {
  return Math.max(0, Math.min(100, Number(percent)));
}

export {
  ACTIVE_DOWNLOAD_STATUSES,
  TERMINAL_DOWNLOAD_STATUSES,
  PAUSABLE_DOWNLOAD_STATUSES,
  isActiveDownload,
  clampDownloadPercent,
};
