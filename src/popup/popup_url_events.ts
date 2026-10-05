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
import { select as selectVideos } from "../ui/useStickySelection.js";
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
 * The popup's reply-narrowing helper, verbatim from `popup/downloads/state.ts`:
 * `popup_api.js` types every response as a bare `Object`, so the properties read here are
 * invisible to the checker, and one cast beats repeating it at every call site.
 *
 * Third copy on purpose — `popup/options/state.ts` keeps its own and neither is exported.
 * Deduplicating them means editing two files this change does not own; do it as its own
 * pass, not folded into a feature. `null` is folded to `{}`, so callers never null-check.
 */
function asRecord(response: unknown): Record<string, any> {
  return (response || {}) as Record<string, any>;
}

/**
 * "This URL is one track", raised by the native resolver
 * (`backends/spotify/spotify_resolver.py`) for a `/track/` URL, which it refuses to
 * expand because its job is collections.
 *
 * An internal marker, never copy for the user: a single track is exactly what the
 * `getFormatsForUrl` flow below is for, so the sentinel branch falls through to it rather
 * than reporting the marker as an error. Matching is a substring test because the host
 * prefixes the marker with prose ("Use the formats flow for individual tracks.").
 */
const SINGLE_TRACK_SENTINEL = "__QWIN_SINGLE_TRACK__";

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
 * ## Why a playlist answers differently
 *
 * `enumeratePlaylist` runs first, ahead of `getFormatsForUrl`, because a collection and
 * a single item are not two answers to the same question. A playlist has no per-item
 * quality sheet (spec §6.5), so it expands to rows and Downloads; anything that is not a
 * collection — including a single track, which the native resolver marks with
 * {@link SINGLE_TRACK_SENTINEL} rather than expanding — continues into the original
 * single-URL flow untouched. "Is a collection" is the host's own `isCollection` flag, not
 * a count: `--flat-playlist` reports one entry for an ordinary video URL.
 *
 * @returns whether the paste was handled: rows for a playlist, the quality sheet for a
 *   single link, `false` with a notice on failure.
 */
export async function resolvePastedUrl(raw: string): Promise<boolean> {
  await updateActiveTabContext();

  const url = normalizeManualUrl(raw);
  if (!url) {
    setNotice("Enter a valid http:// or https:// link.", true);
    return false;
  }

  setNotice("");

  // Shown before enumeration, not after: every non-Spotify paste is extracted twice (once
  // flat for the collection check, once for the real formats), and with the dialog opened
  // only afterwards the whole first extraction passed with nothing on screen.
  const token = showQualityLoading("Resolving link...");

  // A pasted link is a collection as often as it is a video, and the two want different
  // shapes: a playlist becomes rows plus the Downloads view, a single link becomes the
  // quality sheet below. One extra message buys that split, and the single flow stays the
  // fallback for every answer that is not a collection — including "not a collection".
  let playlist: Record<string, any> = {};
  try {
    playlist = asRecord(await PopupApi.enumeratePlaylist(activeTabIdOrZero(), url));
  } catch (_error) {
    // A transport-level rejection says nothing about the URL — the helper can be down, the
    // worker asleep, the native port timed out on a 100-item enumeration. Falling through
    // to the single-URL flow can only recover; letting it escape would make the paste box
    // a silent no-op, since nothing above this call has a try/catch.
  }

  // `isCollection`, not a length check: `yt-dlp --flat-playlist` answers a plain video URL
  // with one entry and no playlist title, so a single-item result is indistinguishable
  // from a one-track album by count alone. The host knows which it was; anything it did
  // not vouch for goes to the formats flow, which is what a plain link needs.
  if (playlist.ok && playlist.isCollection === true && playlist.videoIds?.length) {
    // No quality sheet for a playlist: bulk quality is `best` and the per-track picker is
    // explicitly out (spec §6.5), so a dialog here would ask a question with one answer.
    hideQualityDialog();
    const title = playlist.playlistTitle || "playlist";
    const added = playlist.videoIds.length;
    // Rows live in Media, not in Downloads (jobs only) — switching views here hid the
    // expansion behind the tray and read as "the list appeared, then vanished". Stay put
    // and pre-select the rows so the selection bar offers Download all in one click.
    selectVideos(playlist.videoIds);
    // Spec §4: a capped enumeration has to name what it dropped, or "Added 100 tracks"
    // reads as the whole playlist.
    setNotice(
      playlist.truncated
        ? `Added ${added} tracks from ${title} — the first ${added} of ${playlist.totalItems}. Press Download all.`
        : `Added ${added} tracks from ${title}. Press Download all.`,
    );
    await refresh();
    return true;
  }
  // Anything else that failed is a real failure — a track (the sentinel) is not, so it
  // falls through to the single-URL flow, which is the path that handles one track.
  if (!playlist.ok && playlist.error && !String(playlist.error).includes(SINGLE_TRACK_SENTINEL)) {
    hideQualityDialog();
    setNotice(String(playlist.error), true);
    return false;
  }

  // D20: `audioFormat` still decides the output container when the resolved item turns
  // out to be audio-only, so the current value goes to the helper with this request.
  const audioFormat = settings.value.audioFormat;
  if (audioFormat) {
    await PopupApi.saveSettings({ audioFormat });
  }

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
