/**
 * Everything a download row needs to know about a job, as pure functions.
 *
 * This is the module that `download_list.js` used to be. Its status branching was
 * duplicated three ways — once for the row's progress bar, once for the compact
 * progress under a video, and once for the button that reports progress inline — so
 * the branching is written once here and both rows call it. No DOM, no signals: the
 * components pass a job in and render what comes back.
 */
import {
  ACTIVE_DOWNLOAD_STATUSES,
  PAUSABLE_DOWNLOAD_STATUSES,
  TERMINAL_DOWNLOAD_STATUSES,
} from "../shared/download_statuses.js";
import { formatDownloadPercent, videoTitle } from "../ui/format.js";
import type { DownloadJob } from "./state/downloads.js";

/** A job is only mid-transfer if it reports a finite number. `"50"` and NaN are not progress. */
export function hasDownloadPercent(job: DownloadJob | null | undefined): boolean {
  return typeof job?.percent === "number" && Number.isFinite(job.percent);
}

/**
 * The phases the UI *names* rather than numbers: the merge/remux/write-output tail of
 * a download.
 *
 * This used to double as "suppress the percentage", and its docstring said why:
 * "Post-processing stages, where a percentage would be a lie and the UI says so". D6
 * (`real-progress-spec.md` §3.5) invalidated that — yt-dlp's postprocessor reports an
 * ffmpeg `time=` value against a duration the host already knows, so `postprocess`
 * now carries a real percent, and suppressing it made the bar indeterminate for a
 * multi-minute phase that could report honestly.
 *
 * So it is split in two: {@link isProcessingStage} is the *bar's* suppression test and
 * now asks whether a percent is present, while this function stays the pure stage
 * test for the callers that are about wording (the row label, the button text, the
 * disabled placeholder action).
 */
function isProcessingPhase(job: DownloadJob | null | undefined): boolean {
  const stage = normalizedStage(job);
  return stage === "postprocess" || stage === "destination" || stage === "filepath";
}

/**
 * Whether the bar must render indeterminate: a processing phase with nothing honest
 * to show (spec §3.5, §4.3).
 *
 * Deliberately **one rule — "is there a percent" — rather than a per-stage list**, so
 * there is no second place to forget a stage. `postprocess` is the case that mattered
 * (D6 gives it a real percent). `destination` and `filepath` are parser branches for
 * the last phase that never carry a percent at all, so in practice they are still
 * always suppressed; they simply get there by the same route as everything else.
 */
export function isProcessingStage(job: DownloadJob | null | undefined): boolean {
  return isProcessingPhase(job) && !hasDownloadPercent(job);
}

function normalizedStage(job: DownloadJob | null | undefined): string {
  return String(job?.stage || "").trim();
}

/**
 * The bar's fill, or `null` for "no honest percentage yet" — which
 * `ui/components/ProgressBar.tsx` renders as an indeterminate bar with no
 * `aria-valuenow`.
 *
 * Suppression is driven purely by whether a percent exists (spec §3.5/§4.3), not by
 * the stage: a `postprocess` job that reports one shows it, a `postprocess` job that
 * does not is indeterminate exactly like every other percentless job.
 */
export function downloadProgressValue(job: DownloadJob | null | undefined): number | null {
  if (!job || job.status === "error" || isProcessingStage(job) || !hasDownloadPercent(job)) {
    return null;
  }
  return job.percent as number;
}

/** Accessible name for the bar, and the visible line under it. */
export function downloadProgressLabel(job: DownloadJob | null | undefined): string {
  const stage = normalizedStage(job);
  if (stage === "postprocess") {
    return "Merging downloaded segments...";
  }
  if (stage === "destination" || stage === "filepath") {
    return "Finalizing output...";
  }

  if (hasDownloadPercent(job) && !isProcessingStage(job)) {
    const sizeInfo = job?.totalSize ? ` of ${job.totalSize}` : "";
    return `${formatDownloadPercent(job?.percent)} downloaded${sizeInfo}`;
  }

  if (stage === "download") {
    if (job?.fragment) {
      return `Downloading video segments... (${job.fragment})`;
    }
    if (job?.speed) {
      return `Downloading video segments at ${job.speed}`;
    }
    return "Downloading video segments...";
  }
  if (stage === "extract") {
    if (job?.fragment) {
      return `Preparing fragments ${job.fragment}`;
    }
    return "Preparing video...";
  }

  const status = job?.status || "queued";
  if (status === "queued") {
    return "Queued";
  }
  if (status === "connecting") {
    return "Connecting to helper";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "pausing") {
    return "Pausing";
  }
  if (status === "canceling") {
    return "Canceling";
  }
  if (status === "running") {
    return "Download running";
  }
  return "Starting";
}

/**
 * The short form shown on a video's download button while its job is running.
 * Deliberately terser than the row label: it has to fit a button.
 */
export function downloadProgressButtonText(job: DownloadJob | null | undefined): string {
  const stage = normalizedStage(job);
  if (stage === "postprocess") {
    return "Merging";
  }
  if (stage === "destination" || stage === "filepath") {
    return "Finalizing";
  }

  if (hasDownloadPercent(job) && !isProcessingStage(job)) {
    return formatDownloadPercent(job?.percent);
  }

  const status = job?.status || "queued";
  if (status === "queued") {
    return "Queued";
  }
  if (status === "connecting") {
    return "Connecting";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "pausing") {
    return "Pausing";
  }
  if (status === "canceling") {
    return "Canceling";
  }
  if (job?.fragment) {
    return `Frag ${job.fragment}`;
  }
  if (job?.speed) {
    return job.speed;
  }
  if (stage === "download") {
    return "Active";
  }
  if (stage === "extract") {
    return "Preparing";
  }
  return "Starting";
}

function isFakeDownloadMessage(text: string): boolean {
  return /^Downloading(?:\.\.\.| to\b)/i.test(text);
}

/**
 * The attempt label `background/download/native.ts` puts on the message when the host
 * reports `started` (spec D14, §4.4).
 *
 * It is the one message an *active* job must show. Everything else on a running or
 * connecting job is noise on top of a bar that is already moving — but "Trying
 * N_m3u8DL-RE…" is the explanation for a bar that is *not* moving, because a download
 * can fall through six or more backends before one sticks and, without this, a
 * backend-selection stall is indistinguishable from a hang.
 */
function isAttemptLabel(text: string): boolean {
  return /^Trying\s/i.test(text);
}

/**
 * The row's error/message line. Empty means render nothing: a percent already says
 * everything, and an in-flight job's "Downloading..." is noise on top of the bar.
 */
export function downloadMessageText(job: DownloadJob | null | undefined): string {
  if (!job) {
    return "";
  }
  if (job.error) {
    return job.error;
  }
  if (hasDownloadPercent(job)) {
    return "";
  }
  const text = String(job.message || "").trim();
  if (
    !text ||
    isFakeDownloadMessage(text) ||
    (ACTIVE_DOWNLOAD_STATUSES.has(job.status || "queued") && !isAttemptLabel(text))
  ) {
    return "";
  }
  return text;
}

export interface DetailEntry {
  label: string;
  value: string;
}

function formatDownloadTimestamp(value: unknown): string {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toLocaleString();
}

export function downloadDetailEntries(job: DownloadJob | null | undefined): DetailEntry[] {
  const entries: DetailEntry[] = [];
  if (!job) {
    return entries;
  }

  const push = (label: string, value: unknown) => {
    // `||` not `??`: a 0 speed or a 0 connection count is "absent", not "0".
    const text = String(value || "").trim();
    if (text) {
      entries.push({ label, value: text });
    }
  };

  // Suppression here is driven by "is there a percent to report", not by the stage
  // (spec §3.5): a postprocess job with a real percent reports Progress and Speed
  // like any other, and `destination`/`filepath` are suppressed for the same reason
  // they always were — they carry no percent, so there is nothing to print.
  const noPercent = isProcessingStage(job);
  push("Status", job.status || "queued");
  if (hasDownloadPercent(job) && !noPercent) {
    push("Progress", `${formatDownloadPercent(job.percent)} of 100%`);
  }
  if (typeof job.rawPercent === "number" && Number.isFinite(job.rawPercent) && !noPercent) {
    push("Tool percent", formatDownloadPercent(job.rawPercent));
  }
  if (!noPercent) {
    push("Speed", job.speed);
    push("ETA", job.eta);
  }
  push("Downloaded", job.downloadedSize);
  push("Total size", job.totalSize);
  push("Connections", job.connections);
  push("Fragment", job.fragment);
  push("Stage", job.stage);
  push("Format", job.format);
  push("Quality", job.formatId);
  push("Saved file", job.filepath);
  push("Artifact folder", job.artifactRoot);
  push("Page URL", job.pageUrl);
  push("Source URL", job.url);
  push("Helper output", job.rawProgressLine);
  push("Last update", formatDownloadTimestamp(job.updatedAt));
  return entries;
}

export interface DownloadAction {
  label: string;
  /** The `data-action` the API switch dispatches on. `none` is an inert placeholder. */
  action: string;
  primary?: boolean;
  disabled?: boolean;
}

/**
 * The action buttons a job offers, in display order.
 *
 * The old builder had six independent `if`s over three literal status lists. Two of
 * those lists are now named sets in `shared/download_statuses.js`; the third —
 * "pausing and canceling jobs do not get a Pause" — is `PAUSABLE_DOWNLOAD_STATUSES`,
 * which is deliberately narrower than the active set.
 *
 * `downloadFolder` is the configured destination, passed in so this stays a pure
 * function of its arguments. It is what keeps a finished row *actionable* when the job
 * carries no `filepath` — which is every download from before the native host started
 * stamping one, and every browser-download job. Such a row gets a single **Folder**
 * button rather than nothing: the honest action is "show me where downloads land", and
 * a disabled button that looks broken is worse. `open-folder` is deliberately a
 * distinct action id from `show-folder` — the first opens the directory itself, the
 * second selects a known file inside it.
 */
export function downloadActions(job: DownloadJob, downloadFolder = ""): DownloadAction[] {
  const actions: DownloadAction[] = [];
  const status = job.status || "queued";
  const active = ACTIVE_DOWNLOAD_STATUSES.has(status);
  const push = (label: string, action: string, primary?: boolean, disabled?: boolean) =>
    actions.push({ label, action, primary, disabled });

  // Stage-driven, NOT `isProcessingStage`: the placeholder answers "what is this job
  // doing", and the answer stays "merging" now that a postprocess percent exists and
  // the bar is already showing how far along it is. Making it percent-driven would
  // swap a disabled placeholder for a Pause button on a merge the backends cannot
  // actually suspend. (spec §4.4 / D14 gives the stall a message; it does not make
  // postprocess pausable.)
  if (isProcessingPhase(job)) {
    push(job.stage === "postprocess" ? "Converting..." : "Finalizing...", "none", false, true);
  } else if (PAUSABLE_DOWNLOAD_STATUSES.has(status)) {
    push("Pause", "pause");
  }
  if (status === "paused") {
    push("Resume", "resume", true);
  }
  if (active) {
    push("Cancel", "cancel");
  }
  if (TERMINAL_DOWNLOAD_STATUSES.has(status)) {
    push(status === "done" ? "Redownload" : "Retry", "retry", true);
  }
  if (job.filepath) {
    push("Open", "open-file");
    push("Folder", "show-folder");
  } else if (!active && downloadFolder) {
    push("Folder", "open-folder");
  }
  if (!active) {
    push("Remove", "remove");
  }
  return actions;
}

/** A job's title, with the canonical fallbacks (URL, then Music/Video). */
export function downloadTitle(job: DownloadJob | null | undefined): string {
  return videoTitle(job);
}
