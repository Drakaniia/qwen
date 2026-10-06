/**
 * Download-job state for the popup tray — **global**, not tab-scoped
 * (`global-downloads-spec.md` §5.3).
 *
 * A download is a machine-level fact: the job is in `storage.local`, the background is
 * broadcasting it, and neither the boot read nor the live listener filters by tab any
 * more. `DownloadJob.tabId` is kept as *provenance* — the tray's site chip and the
 * background's resume/retry read it — but nothing in this layer filters on it.
 *
 * `applyJobUpdate` still merges in place: a progress tick must not reorder the list
 * under the user's cursor.
 */
import { computed, signal } from "@preact/signals";

import type { DownloadJob } from "../../shared/contracts.js";
import { isActiveDownload } from "../../shared/download_statuses.js";

/**
 * The render-side job record **is** the wire record, imported rather than mirrored.
 *
 * This used to be a hand-maintained copy, and the copy had already drifted: it was
 * missing `thumbnailUrl` and `createdAt`, the former of which
 * `ui/format.ts:videoThumbnailUrl` reads. `shared/` may not import `popup/` (R11), but
 * the reverse is allowed — so the popup re-exports the shared record instead of
 * restating its 29 fields and dropping two of them.
 */
export type { DownloadJob };

export const currentDownloads = signal<DownloadJob[]>([]);

/**
 * The id whose download flow is mid-await. A row reads this to render its button as
 * "Loading...", which used to mean reaching into the DOM node the click came from.
 */
export const pendingVideoId = signal<string | null>(null);

/** Non-terminal jobs only — the tray's first group, and the header's Downloads badge. */
export const activeDownloads = computed<DownloadJob[]>(() => currentDownloads.value.filter(isActiveDownload));

/** The job currently blocking a video's download button, if any. */
export function runningJobFor(videoId: string, downloads: DownloadJob[]): DownloadJob | undefined {
  return downloads.find((job) => job.videoId === videoId && isActiveDownload(job));
}

/**
 * Merge an updated job from `downloadUpdated` in place, or prepend it.
 *
 * Newest-first on insert, in-place on update: a progress tick must not reorder the
 * list under the user's cursor.
 */
export function applyJobUpdate(current: DownloadJob[], job: DownloadJob): DownloadJob[] {
  const index = current.findIndex((entry) => entry.id === job.id);
  if (index < 0) {
    return [job, ...current];
  }
  const next = [...current];
  next[index] = job;
  return next;
}
