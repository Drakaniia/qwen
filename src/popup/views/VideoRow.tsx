import { useEffect, useState } from "preact/hooks";

import { PLAYLIST_LIKE_FORMATS } from "../../shared/media_patterns.js";
import * as PopupApi from "../../shared/popup_api.js";
import { Button } from "../../ui/components/Button.js";
import { Checkbox } from "../../ui/components/Checkbox.js";
import { ProgressBar } from "../../ui/components/ProgressBar.js";
import {
  displayFormat,
  formatDuration,
  formatSize,
  resolutionLabel,
  sourceLabel,
  videoThumbnailCandidates,
  videoTitle,
} from "../../ui/format.js";
import { Icon } from "../../ui/Icon.js";
import { isSelected, toggle } from "../../ui/useStickySelection.js";
import { downloadProgressButtonText, downloadProgressValue } from "../download_status.js";
import { startVideoDownload } from "../popup_actions.js";
import { activeTabId } from "../state/app.js";
import { currentDownloads, pendingVideoId, runningJobFor } from "../state/downloads.js";
import { AUDIO_FORMAT, type VideoCandidate } from "../state/videos.js";

/**
 * The two container-ish labels in the ladder are different facts and used to be one.
 *
 * `displayFormat` answers "what file will I get" — `m3u8`/`mpd`/`ism` all collapse to
 * `MP4`, because that is the container yt-dlp muxes them into. §6.6's anatomy shows
 * `MP4 · HLS` side by side, so the streaming protocol has to be its own column or the
 * row never says it is adaptive. Two facts, two columns; the ladder reads
 * `resolution · container · protocol`.
 *
 * Nothing else on the row changes meaning for a stream that is not adaptive, which is
 * why the map has no default — an unrecognised format falls through to `sourceLabel`.
 */
const PROTOCOL_LABEL: Record<string, string> = { M3U8: "HLS", MPD: "DASH", ISM: "SMOOTH" };

/**
 * The segmented formats H4 allows a grab for once the ladder is *non-empty and spent*.
 *
 * `PLAYLIST_LIKE_FORMATS` minus the two container-ish entries: a `YOUTUBE` or `PAGE`
 * candidate always has art to derive, so its ladder never runs dry in a way a frame
 * would fix. Importing the set and removing those two keeps this one list instead of a
 * second hand-typed one that can drift.
 */
const SEGMENTED_FORMATS: ReadonlySet<string> = new Set(
  [...PLAYLIST_LIKE_FORMATS].filter((format) => format !== "YOUTUBE" && format !== "PAGE"),
);

function isAudioCandidate(video: VideoCandidate): boolean {
  return String(video.format || "").toUpperCase() === AUDIO_FORMAT;
}

/**
 * Whether a video whose ladder is out is worth one ffmpeg spawn (H4).
 *
 * Deliberately wider than the reported bug — "empty ladder, any format" also admits a
 * poster-less direct `.mp4`. The grab is format-agnostic and the H9 budget bounds the
 * cost; narrowing is one predicate here if it ever spawns too many ordinary MP4s
 * (spec §11).
 */
function grabEligible(video: VideoCandidate, candidateCount: number): boolean {
  if (candidateCount === 0) {
    return true;
  }
  return SEGMENTED_FORMATS.has(String(video.format || "").toUpperCase());
}

/**
 * Videos this popup document has already asked for a frame for, keyed `tabId:id`.
 *
 * The background dedupes by URL and the budget bounds the cost, but this row
 * re-renders on every progress tick and on every `videoListUpdated`, so without a
 * guard the same tile would re-ask forever. Keyed by tab *and* id because the popup is
 * tab-scoped and `video.id` is only unique within a tab.
 *
 * ponytail: a growing set, not a `Map` — cleared when the popup document is torn down
 * anyway. One entry per row the user actually saw with an empty tile, so the ceiling is
 * "videos detected per popup open".
 */
const framesRequested = new Set<string>();

/**
 * The checkbox's reveal rule (spec §6.6, D21), verbatim: *"Never a checkbox the user
 * has to hunt for, never one that shifts layout on hover — it occupies its cell at
 * `opacity: 0` and fades, so nothing reflows."*
 *
 * Always visible on a selected row, on a touch device, and under 420px where the row
 * has collapsed to near single-column. The touch rule is a separate media query rather
 * than a consequence of Tailwind's `hover:` variant: v4 compiles `group-hover:` to
 * `:is(:where(.group):hover *)` with **no** `@media (hover: hover)` gate (verified in the
 * built `style-*.css`), and a tap leaves `:hover` stuck on afterwards — so relying on
 * hover alone would mean a phone either never reveals the box or reveals it by accident.
 * `focus-within` is there so a keyboard user tabbing to the box sees it too.
 *
 * `duration-150` is the spec's one permitted tween (§4.5: "value crossfade — 150ms
 * ease-out on opacity only"), and `theme.css` clamps it to 150ms under
 * `prefers-reduced-motion`, so the fade survives reduced motion as §4.6 requires.
 */
const REVEAL =
  "opacity-0 transition-opacity duration-150 focus-within:opacity-100 " +
  "group-hover:opacity-100 max-[419px]:opacity-100 [@media(hover:none)]:opacity-100";

export interface VideoRowProps {
  video: VideoCandidate;
  /** The listbox's active row (`useListKeys`'s `activeIndex`). Drives the visible marker, not focus. */
  active: boolean;
  selected: boolean;
  /**
   * Optional, and the only way the parent can make `aria-activedescendant` resolve:
   * `useListKeys` names a row by id, and only the parent knows both the index and this
   * candidate. Pass `useListKeys`'s `rowId(index)`.
   */
  id?: string;
}

/**
 * One detected candidate: thumbnail, the inline resolution ladder, the selection
 * checkbox, and either the download button or — when a job is running — the live
 * progress meter in the button's place.
 *
 * ## Where the five new fields come from
 *
 * `width` / `height` / `duration` / `bitrate` / `tbr` arrive on `DetectedVideo`
 * (`shared/contracts.ts:57-61`) and were dropped by the popup's render type. §3.1 is the
 * finding that this row is the *consumer* of: the ladder below is the entire reason
 * they were worth keeping on the wire. Opening the format sheet is now the refinement
 * path, not the discovery path.
 *
 * ## Why the job is read from a signal and not passed in
 *
 * §6.6: *"When a job is running the row BECOMES the progress display — the button is
 * replaced in place by the meter so the row does not grow."* Deciding that needs the
 * job, and the job arrives on a stream the background pushes per tick. Threading it
 * through a prop would put a re-render of every row on every tick of one row's progress;
 * reading `runningJobFor` against the module-level signal keeps the subscription per row,
 * which is what `applyJobUpdate`'s in-place merge already assumes.
 *
 * ponytail: no virtualization (spec §13). Every surviving candidate renders a row. The
 * ceiling behind that is still unmeasured — see §13: the p99 has never been collected,
 * and this redesign is not the place to collect it. Reverse it at p99 >= ~50 rows with
 * `@tanstack/virtual` (~5 KB, and it handles the variable row height a
 * thumbnail-bearing row has).
 */
export function VideoRow({ video, active, selected, id }: VideoRowProps) {
  const [thumbIndex, setThumbIndex] = useState(0);
  const [subtitlesOpen, setSubtitlesOpen] = useState(false);

  const isAudio = isAudioCandidate(video);
  const pending = pendingVideoId.value === video.id;
  const job = runningJobFor(video.id, currentDownloads.value);

  // The ordered ladder, advanced on `onError` rather than latched (spec §6, D4/D15).
  // A too-small or 403'd URL is only one of up to three sources now, so one failure is
  // no longer terminal.
  const candidates = videoThumbnailCandidates(video);
  const thumbnail = candidates[thumbIndex] || "";
  // End of ladder — every source failed, which is the only state the glyph is for. The
  // last attempt is *kept on screen*, blurred and dimmed, because D15's reason for the
  // backdrop still holds: a thumbnail that resolved at too low a resolution to be
  // recognisable still identifies the video, and a bare play icon does not.
  const exhausted = thumbIndex >= candidates.length;
  const backdrop = exhausted ? candidates[candidates.length - 1] || "" : "";

  // The index is a cursor that only ever moves forward, so a *grown* ladder would leave
  // it pointing past the end and the row would keep showing the glyph with the new art
  // right there behind it. A keyed remount does not help: the frame arriving here does
  // not change `video.id`, the background splices the `data:` URL into the ladder and
  // pushes `videoListUpdated` (hls-thumbnail-spec.md §5.2), and the row re-renders with
  // a *longer* ladder under the same identity. So the index resets here, keyed on the
  // ladder's head: `candidates[0]` is referentially stable while nothing changes, so
  // this fires once per genuine change rather than once per render.
  useEffect(() => setThumbIndex(0), [candidates[0]]);

  // H3: ask for a frame once the ladder is out. H4 decides eligibility. H8: no pending
  // state, no spinner, no layout shift — the glyph stays until `videoListUpdated`
  // brings the frame, which is also why this row re-renders for free when it lands.
  // H10: an empty reply is not an error; nothing is displayed for a failed grab.
  useEffect(() => {
    const tabId = activeTabId.value;
    if (!exhausted || tabId === null || !grabEligible(video, candidates.length)) {
      return;
    }
    const key = `${tabId}:${video.id}`;
    if (framesRequested.has(key)) {
      return;
    }
    framesRequested.add(key);
    void PopupApi.grabThumbnailFrame(tabId, video.id);
  }, [exhausted, video, candidates.length]);

  // The parent owns `selected` so the listbox can mark `aria-selected`; the checkbox is
  // the one writer, and it goes through the shared set so the sticky bar's count and
  // this box cannot disagree.
  const checked = selected || isSelected(video.id);

  const protocol = PROTOCOL_LABEL[String(video.format || "").toUpperCase()] || sourceLabel(video);
  const ladder = [resolutionLabel(video.height, isAudio), displayFormat(video), protocol].filter(
    // `resolutionLabel` returns an em dash for an unknown height and `displayFormat`
    // returns "VIDEO" for anything unclassified; neither is worth a column, and an
    // empty gap between two separators is worse than one fewer column.
    (part) => part && part !== "—",
  );

  const size = formatSize(video.sizeBytes || video.size);
  const duration = formatDuration(video.duration);
  const subtitleCount = video.subtitleLanguages || 0;

  const tail = [size, duration].filter(Boolean);

  const meterSlot = "flex h-7 min-w-0 items-center";
  const action = !video.downloadable ? null : job ? (
    // The meter takes the button's exact 28px box so the row does not grow when a job
    // starts (§6.6). `overflow-hidden` is the other half: a stage timeline inside a
    // 28px band would otherwise push the row taller.
    <div class={`${meterSlot} overflow-hidden rounded-row px-1`}>
      <ProgressBar
        value={downloadProgressValue(job)}
        label={downloadProgressButtonText(job)}
        ariaLabel="Download progress"
        speed={job.speed}
        eta={job.eta}
        downloadedSize={job.downloadedSize}
        totalSize={job.totalSize}
        connections={job.connections}
        stage={job.stage}
        percentApproximate={job.percentApproximate}
      />
    </div>
  ) : (
    <Button variant="primary" size="sm" disabled={pending} onClick={() => void startVideoDownload(video.id)}>
      <Icon name="download" size={14} />
      {pending ? "Loading…" : isAudio ? "Extract audio" : "Download"}
    </Button>
  );

  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      class={`group flex gap-3 rounded-row p-2 transition-colors ${active ? "bg-raised" : ""}`.trim()}
    >
      {/* The checkbox keeps its cell at every width; only its opacity moves. */}
      <span class="flex w-4 shrink-0 items-start justify-center pt-0.5">
        <span class={checked ? "" : REVEAL}>
          <Checkbox checked={checked} onChange={() => toggle(video.id)} ariaLabel={`Select ${videoTitle(video)}`} />
        </span>
      </span>

      {/* Thumbnails are unconditional (spec §6.6 — `layout.css:96`'s
          `.video-preview { display: none }` was the bug, and there is no longer a
          `.boxes` mode to switch it on with, D12). The fallback is a blurred backdrop
          of the same image behind a scrim, NOT a grey gradient with a CSS triangle:
          a broken thumbnail usually means the URL resolved at too low a resolution to
          be recognisable, so the pixels that did arrive still identify the video. */}
      <span class="relative aspect-video w-20 shrink-0 overflow-hidden rounded-badge bg-raised">
        {thumbnail || backdrop ? (
          <img
            class={`size-full object-cover transition-[filter,opacity] duration-150 ${
              backdrop ? "scale-110 opacity-50 blur-[6px]" : ""
            }`.trim()}
            alt=""
            loading="lazy"
            decoding="async"
            src={thumbnail || backdrop}
            // Guarded on `thumbnail`: the exhausted backdrop is a URL already known to be
            // dead, so letting it advance would re-set state for ever on one tile.
            onError={() => thumbnail && setThumbIndex((index) => index + 1)}
          />
        ) : null}
        {exhausted ? (
          <>
            <span aria-hidden="true" class="absolute inset-0 bg-black/20" />
            <span
              aria-hidden="true"
              class={`absolute inset-0 flex items-center justify-center ${
                isAudio ? "text-purple" : "text-text-tertiary"
              }`.trim()}
            >
              <Icon name={isAudio ? "music.note" : "play"} size={20} />
            </span>
          </>
        ) : null}
      </span>

      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 items-start gap-2">
          {/* No `text-balance`: it fights a 2-line clamp (spec §6.6) by rebalancing on
              every truncation, so the second line's start point moves as the title
              length changes. */}
          <p class="text-row line-clamp-2 min-w-0 flex-1 text-text" title={video.url || undefined}>
            {videoTitle(video)}
          </p>
          {isAudio ? (
            <span
              class="inline-flex shrink-0 items-center gap-1 rounded-badge bg-purple/12 px-1.5 py-0.5 text-caption text-purple"
              title="Audio only"
            >
              <Icon name="music.note" size={12} />
              Audio
            </span>
          ) : null}
          {video.hasSubtitles ? (
            <button
              type="button"
              aria-expanded={subtitlesOpen}
              onClick={() => setSubtitlesOpen((open) => !open)}
              class={`pressable shrink-0 rounded-badge px-1.5 py-0.5 text-caption transition-colors ${
                subtitlesOpen ? "bg-raised text-text" : "bg-raised text-text-muted hover:text-text"
              }`.trim()}
            >
              {subtitleCount > 0 ? `CC · ${subtitleCount} languages` : "CC"}
            </button>
          ) : null}
        </div>

        <p class="nums text-body text-text-muted">{ladder.join("  ·  ")}</p>

        {tail.length ? <p class="nums text-caption text-text-tertiary">{tail.join("  ·  ")}</p> : null}

        {subtitlesOpen && video.hasSubtitles ? (
          // §3.2, Phase 1 honesty: only a boolean and a count cross the wire, so this
          // expands to a labelled unavailable state rather than an invented language
          // list. Phase 2 replaces `subtitleLanguages: number` with a real
          // `Array<{code, name}>` from the host and this block goes away.
          <p class="rounded-badge bg-raised px-2 py-1 text-caption text-text-muted">
            Choosing which subtitle tracks to save arrives with the native helper update — the helper reports how many
            languages exist, not which ones.
          </p>
        ) : null}

        {video.downloadable ? null : (
          // D17 (spec §1.6, acceptance criterion 13). This branch used to point the user
          // at a screen-recording control that was deleted in dad38be / f38e6fe / 8c5c698
          // and never existed in this UI. The literal phrase is deliberately absent from
          // this file so a grep for it fails. The actual next action is to hand the URL to
          // the browser, which is the one thing that can still fetch a stream the helper
          // will not take.
          <p class="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            <span>Qwin cannot fetch this stream directly.</span>
            {video.url ? (
              <button
                type="button"
                class="pressable inline-flex items-center gap-1 rounded-badge px-1.5 py-0.5 text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => window.open(video.url, "_blank", "noopener")}
              >
                <Icon name="arrow.up.doc" size={12} />
                Open the stream
              </button>
            ) : null}
          </p>
        )}
      </div>

      <div class="flex shrink-0 items-center">{action}</div>
    </li>
  );
}
