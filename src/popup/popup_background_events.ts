// ─── Module references ──────────────────────────────────────────────────────
import type { PopupEvent } from "../shared/contracts.js";
import { activeTabId, updateQualityLoadingStatus } from "./state/app.js";
import { applyJobUpdate, currentDownloads } from "./state/downloads.js";
import { currentVideos } from "./state/videos.js";
import type { VideoCandidate } from "./state/videos.js";
import { api } from "./popup_elements.js";
import { setNotice } from "./state/app.js";
import { checkHelperStatus } from "./popup_helpers.js";

// ─── Background message listener ────────────────────────────────────────────

/**
 * `batchComplete` is a toast-only broadcast the background sends that
 * `contracts.ts` does not list — the union there documents the events a *machine*
 * reads, and this one is prose for the user. It is declared here rather than
 * widening a shared contract for one consumer's single string field.
 */
interface BatchCompleteEvent {
  type: "batchComplete";
  message?: string;
}

api.runtime.onMessage.addListener((message: PopupEvent | BatchCompleteEvent): void => {
  if (!message) {
    return;
  }

  if (message.type === "updateQualityLoadingStatus") {
    updateQualityLoadingStatus(String(message.text ?? ""));
    return;
  }

  if (message.type === "videoListUpdated" && message.tabId === activeTabId.value) {
    // The one cast here: `DetectedVideo` types `width`/`height`/`duration`/`bitrate`/
    // `tbr`/`sizeBytes` as `number | null` (the background's own record) and
    // `VideoCandidate` now declares the same five as nullable too — the cast is only
    // for `sizeBytes`, which the popup narrows to `number`. `Number(null)` is 0
    // everywhere it is read, so the values agree.
    currentVideos.value = message.videos as VideoCandidate[];
  }

  // `contracts.ts` types these payloads as always-present, so the extra `&&` guards read
  // as redundant. They are kept: the listener sees whatever any extension page sends,
  // and dropping them would turn a malformed broadcast into a thrown listener.
  if (message.type === "downloadUpdated" && message.job) {
    // No tab guard: the list is global, so a job started in another tab is a row here.
    // `job.tabId` stays on the record as provenance for the row's site chip.
    currentDownloads.value = applyJobUpdate(currentDownloads.value, message.job);
  }

  // No tabId guard needed for downloadRemoved — the jobId is unique, and the list holds
  // every job on the machine.
  if (message.type === "downloadRemoved" && message.jobId) {
    const jobId = message.jobId;
    currentDownloads.value = currentDownloads.value.filter((job) => job.id !== jobId);
  }

  if (message.type === "batchComplete") {
    setNotice(message.message || "Batch download complete.");
  }

  // One `checkHelperStatus()` answers both questions. It used to also be preceded by a
  // hand-rolled banner teardown — a CSS class, a 200ms timeout and a `hidden` write —
  // because the banner was DOM. `helperStatus` now carries the same information, so
  // clearing the missing list is what hides it and there is nothing to time out.
  if (message.type === "helperStatusChanged") {
    void checkHelperStatus();
  }
});
