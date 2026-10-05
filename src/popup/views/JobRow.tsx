import { useState } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { ProgressBar } from "../../ui/components/ProgressBar.js";
import { Icon, StatusDot, type IconName, type StatusDotState } from "../../ui/Icon.js";
import { formatSize, jobHostOf } from "../../ui/format.js";
import {
  downloadActions,
  downloadMessageText,
  downloadProgressLabel,
  downloadProgressValue,
  downloadTitle,
  type DownloadAction,
} from "../download_status.js";
import { runDownloadAction } from "../popup_actions.js";
import { settings } from "../state/app.js";
import type { DownloadJob } from "../state/downloads.js";
import { isActiveDownload } from "../../shared/download_statuses.js";

/**
 * One icon per action verb, so the tray's controls read as glyphs rather than four
 * identical text buttons. `none` is the disabled processing placeholder and gets no
 * icon — there is nothing to depict about "Converting…".
 */
const ACTION_ICON: Record<string, IconName> = {
  pause: "pause",
  resume: "play",
  cancel: "xmark",
  retry: "arrow.clockwise",
  "open-file": "arrow.up.doc",
  "show-folder": "folder",
  // The no-`filepath` fallback: the same destination, opened rather than selected.
  "open-folder": "folder",
  remove: "trash",
};

/** Which dot a status gets. `caution` is the deliberate "in flight, not yet moving" state. */
const STATUS_DOT: Record<string, StatusDotState> = {
  queued: "caution",
  connecting: "caution",
  running: "success",
  paused: "caution",
  pausing: "caution",
  canceling: "caution",
  done: "success",
  error: "critical",
  canceled: "critical",
};

function statusOf(job: DownloadJob): string {
  return String(job.status || "queued");
}

/**
 * The site chip. Plain text, not a "jump to tab" link (`global-downloads-spec.md` §2
 * decision 12): the tray is global now, so a job's source tab is history, not a target.
 * No chip at all when the job carries no parseable URL — an empty pill is worse than
 * nothing.
 */
function HostChip({ job }: { job: DownloadJob }) {
  const host = jobHostOf(job);
  return host ? (
    <span class="text-caption text-text-tertiary truncate rounded-badge bg-raised px-1.5 py-0.5">{host}</span>
  ) : null;
}

export interface JobRowProps {
  job: DownloadJob;
}

/**
 * One download job, rendering the whole `DownloadJob` surface that already crossed the
 * wire and was never drawn (spec §1.4, §3.1, §6.8).
 *
 * Before this, the row drew `downloadProgressValue` and `downloadProgressLabel` and
 * nothing else — `speed`, `eta`, `downloadedSize`, `totalSize`, `connections` and
 * `stage` were all present on the type and all rendered nowhere. `ProgressBar` already
 * grew the readouts and the four-stop stage timeline in Phase 0, so the entire change
 * here is passing the job's own fields into it rather than summarising them by hand.
 *
 * ## The action buttons dispatch the real messages
 *
 * The verbs are `downloadActions()`'s, unchanged from the row this replaces, and
 * `runDownloadAction` maps each to a `PopupApi` call in `shared/popup_api.ts`:
 * `pause` → `{type:"pauseDownload"}`, `cancel` → `{type:"cancelDownload"}`, and so on
 * for resume / retry / open-file / show-folder / open-folder / remove. That mapping is
 * the single place the wire names live (`popup_actions.ts`), and this component
 * deliberately does not re-derive or re-spell them. It used to also stamp `data-action` /
 * `data-job-id` on every button on the claim that a delegated dispatcher read them; that
 * dispatcher was replaced by the direct prop call when `runDownloadAction` landed, and
 * nothing in the tree reads either attribute any more, so they are gone rather than kept
 * as a lie.
 *
 * `open-folder` is why this row reads `settings`: it is the fallback a finished job gets
 * when it carries no `filepath`, and it is the only tray verb with no file behind it.
 *
 * ## Terminal jobs render compact
 *
 * §6.8: terminal jobs collapse into a "Recently finished" group, because full history is
 * `downloads.html`'s job (D15) and the popup is a live tray. The *grouping* — the
 * header, the count, the order — belongs to `DownloadsView`; what belongs to a row is
 * the compact form itself, and a row knows it is terminal from its own status.
 */
export function JobRow({ job }: JobRowProps) {
  const [pending, setPending] = useState("");
  const [failure, setFailure] = useState<{ action: string; message: string } | null>(null);

  const status = statusOf(job);
  const active = isActiveDownload(job);
  const title = downloadTitle(job);
  const message = downloadMessageText(job);
  const actions = downloadActions(job, settings.value.downloadFolder || "");

  async function act(action: DownloadAction) {
    setPending(action.action);
    setFailure(null);
    const result = await runDownloadAction(action.action, job.id);
    setPending("");
    // Held until another action is pressed. The old list rebuilt its DOM every render,
    // so an error title vanished with its node; a reused button would otherwise keep a
    // stale error after a later success.
    setFailure(result ? { action: action.action, message: result } : null);
  }

  const bar = (
    <ProgressBar
      value={downloadProgressValue(job)}
      label={downloadProgressLabel(job)}
      ariaLabel={active ? "Download progress" : "Download status"}
      speed={job.speed}
      eta={job.eta}
      downloadedSize={job.downloadedSize}
      totalSize={job.totalSize}
      connections={job.connections}
      stage={job.stage}
      percentApproximate={job.percentApproximate}
    />
  );

  const controls = actions.length ? (
    <div class="flex flex-wrap items-center gap-2">
      {actions.map((action) => {
        const busy = pending === action.action;
        const failed = failure?.action === action.action ? failure.message : "";
        return (
          <Button
            key={action.action}
            variant={action.primary ? "primary" : "secondary"}
            size="sm"
            disabled={action.disabled || busy}
            title={failed || undefined}
            aria-label={failed || undefined}
            onClick={() => void act(action)}
          >
            {ACTION_ICON[action.action] ? <Icon name={ACTION_ICON[action.action]} size={13} /> : null}
            {action.label}
          </Button>
        );
      })}
    </div>
  ) : null;

  if (!active) {
    // Compact terminal row. No meter and no stage timeline: a finished download has no
    // progress to report, and repeating a 100% bar per finished row turns a tray into
    // a wall of full bars.
    return (
      <li class="flex flex-wrap items-center gap-2 rounded-row px-2 py-1.5">
        <StatusDot state={STATUS_DOT[status] || "caution"} label={`${status}: ${title}`} />
        <span class="text-row min-w-0 flex-1 truncate text-text">{title}</span>
        <HostChip job={job} />
        {formatSize(job.totalSize) ? (
          <span class="nums text-caption text-text-tertiary">{formatSize(job.totalSize)}</span>
        ) : null}
        {message ? (
          <span class={`w-full text-caption ${status === "error" ? "text-critical" : "text-text-muted"}`}>
            {message}
          </span>
        ) : null}
        {controls}
      </li>
    );
  }

  return (
    <li class="flex flex-col gap-2 rounded-row p-2">
      <div class="flex items-center gap-2">
        <StatusDot state={STATUS_DOT[status] || "caution"} label={`${status}: ${title}`} />
        <span class="text-row min-w-0 flex-1 truncate text-text">{title}</span>
        <HostChip job={job} />
      </div>

      {bar}

      {message ? (
        <p class={`text-caption ${status === "error" ? "text-critical" : "text-text-muted"}`}>{message}</p>
      ) : null}

      {controls}
    </li>
  );
}
