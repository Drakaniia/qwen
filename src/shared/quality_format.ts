/**
 * Column formatters for the quality dialog's format table (spec §5 Phase 6).
 *
 * One function per column, all pure. The fields are read from three different
 * producers — the native helper's `formats` payload, DOM-derived candidates, and the
 * popup's variant records — so every field is optional and `string | number` where the
 * producers disagree.
 */

/** The union of the three record shapes the table can be handed. */
export interface QualityFormatLike {
  height?: number | string | null;
  width?: number | string | null;
  label?: string | null;
  note?: string | null;
  id?: string | null;
  formatId?: string | null;
  size?: string | null;
  ext?: string | null;
  format?: string | null;
  bitrate?: number | string | null;
  tbr?: number | string | null;
  source?: string | null;
  /** `"native-format"` marks a row that came from yt-dlp rather than from detection. */
  optionType?: string | null;
}

/** The "Quality" cell: `1080p`, else `1920w`, else the label, else "Best". */
function formatQualityValue(format: QualityFormatLike): string {
  if (format.height) {
    return `${format.height}p`;
  }
  if (format.width) {
    return `${format.width}w`;
  }
  return format.label || format.note || format.id || "Best";
}

/**
 * The "Size" cell.
 *
 * `videoFilters` is the module object, passed through by `QualityDialog.tsx`; when it
 * is absent (or has no `displayVideoSize`) the raw `size` string is all there is. It is
 * typed `unknown` because that is exactly what the caller has — the only thing read
 * off it is one function.
 */
function formatSizeValue(format: QualityFormatLike, videoFilters: unknown = null): string {
  const filters = videoFilters as { displayVideoSize?: (value: unknown) => string } | null | undefined;
  if (filters && typeof filters.displayVideoSize === "function") {
    return filters.displayVideoSize(format) || "Unknown";
  }
  return format.size || "Unknown";
}

/** The "Format" cell: the container extension, uppercased. */
function formatFormatValue(format: QualityFormatLike): string {
  const value = format.ext || format.format || "";
  if (value) {
    return String(value).toUpperCase();
  }
  return format.optionType === "native-format" ? "MP4" : "VIDEO";
}

/** The "Bitrate" cell, in kbps. */
function formatBitrateValue(format: QualityFormatLike): string {
  const bitrate = Number(format.bitrate || format.tbr || 0);
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    return "Unknown";
  }
  return `${Math.round(bitrate)} kbps`;
}

/** The "Source" cell: where the format came from, not where the video came from. */
function formatSourceValue(format: QualityFormatLike): string {
  return format.source || (format.optionType === "native-format" ? "yt-dlp" : "detected");
}

export { formatBitrateValue, formatFormatValue, formatQualityValue, formatSizeValue, formatSourceValue };
