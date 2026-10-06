import { formatDownloadPercent, formatEta, formatSize, formatSpeed } from "../format.js";
import { clampDownloadPercent } from "../../shared/download_statuses.js";

export interface ProgressBarProps {
  /** 0..100, or null when the stage reports no percentage yet (post-process, queueing). */
  value: number | null;
  /** Visible status text; also used as the accessible value, since "42%" alone is not enough. */
  label: string;
  /** Overrides the accessible name when the surrounding row already provides context. */
  ariaLabel?: string;
  /**
   * The `DownloadJob` fields the redesign stops throwing away (spec §1.4, §3.1, §6.8).
   * All optional and all additive: a caller that passes only `value`/`label` gets the
   * original two-line bar, so `DownloadProgress.tsx` and `DownloadsPage.tsx` are
   * untouched until someone hands them a job.
   */
  stage?: string;
  speed?: string;
  eta?: string;
  downloadedSize?: string;
  totalSize?: string;
  connections?: number | string;
  /**
   * `true` means the percent is an **estimate**, not a measurement (spec D2/D9,
   * `real-progress-spec.md` §4.1). Absent/false is exact.
   *
   * Marked two ways, because they are two audiences: a `~` on the visible number, and
   * a note on `aria-valuetext`. Announcing an estimate as an exact figure is the
   * accessibility half of D2 — a segmented download whose total was extrapolated and a
   * direct file with a `Content-Length` render the same two digits and do not make the
   * same claim.
   */
  percentApproximate?: boolean;
}

/**
 * The four phases the native host actually emits, in the order it emits them.
 * Read off `native_host/download/progress_parser.py:parse_yt_dlp_line`, not
 * invented: `extract` (fragment enumeration — `[hlsnative] Total fragments:`),
 * `download` (bytes moving), `postprocess` (`[Merger]` / `[VideoConvertor]` /
 * `[Fixup`), then the output file being written.
 *
 * `destination` and `filepath` are two parser branches for that last phase, so they
 * share one stop. `log` is the parser's catch-all for lines it does not classify and
 * is not a phase at all; `downloading` and `done` are set by
 * `background/download/browser.ts` and never parsed. Anything unrecognised renders no
 * timeline rather than a guessed one — a wrong phase is worse than no phase (spec §6.8).
 */
const STAGES: readonly { key: string; label: string }[] = [
  { key: "extract", label: "Fetching" },
  { key: "download", label: "Downloading" },
  { key: "postprocess", label: "Merging" },
  { key: "finalize", label: "Saving" },
];

const STAGE_ALIASES: Record<string, string> = { destination: "finalize", filepath: "finalize" };

function StageTimeline({ stage }: { stage: string }) {
  const current = STAGES.findIndex((entry) => entry.key === (STAGE_ALIASES[stage] || stage));
  if (current < 0) {
    return null;
  }

  return (
    <ol class="flex items-center gap-2">
      {STAGES.map((entry, index) => (
        <li key={entry.key} class="flex min-w-0 flex-1 items-center gap-2">
          <span
            class={`size-2 shrink-0 rounded-full ${index <= current ? "bg-accent" : "bg-separator"}`}
            // The dot is redundant with the highlighted label beside it.
            aria-hidden="true"
          />
          <span class={`truncate text-caption ${index === current ? "text-text" : "text-text-tertiary"}`}>
            {entry.label}
          </span>
          {index < STAGES.length - 1 ? <span aria-hidden="true" class="h-px min-w-4 flex-1 bg-separator" /> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Speed / ETA / bytes / connections, all fields already present on the job (spec §3.1).
 * `.nums` is not decoration: without tabular figures a live speed readout re-flows its
 * own row on every tick (spec §4.3).
 */
function JobReadout({
  percent,
  percentApproximate,
  speed,
  eta,
  downloadedSize,
  totalSize,
  connections,
}: {
  percent: number | null;
  percentApproximate?: boolean;
  speed?: string;
  eta?: string;
  downloadedSize?: string;
  totalSize?: string;
  connections?: number | string;
}) {
  // The tilde is applied here, at the call site, rather than inside
  // `formatDownloadPercent` — spec §4.3 keeps that a single-purpose formatter, and
  // three other callers (`download_progressLabel`, `downloadProgressButtonText`,
  // `downloadDetailEntries`) want the bare number.
  const percentText = percent === null ? "" : `${percentApproximate ? "~" : ""}${formatDownloadPercent(percent)}`;
  const live = [percentText, formatSpeed(speed), formatEta(eta)].filter(Boolean);
  const size =
    downloadedSize && totalSize
      ? `${formatSize(downloadedSize)} of ${formatSize(totalSize)}`
      : formatSize(downloadedSize) || formatSize(totalSize);
  const count = Number(connections);
  const links = connections ? `${connections} ${count === 1 ? "connection" : "connections"}` : "";
  const rest = [size, links].filter(Boolean);

  if (!live.length && !rest.length) {
    return null;
  }

  return (
    <>
      {live.length ? <p class="nums text-body text-text-muted">{live.join("  ·  ")}</p> : null}
      {rest.length ? <p class="nums text-caption text-text-tertiary">{rest.join("  ·  ")}</p> : null}
    </>
  );
}

/**
 * Determinate or indeterminate progress bar, plus the download stage timeline.
 *
 * `aria-valuenow` is omitted while indeterminate — a bar mid-conversion has no
 * honest percentage, and reporting a stale one is worse than reporting none.
 */
export function ProgressBar({
  value,
  label,
  ariaLabel,
  stage,
  speed,
  eta,
  downloadedSize,
  totalSize,
  connections,
  percentApproximate,
}: ProgressBarProps) {
  const indeterminate = value === null;
  const percent = indeterminate ? 0 : clampDownloadPercent(value);
  // The label line and the job readout say the same thing in different words, so only
  // one of them shows: a bare bar keeps the sentence, a job-backed bar keeps the numbers.
  const hasReadout = Boolean(speed || eta || downloadedSize || totalSize || connections);
  // The accessible name is `ariaLabel` (the row usually already names the job); the
  // *value* text is the label, and an approximate percent has to say so there as well
  // as in the readout — spec §4.3 calls the unmarked screen-reader case out by name.
  const valueText = percentApproximate ? `${label} (approximate)` : label;

  return (
    <div class="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={ariaLabel || label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(percent)}
        aria-valuetext={valueText}
        class="h-1.5 w-full overflow-hidden rounded-full bg-raised"
      >
        <span
          class={`block h-full rounded-full bg-accent ${indeterminate ? "sheen-indeterminate" : ""}`.trim()}
          // The one inline style in the library: the fill width is a runtime value,
          // not a theme decision, and Tailwind has no class for an arbitrary runtime
          // percentage. Matches the imperative version's `fill.style.width`.
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      {hasReadout ? (
        <JobReadout
          percent={value}
          percentApproximate={percentApproximate}
          speed={speed}
          eta={eta}
          downloadedSize={downloadedSize}
          totalSize={totalSize}
          connections={connections}
        />
      ) : (
        <span class="text-caption text-text-muted">{label}</span>
      )}
      {stage ? <StageTimeline stage={stage} /> : null}
    </div>
  );
}
