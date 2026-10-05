import type { JobPatch, NativeResponse } from "./types.js";

/**
 * Parse a raw progress value from the native host into 0..100, or null when it is
 * not a usable number.
 *
 * Named to stop reading as a duplicate of `shared/download_statuses.ts`
 * `clampDownloadPercent`, which it is not: that one is fed values the popup already
 * type-checked and yields NaN for junk, while this one is the trust boundary in
 * front of an untrusted host message and yields null so the caller can fall back.
 */
function progressPercentOrNull(percent: unknown): number | null {
  const value = Number(percent);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

/**
 * The one place a raw host `percent` becomes the job's visible `percent` (spec D7,
 * `real-progress-spec.md` §4.2).
 *
 * Two rules, and they used to be three:
 *
 * - **100 becomes 99.** A live download should not paint a full bar before `done`
 *   actually arrives. Unchanged by D7.
 * - **A percent never decreases within a stage.** This was the old unconditional
 *   `Math.max(previous, next)`, and it held "forever" — which is wrong once a
 *   multi-stage download moves from `download` to `postprocess` and honestly starts
 *   again near zero.
 * - **A new stage resets the baseline.** `stageChanged` is that signal, and the job's
 *   current `stage` is the reset key.
 *
 * D7 also retires the `useToolPercent` bypass that used to skip both rules for
 * segmented jobs (`M3U8`/`MPD`/`HLS_RE`/`DASH_RE`), which is exactly why a segmented
 * bar walked backwards: every other job was clamped against its own previous stage
 * forever while segmented jobs opted out. One rule for all jobs now, so
 * `visibleDownloadProgressPercent` — which existed only to apply that bypass — is
 * gone rather than left as a second name for this function.
 */
function normalizeDownloadProgress(existingPercent: unknown, percent: unknown, stageChanged = false): number | null {
  const nextPercent = progressPercentOrNull(percent);
  if (nextPercent === null) {
    return null;
  }

  const activePercent = nextPercent >= 100 ? 99 : nextPercent;
  if (stageChanged) {
    return activePercent;
  }

  const currentPercent = progressPercentOrNull(existingPercent);
  const previousPercent = currentPercent === null ? 0 : currentPercent;
  return Math.max(previousPercent, activePercent);
}

function downloadProgressMessage(percent: unknown): string {
  const value = progressPercentOrNull(percent) || 0;
  return `${Math.round(value)}% downloaded`;
}

function cleanProgressText(value: unknown): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 500 ? text.slice(0, 500) : text;
}

function resetDownloadProgressDetails(): JobPatch {
  return {
    rawPercent: null,
    downloadedSize: "",
    totalSize: "",
    speed: "",
    eta: "",
    connections: null,
    fragment: "",
    // The flag describes *this job's current percent*, and a new or resumed download
    // has none yet — so it resets with the other detail fields rather than outliving
    // them. `false` rather than `null`: the contract says absent/false means "exact"
    // (spec §4.1), and the bar never reads it while `percent` is absent. A progress
    // message sets it again on its very next frame.
    percentApproximate: false,
    rawProgressLine: "",
  };
}

function progressDetailPatchFromMessage(message: NativeResponse): JobPatch {
  const rawPercent = progressPercentOrNull(message.percent);
  const connections = Number(message.connections || 0);
  const patch = {
    rawPercent,
    downloadedSize: cleanProgressText(message.downloadedSize),
    totalSize: cleanProgressText(message.totalSize),
    speed: cleanProgressText(message.speed),
    eta: cleanProgressText(message.eta),
    connections: Number.isFinite(connections) && connections > 0 ? connections : null,
    fragment: cleanProgressText(message.fragment),
    // Spec D9: carried through verbatim so the popup can mark an estimate as one.
    // `undefined` is filtered out below, which is what makes this *sticky* — a
    // `stage: "log"` line between two progress frames carries no flag and must not
    // silently demote the last honest answer to "exact".
    percentApproximate: message.percentApproximate ? true : undefined,
    rawProgressLine: cleanProgressText(message.line),
  };

  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

export {
  cleanProgressText,
  downloadProgressMessage,
  normalizeDownloadProgress,
  progressDetailPatchFromMessage,
  resetDownloadProgressDetails,
};
