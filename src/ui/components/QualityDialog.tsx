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
 */
import * as qualityFormat from "../../shared/quality_format.js";
import * as videoFilters from "../../shared/video_filters.js";
import { displayFormat, sourceLabel, videoSizeLabel, videoTitle } from "../format.js";

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
  emptyText?: string;
  videos?: VideoLike[];
  formats?: FormatLike[];
  onBack: () => void;
  onCancel: () => void;
  onSelectVideo(_video: VideoLike): void;
  onSelectFormat(_format: FormatLike): void;
}

interface VideoListProps {
  videos: VideoLike[];
  emptyText: string;
  onSelectVideo(_video: VideoLike): void;
}

interface FormatTableProps {
  formats: FormatLike[];
  onSelectFormat(_format: FormatLike): void;
}

const QUALITY_COLUMNS = ["Quality", "Size", "Format", "Bitrate", "Source"];

const DEFAULT_FORMATS: FormatLike[] = [{ formatId: "best", label: "Best available MP4" }];

function formatKey(format: FormatLike, index: number) {
  return `${format.formatId || format.id || "best"}|${format.variantId || ""}|${format.backend || "auto"}|${index}`;
}

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

function FormatTable({ formats, onSelectFormat }: FormatTableProps) {
  const rows = formats.length ? formats : DEFAULT_FORMATS;

  return (
    <div class="quality-table">
      {/* The visible header row is decorative for AT: every option button carries
          the same five values in the same order as its accessible name. */}
      <div class="quality-row quality-header" aria-hidden="true">
        {QUALITY_COLUMNS.map((column) => (
          <span key={column} class="quality-cell">
            {column}
          </span>
        ))}
      </div>
      {rows.map((format, index) => {
        const cells = [
          qualityFormat.formatQualityValue(format),
          formatSize(format, videoFilters),
          qualityFormat.formatFormatValue(format),
          qualityFormat.formatBitrateValue(format),
          qualityFormat.formatSourceValue(format),
        ];
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
                key={QUALITY_COLUMNS[cellIndex]}
                class={cellIndex === 0 ? "quality-cell primary-cell" : "quality-cell"}
              >
                {cell}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}

export function QualityDialog(props: QualityDialogProps) {
  return (
    <div class="qwin-overlay" role="dialog" aria-modal="true" aria-label={props.title} hidden={!props.open}>
      <div class="qwin-overlay-card">
        <div class="qwin-overlay-header">
          {props.hasBack ? (
            <button type="button" class="qwin-overlay-back" onClick={props.onBack}>
              Back
            </button>
          ) : null}
          <h2 class="qwin-overlay-title">{props.title}</h2>
        </div>
        <div class="qwin-overlay-list">
          {props.view === "loading" ? (
            <div class="quality-loading" id="qwin-quality-loading-status">
              {props.statusText}
            </div>
          ) : null}
          {props.view === "videos" ? (
            <VideoList
              videos={props.videos || []}
              emptyText={props.emptyText || "No downloadable video detected yet."}
              onSelectVideo={props.onSelectVideo}
            />
          ) : null}
          {props.view === "formats" ? (
            <FormatTable formats={props.formats || []} onSelectFormat={props.onSelectFormat} />
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
