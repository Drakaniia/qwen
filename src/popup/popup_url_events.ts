// ─── Module references ──────────────────────────────────────────────────────
import * as PopupApi from "../shared/popup_api.js";
import { normalizeManualUrl, shortenUrl } from "../ui/format.js";
import {
  activeTabId,
  chooseQuality,
  hideQualityDialog,
  isCurrentQualityRequest,
  setNotice,
  setViewMode,
  settings,
  showQualityLoading,
} from "./state/app.js";
import { refresh, updateActiveTabContext } from "./popup_helpers.js";
import type { FormatsResponse, PopupResponse } from "./popup_state.js";

/**
 * The active tab id for a message that needs one.
 *
 * The signal is `number | null` because that is its declared initial state, and every
 * handler here calls `updateActiveTabContext()` first. `0` stands in for "no id" and is
 * behaviour-identical to `null` at the far end: `senderTabId` is
 * `message.tabId || sender.tab.id`, and `0` is falsy exactly like `null`, so it falls
 * through to the sender's own tab. Chrome has no tab `0`.
 */
function activeTabIdOrZero(): number {
  return activeTabId.value ?? 0;
}

/**
 * Resolve a pasted link (spec §6.5, D19, D20).
 *
 * ## Why this function exists instead of two
 *
 * `#manualUrl` and `#musicLinkUrl` were two inputs driving two near-identical blocks:
 * normalise, open the quality sheet, pick, dispatch. D20 merges them, and the two blocks
 * collapsed into this one. The music block's only extra step was saving `audioFormat`
 * off the hidden `<select>`, which is a settings-signal read now.
 *
 * ## Why there is no classification here
 *
 * D19: "The smart paste box **does not guess** video vs audio. The native host resolves
 * it and the returned dialog already knows." So nothing in this function looks at the
 * host name, the extension, or `musicMode` — `getFormatsForUrl` answers, and whatever it
 * answers drives the sheet. Guessing wrong is worse than waiting (spec §6.5).
 *
 * ## Why it resolves before the pick
 *
 * The returned promise covers the *resolve*, not the download. The paste box clears its
 * pending state as soon as the sheet is up, because from that moment the user is
 * answering the dialog, not waiting on the helper. Everything after the pick runs
 * detached through {@link dispatchPastedFormat}.
 *
 * @returns whether the quality sheet is now open with the link's formats.
 */
export async function resolvePastedUrl(raw: string): Promise<boolean> {
  await updateActiveTabContext();

  const url = normalizeManualUrl(raw);
  if (!url) {
    setNotice("Enter a valid http:// or https:// link.", true);
    return false;
  }

  setNotice("");

  // D20: `audioFormat` still decides the output container when the resolved item turns
  // out to be audio-only, so the current value goes to the helper with this request.
  const audioFormat = settings.value.audioFormat;
  if (audioFormat) {
    await PopupApi.saveSettings({ audioFormat });
  }

  const token = showQualityLoading("Resolving link...");
  const response = (await PopupApi.getFormatsForUrl(activeTabIdOrZero(), {
    url,
    pageUrl: url,
    title: shortenUrl(url) || "Pasted link",
    format: "PAGE",
    source: "manual-url",
    downloadable: true,
  })) as FormatsResponse | null;

  if (!isCurrentQualityRequest(token)) {
    return false;
  }

  if (!response || !response.ok) {
    hideQualityDialog();
    setNotice(response?.error || "Could not load quality choices for that link.", true);
    return false;
  }

  // Detached on purpose — see the `@returns` note above.
  void dispatchPastedFormat(response);
  return true;
}

/**
 * The half after the sheet: the user's pick becomes a download.
 *
 * Split from {@link resolvePastedUrl} so the paste box's pending state ends when the
 * sheet opens. Still `void`-able and still responsible for its own errors: a download
 * that fails to start has nowhere to return to, so it writes the notice itself.
 */
async function dispatchPastedFormat(response: FormatsResponse): Promise<void> {
  const choice = await chooseQuality(response);
  if (!choice) {
    return;
  }

  const reply = (await PopupApi.downloadVideo(
    activeTabIdOrZero(),
    response.videoId ?? "",
    choice.formatId,
    choice.variantId,
    choice.backend,
  )) as PopupResponse | null;

  if (!reply || !reply.ok) {
    setNotice(reply?.error || "Download failed to start.", true);
  } else {
    setViewMode("downloads");
  }

  await refresh();
}
