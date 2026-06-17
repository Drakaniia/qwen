"use strict";

function formatQualityValue(format) {
  if (format.height) {
    return `${format.height}p`;
  }
  if (format.width) {
    return `${format.width}w`;
  }
  return format.label || format.note || format.id || "Best";
}

function formatSizeValue(format, videoFilters = null) {
  if (videoFilters && typeof videoFilters.displayVideoSize === "function") {
    return videoFilters.displayVideoSize(format) || "Unknown";
  }
  return format.size || "Unknown";
}

function formatFormatValue(format) {
  const value = format.ext || format.format || "";
  if (value) {
    return String(value).toUpperCase();
  }
  return format.optionType === "native-format" ? "MP4" : "VIDEO";
}

function formatBitrateValue(format) {
  const bitrate = Number(format.bitrate || format.tbr || 0);
  if (!Number.isFinite(bitrate) || bitrate <= 0) {
    return "Unknown";
  }
  return `${Math.round(bitrate)} kbps`;
}

function formatSourceValue(format) {
  return format.source || (format.optionType === "native-format" ? "yt-dlp" : "detected");
}

export { formatBitrateValue, formatFormatValue, formatQualityValue, formatSizeValue, formatSourceValue };
