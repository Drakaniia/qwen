/**
 * Unified quality dialog (spec §5 Phase 6 / §3.5).
 *
 * There used to be two of these: the popup mounted the imperative
 * `shared/quality_dialog.js` into the shell declared in `popup.html`, and the
 * overlay hand-built a second, independent shell in `content_overlay.js` (different
 * element set, different options, its own request serial) on top of that same
 * imperative module. This is the single declarative component; a mount point is
 * just a container plus props.
 *
 * Styling is class-based only, and the classes are defined by whichever stylesheet
 * the mount point provides — inside the overlay's shadow root that is
 * `shared/qwin_overlay.css`. No inline-style branch exists (the previous one was
 * unreachable: both callers passed `style: "classes"`).
 *
 * The `videos` view is the overlay's alone (its "which video on this page?" step); the
 * popup always knows the video before it opens the dialog, so its mount passes neither
 * `videos` nor `onSelectVideo`.
 */
import { useEffect, useRef } from "preact/hooks";

import * as qualityFormat from "../../shared/quality_format.js";
import * as videoFilters from "../../shared/video_filters.js";
import { displayFormat, formatDuration, sourceLabel, videoSizeLabel, videoTitle } from "../format.js";

export type QualityDialogView = "loading" | "videos" | "formats";

export interface VideoLike {
  title?: string;
  url?: string;
  format?: string;
  source?: string;
  size?: string;
  variantCount?: number;
}

export interface FormatLike {
  formatId?: string;
  id?: string;
  variantId?: string;
  backend?: string;
  label?: string;
  sourceUrl?: string;
  /** yt-dlp's own classification where the background passed it through. */
  kind?: string;
  vcodec?: string;
  acodec?: string;
  /** Audio bitrate in kbps. */
  abr?: number | string | null;
  ext?: string;
  height?: number | string | null;
  resolution?: string;
}

// `quality_format.js` types its second parameter from the `= null` default, so the
// module object is not assignable without this one widening.
const formatSize = qualityFormat.formatSizeValue as (_format: FormatLike, _filters: unknown) => string;

export interface QualityDialogProps {
  open: boolean;
  view: QualityDialogView;
  title: string;
  hasBack?: boolean;
  statusText?: string;
  nativeError?: string;
  /**
   * Why there are no formats, in one sentence. Replaces the table when `formats` is
   * empty — see {@link FormatTable}. Absent for the videos view.
   */
  unavailableReason?: string;
  /** The video's length in seconds, when the formats reply carried one. */
  duration?: number | null;
  emptyText?: string;
  videos?: VideoLike[];
  formats?: FormatLike[];
  onBack: () => void;
  onCancel: () => void;
  onSelectVideo?(_video: VideoLike): void;
  onSelectFormat(_format: FormatLike): void;
}

interface VideoListProps {
  videos: VideoLike[];
  emptyText: string;
  onSelectVideo(_video: VideoLike): void;
}

interface FormatTableProps {
  formats: FormatLike[];
  unavailableReason?: string;
  onSelectFormat(_format: FormatLike): void;
}

/**
 * Shown when the video produced no formats and named no reason of its own.
 *
 * Every caller that can reach this state builds a specific sentence
 * (`background/format_helpers.ts:unavailableReasonFor`), so this is the floor, not the
 * expected text — the point is only that an empty table says *something* rather than
 * rendering an option the helper has already refused. It used to render exactly such an
 * option: a synthetic `Best available MP4` row that always failed on click.
 */
const NO_FORMATS_TEXT = "No downloadable versions were found for this video.";

/** What makes an element reachable by Tab inside the card. */
const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function formatKey(format: FormatLike, index: number) {
  return `${format.formatId || format.id || "best"}|${format.variantId || ""}|${format.backend || "auto"}|${index}`;
}

/**
 * Whether a format carries no picture. yt-dlp says so three ways depending on the
 * extractor — an explicit `kind`, `vcodec: "none"`, or audio fields with no frame size —
 * and a row that matches any of them belongs under "Audio only", where a "Quality: Best"
 * cell would otherwise sit among the 1080p rows looking like the best video.
 */
function isAudioOnly(format: FormatLike): boolean {
  if (format.kind === "audio" || format.vcodec === "none") {
    return true;
  }
  const hasAudioFields = Boolean(format.acodec && format.acodec !== "none") || Number(format.abr) > 0;
  const hasPicture = Boolean(Number(format.height) > 0 || (format.resolution && format.resolution !== "audio only"));
  return hasAudioFields && !hasPicture;
}

function audioBitrate(format: FormatLike): string {
  const abr = Number(format.abr);
  return Number.isFinite(abr) && abr > 0 ? `${Math.round(abr)} kbps` : qualityFormat.formatBitrateValue(format);
}

interface Group {
  label: string;
  columns: string[];
  cells(_format: FormatLike): string[];
}

/** Five cells per row in both groups, so both share `.quality-row`'s one grid. */
const VIDEO_GROUP: Group = {
  label: "Video",
  columns: ["Video", "Size", "Format", "Bitrate", "Source"],
  cells: (format) => [
    qualityFormat.formatQualityValue(format),
    formatSize(format, videoFilters),
    qualityFormat.formatFormatValue(format),
    qualityFormat.formatBitrateValue(format),
    qualityFormat.formatSourceValue(format),
  ],
};

const AUDIO_GROUP: Group = {
  label: "Audio only",
  columns: ["Audio only", "Size", "Codec", "Format", "Source"],
  cells: (format) => [
    audioBitrate(format),
    formatSize(format, videoFilters),
    format.acodec && format.acodec !== "none" ? format.acodec : "Unknown",
    qualityFormat.formatFormatValue(format),
    qualityFormat.formatSourceValue(format),
  ],
};

function VideoList({ videos, emptyText, onSelectVideo }: VideoListProps) {
  if (!videos.length) {
    return <div class="qwin-overlay-empty">{emptyText}</div>;
  }

  return (
    <>
      {videos.map((video, index) => {
        const size = videoSizeLabel(video);
        return (
          <button
            key={`${video.url || ""}|${index}`}
            type="button"
            class="video-item video-picker-item"
            title={video.url || videoTitle(video)}
            onClick={() => onSelectVideo(video)}
          >
            <div class="video-content">
              <div class="video-title">{videoTitle(video)}</div>
              <div class="meta">
                <span class="badge">{displayFormat(video)}</span>
                <span>{video.variantCount ? `${video.variantCount} versions` : sourceLabel(video)}</span>
                {size ? <span class="video-size">{size}</span> : null}
              </div>
            </div>
          </button>
        );
      })}
    </>
  );
}

function FormatGroup({
  group,
  rows,
  onSelectFormat,
}: {
  group: Group;
  rows: { format: FormatLike; index: number }[];
  onSelectFormat(_format: FormatLike): void;
}) {
  return (
    <section class="quality-table" aria-label={group.label}>
      {/* The visible header row is decorative for AT: the section is named by its
          label, and every option button carries the same five values in the same
          order as its accessible name. The first column header *is* the group name —
          a separate heading above an uppercase column row read as two headings. */}
      <div class="quality-row quality-header" aria-hidden="true">
        {group.columns.map((column) => (
          <span key={column} class="quality-cell">
            {column}
          </span>
        ))}
      </div>
      {rows.map(({ format, index }) => {
        const cells = group.cells(format);
        return (
          <button
            key={formatKey(format, index)}
            type="button"
            class="quality-row quality-option"
            aria-label={cells.join(", ")}
            title={format.sourceUrl || format.label || ""}
            onClick={() => onSelectFormat(format)}
          >
            {cells.map((cell, cellIndex) => (
              <span
                key={group.columns[cellIndex]}
                class={cellIndex === 0 ? "quality-cell primary-cell" : "quality-cell"}
              >
                {cell}
              </span>
            ))}
          </button>
        );
      })}
    </section>
  );
}

function FormatTable({ formats, unavailableReason, onSelectFormat }: FormatTableProps) {
  if (!formats.length) {
    return <div class="qwin-overlay-empty">{unavailableReason || NO_FORMATS_TEXT}</div>;
  }

  const indexed = formats.map((format, index) => ({ format, index }));
  const video = indexed.filter(({ format }) => !isAudioOnly(format));
  const audio = indexed.filter(({ format }) => isAudioOnly(format));

  return (
    <>
      {video.length ? <FormatGroup group={VIDEO_GROUP} rows={video} onSelectFormat={onSelectFormat} /> : null}
      {audio.length ? <FormatGroup group={AUDIO_GROUP} rows={audio} onSelectFormat={onSelectFormat} /> : null}
    </>
  );
}

/**
 * Modal behaviour for `role="dialog" aria-modal="true"`, which used to be a promise the
 * markup made and nothing kept: focus moves in on open (to the first choice, else the
 * first control), Tab cycles inside the card, Escape cancels, and focus goes back to
 * whatever opened the dialog when it closes.
 *
 * Escape is a *capture*-phase document listener that stops propagation, which is the
 * contract `PopupFrame`'s and `useListKeys`' own Escape handlers are written against:
 * without the stop, the frame's bubble-phase handler would run after `onCancel` had
 * already flipped `open` to false and clear the selection behind a closing dialog.
 *
 * Focus is read through `getRootNode()` because the overlay renders this inside a shadow
 * root, where `document.activeElement` is only ever the shadow host.
 */
function useModalFocus(open: boolean, view: QualityDialogView, onCancel: () => void) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const root = card.getRootNode() as Document | ShadowRoot;
    const active = () => (root.activeElement || document.activeElement) as HTMLElement | null;
    const focusables = () => [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];

    if (!openerRef.current) {
      const opener = active();
      openerRef.current = opener && !card.contains(opener) ? opener : null;
    }
    // On open and on every view change (loading → formats): the button that had focus
    // in the loading view is usually the Cancel the user did not mean to land on.
    const first = card.querySelector<HTMLElement>(".quality-option, .video-item") || focusables()[0];
    first?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = focusables();
      if (!items.length) {
        return;
      }
      const current = active();
      const index = current ? items.indexOf(current) : -1;
      const last = items.length - 1;
      // Wrap at either end; from outside the card, enter at the end Tab is moving toward.
      const wrapTo =
        index === -1
          ? event.shiftKey
            ? last
            : 0
          : event.shiftKey && index === 0
            ? last
            : index === last && !event.shiftKey
              ? 0
              : null;
      if (wrapTo !== null) {
        event.preventDefault();
        items[wrapTo].focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, view]);

  // Restore on close, as its own effect: the one above also re-runs on a view change,
  // and returning focus to the opener between "loading" and "formats" would be wrong.
  useEffect(() => {
    if (open) {
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) {
      opener.focus();
    }
  }, [open]);

  return cardRef;
}

export function QualityDialog(props: QualityDialogProps) {
  const cardRef = useModalFocus(props.open, props.view, props.onCancel);
  const duration = props.duration ? formatDuration(props.duration) : "";

  return (
    <div class="qwin-overlay" role="dialog" aria-modal="true" aria-label={props.title} hidden={!props.open}>
      <div class="qwin-overlay-card" ref={cardRef}>
        <div class="qwin-overlay-header">
          {props.hasBack ? (
            <button type="button" class="qwin-overlay-back" onClick={props.onBack}>
              Back
            </button>
          ) : null}
          <h2 class="qwin-overlay-title">{props.title}</h2>
          {duration ? (
            <span class="quality-cell" aria-label={`Duration ${duration}`}>
              {duration}
            </span>
          ) : null}
        </div>
        <div class="qwin-overlay-list">
          {props.view === "loading" ? (
            <div class="quality-loading" id="qwin-quality-loading-status">
              {props.statusText}
            </div>
          ) : null}
          {props.view === "videos" && props.onSelectVideo ? (
            <VideoList
              videos={props.videos || []}
              emptyText={props.emptyText || "No downloadable video detected yet."}
              onSelectVideo={props.onSelectVideo}
            />
          ) : null}
          {props.view === "formats" ? (
            <FormatTable
              formats={props.formats || []}
              unavailableReason={props.unavailableReason}
              onSelectFormat={props.onSelectFormat}
            />
          ) : null}
          {props.nativeError ? <div class="quality-note">{props.nativeError}</div> : null}
        </div>
        <button type="button" class="qwin-overlay-cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
