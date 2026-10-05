/**
 * The download flows the UI triggers: start a download, act on a running job.
 *
 * These used to be two delegated `click` listeners in `popup_events.js`, each
 * reaching back into the DOM node it came from to disable it, rename it, and restore
 * it on every early return. The components own that state now, so a failure path
 * cannot forget to re-enable anything — the `finally` blocks are the whole trick.
 */
import * as PopupApi from "../shared/popup_api.js";
import {
  activeTabId,
  chooseQuality,
  hideQualityDialog,
  isCurrentQualityRequest,
  setNotice,
  setViewMode,
  showQualityLoading,
} from "./state/app.js";
import { pendingVideoId } from "./state/downloads.js";
import { hasActiveTab, refresh, rescanActiveTab, updateActiveTabContext } from "./popup_helpers.js";
import type { FormatsResponse, PopupResponse } from "./popup_state.js";

/** Start (or restart) the download for a video, prompting for a format first. */
export async function startVideoDownload(videoId: string): Promise<void> {
  pendingVideoId.value = videoId;
  try {
    const tabChanged = await updateActiveTabContext();
    if (!hasActiveTab()) {
      hideQualityDialog();
      setNotice("No active tab found.", true);
      return;
    }
    if (tabChanged) {
      await rescanActiveTab();
      setNotice("Active tab changed. Choose a video from the refreshed list.", true);
      return;
    }

    // `hasActiveTab()` above is the guard; the signal's null initial state is
    // unreachable past it. See the same note in `popup_helpers.ts`.
    const tabId = activeTabId.value as number;
    const requestToken = showQualityLoading();
    const formatsResponse = (await PopupApi.getVideoFormats(tabId, videoId)) as FormatsResponse | null;

    if (!isCurrentQualityRequest(requestToken)) {
      return;
    }
    if (!formatsResponse || !formatsResponse.ok) {
      hideQualityDialog();
      setNotice(formatsResponse?.error || "Could not load quality choices.", true);
      return;
    }

    const selectedFormat = await chooseQuality(formatsResponse);
    if (!selectedFormat) {
      return;
    }

    const response = (await PopupApi.downloadVideo(
      tabId,
      formatsResponse.videoId || videoId,
      selectedFormat.formatId,
      selectedFormat.variantId,
      selectedFormat.backend,
    )) as PopupResponse | null;

    if (!response || !response.ok) {
      setNotice(response?.error || "Download failed to start.", true);
    } else {
      setViewMode("downloads");
    }

    await refresh();
  } finally {
    if (pendingVideoId.value === videoId) {
      pendingVideoId.value = null;
    }
  }
}

/**
 * Run one action from a download row's buttons.
 *
 * `action` is the `data-action` string `download_status.ts` puts on each button, which
 * is why the switch is open-ended: an unknown verb simply leaves the reply null and
 * falls through to the shared failure message.
 * @returns "" on success, otherwise the message to show.
 */
export async function runDownloadAction(action: string, jobId: string): Promise<string> {
  const tabId = activeTabId.value as number;
  let raw: unknown = null;

  switch (action) {
    case "pause":
      raw = await PopupApi.pauseDownload(tabId, jobId);
      break;
    case "resume":
      raw = await PopupApi.resumeDownload(tabId, jobId);
      break;
    case "cancel":
      raw = await PopupApi.cancelDownload(tabId, jobId);
      break;
    case "retry":
      raw = await PopupApi.retryDownload(tabId, jobId);
      break;
    case "open-file":
      raw = await PopupApi.openDownloadedFile(tabId, jobId);
      break;
    // The same native verb as `open-file`: `os.startfile` on a directory opens the
    // folder, which is the whole point of the no-`filepath` fallback.
    case "open-folder":
      raw = await PopupApi.openDownloadedFile(tabId, jobId);
      break;
    case "show-folder":
      raw = await PopupApi.showDownloadedFile(tabId, jobId);
      break;
    case "remove":
      raw = await PopupApi.removeDownload(tabId, jobId);
      break;
    default:
      break;
  }

  // One cast for all seven verbs: they share the envelope, and the switch is
  // open-ended, so a new verb needs no type change here.
  const response = raw as PopupResponse | null;

  if (!response || !response.ok) {
    const message = response?.error || "Download action failed.";
    setNotice(message, true);
    return message;
  }

  if (action === "retry") {
    setViewMode("downloads");
  }
  await refresh();
  return "";
}
