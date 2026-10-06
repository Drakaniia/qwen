/**
 * One row of the download history (spec §7).
 *
 * Anatomy is fixed by the spec: thumbnail, title, host, format, size, completion time,
 * and per-row `Open` / `Reveal`. The old page gave those two actions to the newest
 * file only (`DownloadsPage.tsx:88-93`), which is the §1.3 defect - they are per-row
 * and keyed on the row's own `jobId`, which `openDownloadedFile` / `showDownloadedFile`
 * have always accepted.
 *
 * Live rows additionally render the `DownloadJob` fields the redesign stops throwing
 * away (§1.4, §3.1): speed, ETA, bytes, connections and stage go straight into
 * `ProgressBar`, which is where those five fields already had a home.
 */
import { useState } from "preact/hooks";

import { Icon, StatusDot, type StatusDotState } from "../../ui/Icon.js";
import { videoThumbnailCandidates } from "../../ui/format.js";
import { Button } from "../../ui/components/Button.js";
import { ProgressBar } from "../../ui/components/ProgressBar.js";
import {
  downloadActions,
  downloadMessageText,
  downloadProgressLabel,
  downloadProgressValue,
} from "../download_status.js";
import { dayKeyOf, runJobAction, settings, type DownloadRecord } from "./state.js";

/** Dot state per row status: moving, failed, or settled. One shape, three tokens (§4.4). */
function dotState(record: DownloadRecord): StatusDotState {
  if (record.status === "error") {
    return "critical";
  }
  return record.live ? "caution" : "success";
}

/**
 * `3:42 PM` for today, `Mar 3, 3:42 PM` otherwise. The date is redundant inside a day
 * group, but not on a row the user has filtered down to one.
 */
function completionLabel(when: number): string {
  if (!when) {
    return "";
  }
  const date = new Date(when);
  const clock = { hour: "numeric", minute: "2-digit" } as const;
  return dayKeyOf(when) === "today" ? date.toLocaleTimeString(undefined, clock) : date.toLocaleString(undefined, clock);
}

/**
 * The leading tile: the row's thumbnail ladder, with the format glyph as its floor.
 *
 * This was a glyph for every row because `DownloadJob` had no thumbnail field and
 * `fromSync` hardcoded `""` (spec `thumbnail-spec.md` §1.6). Both are fixed now, and
 * art still is not guaranteed, so the tile stays as the last rung:
 *
 *   - A job row's first candidate is the `thumbnailUrl` the background stamps at job
 *     creation (§7.1); the second is whatever `record.url` derives to.
 *   - A synced row has no persisted thumbnail (D6: `SyncEntry` keeps `url` only), so
 *     its single candidate is site-derived in `downloads/state.ts`. A direct `.mp4`
 *     entry derives nothing and lands on the glyph — the accepted cost of D6.
 *
 * `onError` advances the index rather than latching, so a 403 on the first candidate
 * still leaves the second one to try (spec §1.4). The glyph renders only once the
 * ladder is out — `candidates[index]` past the end is `undefined`, which is the whole
 * end-of-ladder test.
 */
function Thumb({ record }: { record: DownloadRecord }) {
  const candidates = videoThumbnailCandidates(record);
  const [index, setIndex] = useState(0);
  const audio = String(record.format).toUpperCase() === "AUDIO";
  const tile =
    "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-row bg-raised text-text-tertiary";
  const src = candidates[index];

  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setIndex(index + 1)}
        class="h-8 w-16 shrink-0 rounded-row bg-raised object-cover"
      />
    );
  }

  return (
    <span class={`${tile} w-16`} aria-hidden="true">
      <Icon name={audio ? "music.note" : "play"} size={16} />
    </span>
  );
}

export interface HistoryRowProps {
  record: DownloadRecord;
  /** The row's `aria-activedescendant` target id — spec §10's roving focus. */
  id: string;
  selected: boolean;
  active: boolean;
  /** Click / `Space` toggle. */
  onSelect(key: string): void;
  onOpen(record: DownloadRecord): void;
  onReveal(record: DownloadRecord): void;
}

export function HistoryRow({ record, id, selected, active, onSelect, onOpen, onReveal }: HistoryRowProps) {
  const job = record.job;
  const message = downloadMessageText(job);
  // Open and Reveal are rendered above with the icons §7 names; everything else the
  // job offers is lifecycle, bound to its own job here so no `!` is needed downstream.
  // `settings.downloadFolder` is what keeps a finished job's `Folder` in that list: with
  // no `filepath` to show, `downloadActions` offers the destination only when it is
  // handed one, so the call used to leave this page with Redownload + Remove alone.
  const lifecycle = job
    ? downloadActions(job, settings.value.downloadFolder || "")
        .filter((action) => action.action !== "open-file" && action.action !== "show-folder")
        .map((action) => ({ ...action, run: () => void runJobAction(action.action, job) }))
    : [];
  const meta = [record.sourceHost, record.format, record.size, completionLabel(record.updatedAt)].filter(Boolean);

  return (
    <div
      role="option"
      id={id}
      aria-selected={selected}
      onClick={() => onSelect(record.key)}
      class={`material-content flex cursor-default items-center gap-3 rounded-row border px-3 py-2 ${
        active ? "border-accent" : "border-transparent"
      } ${selected ? "bg-accent/10" : ""}`}
    >
      <Thumb record={record} />

      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot state={dotState(record)} label={record.status} />
          <span class="truncate text-row text-text" title={record.url || record.title}>
            {record.title}
          </span>
        </div>
        {meta.length ? (
          <span class="flex flex-wrap gap-x-2 text-caption text-text-muted">
            {meta.map((part, index) => (
              <span key={`${part}-${index}`} class={index >= 2 ? "nums" : ""}>
                {part}
              </span>
            ))}
          </span>
        ) : null}
        {job && record.live ? (
          <ProgressBar
            value={downloadProgressValue(job)}
            label={downloadProgressLabel(job)}
            ariaLabel={`${record.title} progress`}
            stage={job.stage}
            speed={job.speed}
            eta={job.eta}
            downloadedSize={job.downloadedSize}
            totalSize={job.totalSize}
            connections={job.connections}
          />
        ) : null}
        {message ? <p class="text-caption text-text-muted">{message}</p> : null}
      </div>

      {/* Clicks on an action must not also land on the row, whose click toggles the
          selection — otherwise "Open" quietly selects the file it opened. */}
      <div class="flex shrink-0 flex-wrap items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
        {/* Spec §7: per-row, on every row that has a file. A synced entry has no
            `filepath` on record, so it renders neither — the honest answer, not a
            disabled button that looks broken. */}
        {job && job.filepath ? (
          <>
            <Button
              size="sm"
              onClick={() => onOpen(record)}
              title="Open the saved file"
              aria-label={`Open ${record.title}`}
            >
              <Icon name="square.and.arrow.up" size={14} />
              Open
            </Button>
            <Button
              size="sm"
              onClick={() => onReveal(record)}
              title="Show the file in Explorer"
              aria-label={`Reveal ${record.title}`}
            >
              <Icon name="folder" size={14} />
              Reveal
            </Button>
          </>
        ) : null}
        {lifecycle.map((action) => (
          <Button
            key={action.action}
            size="sm"
            variant={action.primary ? "primary" : "plain"}
            disabled={action.disabled}
            title={action.action === "none" ? "Nothing to do while this runs" : action.label}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
