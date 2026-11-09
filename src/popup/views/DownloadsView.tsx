import { useState } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { EmptyState } from "../../ui/components/EmptyState.js";
import { SkeletonRow } from "../../ui/components/Skeleton.js";
import { Icon } from "../../ui/Icon.js";
import { pausableDownloadJobs } from "../download_status.js";
import { activeTabId, helperStatus, setViewMode } from "../state/app.js";
import { activeDownloads, currentDownloads, type DownloadJob } from "../state/downloads.js";
import { isActiveDownload } from "../../shared/download_statuses.js";
import * as PopupApi from "../../shared/popup_api.js";
import { runDownloadAction } from "../popup_actions.js";
import { copyInstallCommand, INSTALL_COMMAND, refresh } from "../popup_helpers.js";
import type { PopupResponse } from "../popup_state.js";
import { JobRow } from "./JobRow.js";

/**
 * How many terminal jobs the tray draws. Active jobs are never capped — the tray is a
 * live status list and the cap exists only to keep "Recently finished" from growing
 * without bound now that the list is global.
 *
 * A constant, not a `Settings` field: a number nobody has asked to change does not need an
 * Options row, persistence and a test.
 */
const FINISHED_TRAY_LIMIT = 20;

/** A missing status is `queued`, the same reading `isActiveDownload` gives it. */
const isQueued = (job: DownloadJob) => String(job.status ?? "queued") === "queued";

/** Newest first by `updatedAt` — see {@link JobGroup}. */
const newestFirst = (jobs: DownloadJob[]) =>
  [...jobs].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

/**
 * The tray's four groups, in the order a user scans for them: what is moving, what is
 * waiting its turn, what needs a decision, what is done.
 *
 * `queued` used to sit inside "Active downloads" and `error` inside "Recently finished".
 * Now that every download goes through the background's concurrency queue, a batch of
 * twenty shows three moving rows and seventeen waiting ones, and a failure sorted among
 * successes by time was a row the user had to go looking for.
 */
function groupJobs(jobs: DownloadJob[]) {
  const active = jobs.filter((job) => isActiveDownload(job) && !isQueued(job));
  const queued = jobs
    .filter((job) => isActiveDownload(job) && isQueued(job))
    // Queue order is start order, so the row about to start sits at the top.
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const terminal = jobs.filter((job) => !isActiveDownload(job));
  const failed = newestFirst(terminal.filter((job) => job.status === "error"));
  const finished = newestFirst(terminal.filter((job) => job.status !== "error"));
  return { active, queued, failed, finished };
}

/**
 * The popup's downloads tray (spec §6.8, D15).
 *
 * **Global, not tab-scoped** (`global-downloads-spec.md` §2): a download started on any
 * tab is a row here, and every job's actions work from any tab — the background resolves
 * jobs by `jobId`, never by tab. `DownloadJob.tabId` is provenance for the row's site chip.
 *
 * Jobs are grouped by {@link groupJobs}; a group with no rows does not render. Terminal
 * groups are capped: full history is `downloads.html`'s job, not a tray's, and the popup's
 * height is the reason.
 *
 * Each row hands `JobRow` the whole `DownloadJob`, which already carries `speed`, `eta`,
 * `downloadedSize`, `totalSize`, `connections` and `stage` — the six fields acceptance #4
 * requires and that the old tray threw away.
 */
export function DownloadsView() {
  const jobs = currentDownloads.value;
  const active = activeDownloads.value;
  const groups = groupJobs(jobs);
  const connected = helperStatus.value.connected;
  const bulk = bulkControlFor(active);

  // Nothing known yet: `currentDownloads` starts empty and `helperStatus` starts null, so
  // on the first paint *every* branch below would be a guess. Skeletos, not a sentence.
  if (connected === null) {
    return (
      <div aria-label="Checking the native helper" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  // Helper missing is checked before the list: every download fails without it, so
  // showing a download-shaped screen above "the helper is not installed" would be a lie
  // about what the popup can do.
  if (!connected) {
    return (
      <EmptyState
        icon="exclamationmark.triangle"
        tone="critical"
        headline="Downloads need the native helper"
        body={`Qwin hands downloads to a local Python helper that calls yt-dlp. Run ${INSTALL_COMMAND} from the project directory to install it.`}
        action={{ label: "Copy install command", onClick: () => void copyInstallCommand() }}
      />
    );
  }

  if (!jobs.length) {
    return (
      <EmptyState
        icon="square.and.arrow.down"
        headline="No downloads yet"
        body="Nothing is downloading yet. Start one from Media."
        action={{ label: "Go to Media", onClick: () => setViewMode("media") }}
      />
    );
  }

  return (
    <>
      {/* `role="list"`, deliberately *not* `role="listbox"`.
          §10's roving-tabindex model is for Media, which is a genuine multi-select list.
          A job row carries Pause / Resume / Cancel / Open / Folder buttons, and a roving
          tabindex would take every one of them out of the tab order — the whole row
          would become one tab stop whose buttons a keyboard user could never reach. So
          the tray keeps ordinary per-control focus and only Media gets `useListKeys`. */}
      {bulk ? <BulkVerb jobs={bulk.jobs} verb={bulk.verb} /> : null}

      {active.length ? null : <p class="px-4 py-3 text-caption text-text-muted">Nothing is downloading right now.</p>}

      <JobGroup id="active" title="Active" jobs={groups.active} />
      <JobGroup id="queued" title="Queued" count={groups.queued.length} jobs={groups.queued} />
      {/* No "Retry all": the popup API has no retry-many message, and each failed row
          already carries its own Retry. */}
      <JobGroup id="failed" title="Failed" jobs={groups.failed} limit={FINISHED_TRAY_LIMIT} />
      <JobGroup id="finished" title="Finished" jobs={groups.finished} limit={FINISHED_TRAY_LIMIT} />

      {/* `clearDownloads` forgets every terminal record, failed ones included — so the
          button shows whenever either terminal group does, exactly as it did when both
          lived under one heading. */}
      {groups.failed.length || groups.finished.length ? <ClearFinished /> : null}
    </>
  );
}

/**
 * Which bulk verb the tray offers over its active list, and over which jobs — or
 * `null` for neither.
 *
 * **One toggle, not two buttons.** "Pause all" and "Resume all" are the same control
 * pointed at the other end of the set, and a tray is in practice one or the other:
 * either something is moving or the user just stopped it. Rendering both would mean
 * picking which one is *disabled* whenever the tray holds a running job and a paused
 * one, and a permanently disabled button is the noise this control exists to avoid —
 * so it disappears entirely instead, and only the actionable direction shows.
 */
function bulkControlFor(active: DownloadJob[]): { jobs: DownloadJob[]; verb: "pause" | "resume" } | null {
  const moving = pausableDownloadJobs(active);
  if (moving.length) {
    return { jobs: moving, verb: "pause" };
  }
  const paused = active.filter((job) => job.status === "paused");
  return paused.length ? { jobs: paused, verb: "resume" } : null;
}

/**
 * The tray's bulk verb, sitting in the toolbar region above "Active downloads" and
 * hidden outright when there is nothing for it to do.
 *
 * No `pauseAll` message exists, by design: `runDownloadAction` already maps a per-job
 * `pause` onto `{type:"pauseDownload"}`, and pausing N downloads *is* N requests. The
 * icon reuses `JobRow`'s `ACTION_ICON` convention (pause → `pause`, resume → `play`) so
 * the tray control and the per-row buttons read as one system.
 */
function BulkVerb({ jobs, verb }: { jobs: DownloadJob[]; verb: "pause" | "resume" }) {
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    // ponytail: one refresh per job, because `runDownloadAction` refreshes on every
    // success and that is its contract. A real `pauseAll` handler would make this one
    // message and one refresh; add it if a 20-job batch is ever measurably slow.
    await Promise.all(jobs.map((job) => runDownloadAction(verb, job.id)));
    setPending(false);
  }

  return (
    <div class="flex justify-end px-4 pt-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => void run()}>
        <Icon name={verb === "pause" ? "pause" : "play"} size={13} />
        {verb === "pause" ? "Pause all" : "Resume all"}
      </Button>
    </div>
  );
}

/**
 * Forget the finished jobs, keeping the files on disk.
 *
 * This is what the footer's "Clear page" stopped doing (§5.5): it reads as a
 * machine-wide clear from a button labelled "Clear page", and the tray is global now.
 * The popup has no equivalent of `downloads/state.ts`'s `clearAll`, so it sends
 * `clearDownloads` itself and refreshes — the shape `runDownloadAction` uses. The
 * background keeps every job that is still active, and per-row *Remove* is still the only
 * thing that deletes a file.
 */
function ClearFinished() {
  return (
    <div class="flex justify-end px-4 pb-3">
      <Button size="sm" variant="ghost" onClick={() => void clearFinished()}>
        Clear finished
      </Button>
    </div>
  );
}

async function clearFinished(): Promise<void> {
  const response = (await PopupApi.clearDownloads(activeTabId.value ?? -1)) as PopupResponse | null;
  if (response && response.ok) {
    await refresh();
  }
}

/**
 * One tray group under a real heading (spec §6.8), or nothing when it is empty.
 *
 * The terminal groups arrive newest first by `updatedAt` rather than in insertion order:
 * a job that finished twenty minutes ago should sit above one that finished an hour ago,
 * and `applyJobUpdate` merges progress ticks in place so the array's own order is the
 * order they were *started*.
 *
 * `limit` caps a terminal group at {@link FINISHED_TRAY_LIMIT}, with the overflow said out
 * loud — a silent truncation reads as "that was all of them". The footer's "All downloads"
 * link is already one click away, so this line points at it rather than adding a second
 * one. Active and queued jobs are never capped: the tray is a live status list.
 */
function JobGroup({
  id,
  title,
  jobs,
  count,
  limit,
}: {
  id: string;
  title: string;
  jobs: DownloadJob[];
  /** Shown beside the heading; the queue is the group whose length is the news. */
  count?: number;
  limit?: number;
}) {
  if (!jobs.length) {
    return null;
  }
  const shown = limit ? jobs.slice(0, limit) : jobs;
  const overflow = jobs.length - shown.length;
  const headingId = `qwin-${id}-heading`;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} class="section-label text-section text-text-tertiary px-4 pt-2 pb-1">
        {title}
        {count ? <span class="nums"> · {count}</span> : null}
      </h2>
      <ul role="list" aria-labelledby={headingId} class="flex flex-col gap-2 px-4 pt-1 pb-3">
        {shown.map((job) => (
          <JobRow key={job.id || job.videoId} job={job} />
        ))}
      </ul>
      {overflow > 0 ? <p class="px-4 pb-2 text-caption text-text-tertiary">{overflow} more in All downloads</p> : null}
    </section>
  );
}
