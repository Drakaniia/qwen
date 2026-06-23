import assert from "node:assert/strict";

import * as qualityFormat from "../../src/shared/quality_format.js";
import * as videoFilters from "../../src/shared/video_filters.js";

assert.equal(qualityFormat.formatQualityValue({ height: 1080, label: "Fallback" }), "1080p");
assert.equal(qualityFormat.formatQualityValue({ width: 1920 }), "1920w");
assert.equal(qualityFormat.formatQualityValue({ label: "Best MP4" }), "Best MP4");
assert.equal(qualityFormat.formatQualityValue({ id: "best" }), "best");

assert.equal(qualityFormat.formatSizeValue({ sizeBytes: 98_000_000 }, videoFilters), "93.5 MB");
assert.equal(qualityFormat.formatSizeValue({ size: "1.4 GB" }, videoFilters), "1.4 GB");
assert.equal(qualityFormat.formatSizeValue({}, videoFilters), "Unknown");

assert.equal(qualityFormat.formatFormatValue({ ext: "mp4" }), "MP4");
assert.equal(qualityFormat.formatFormatValue({ optionType: "native-format" }), "MP4");
assert.equal(qualityFormat.formatFormatValue({}), "VIDEO");

assert.equal(qualityFormat.formatBitrateValue({ bitrate: 2500 }), "2500 kbps");
assert.equal(qualityFormat.formatBitrateValue({ tbr: 1200.4 }), "1200 kbps");
assert.equal(qualityFormat.formatBitrateValue({}), "Unknown");

assert.equal(qualityFormat.formatSourceValue({ source: "detected" }), "detected");
assert.equal(qualityFormat.formatSourceValue({ optionType: "native-format" }), "yt-dlp");
assert.equal(qualityFormat.formatSourceValue({}), "detected");

console.log("quality format tests passed");
