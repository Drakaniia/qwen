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

import { isActiveDownload } from "../../shared/download_statuses.js";

export interface DownloadJob {
  id: string;
  videoId?: string;
  tabId?: number;
  status?: string;
  percent?: number;
  rawPercent?: number;
  stage?: string;
  message?: string;
  error?: string;
  url?: string;
  title?: string;
  format?: string;
  formatId?: string;
  variantId?: string;
  backend?: string;
  filepath?: string;
  artifactRoot?: string;
  pageUrl?: string;
  fragment?: string;
  speed?: string;
  eta?: string;
  totalSize?: string;
  downloadedSize?: string;
  connections?: number | string;
  /**
   * `true` means `percent` is an **estimate**, not a measurement — spec D2/D9
   * (`real-progress-spec.md` §4.1). Absent/false is exact.
   *
   * **Structural duplicate of the same field in `shared/contracts.ts`; the two must
   * stay in sync.** `shared/` cannot import from `popup/` (layering rule R11), so the
   * record is written twice rather than shared, and this is the render-side half:
   * `ProgressBar` reads it to print a `~` and to mark `aria-valuetext`. A field that
   * exists in only one copy is a field the other layer silently drops on the wire.
   */
  percentApproximate?: boolean;
  rawProgressLine?: string;
  updatedAt?: number;
}

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
