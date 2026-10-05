import { describe, expect, it } from "vitest";

import {
  formatBitrateValue,
  formatFormatValue,
  formatQualityValue,
  formatSizeValue,
  formatSourceValue,
} from "../../../src/shared/quality_format.js";

describe("formatQualityValue", () => {
  it.each([
    [{ height: 1080 }, "1080p"],
    [{ height: 1080, width: 1920 }, "1080p"],
    [{ width: 1920 }, "1920w"],
    [{ label: "Best" }, "Best"],
    [{ note: "auto" }, "auto"],
    [{ id: "fmt-1" }, "fmt-1"],
    [{ label: "L", note: "N", id: "I" }, "L"],
    [{}, "Best"],
  ])("formatQualityValue(%j) === %j", (format, expected) => {
    expect(formatQualityValue(format)).toBe(expected);
  });
});

describe("formatSizeValue", () => {
  it("prefers an explicit size string", () => {
    expect(formatSizeValue({ size: "10 MB" })).toBe("10 MB");
  });

  it("falls back to Unknown", () => {
    expect(formatSizeValue({})).toBe("Unknown");
  });

  it("delegates to videoFilters.displayVideoSize when provided", () => {
    const filters = { displayVideoSize: () => "4.8 MB" };
    expect(formatSizeValue({ size: "10 MB" }, filters)).toBe("4.8 MB");
  });

  it("falls back to Unknown when the delegate returns empty", () => {
    const filters = { displayVideoSize: () => "" };
    expect(formatSizeValue({ size: "10 MB" }, filters)).toBe("Unknown");
  });

  it("ignores a filters object without displayVideoSize", () => {
    expect(formatSizeValue({ size: "10 MB" }, {})).toBe("10 MB");
  });
});

describe("formatFormatValue", () => {
  it.each([
    [{ ext: "mp4" }, "MP4"],
    [{ format: "webm" }, "WEBM"],
    [{ ext: "mp4", format: "webm" }, "MP4"],
    [{ optionType: "native-format" }, "MP4"],
    [{}, "VIDEO"],
    [{ optionType: "detected" }, "VIDEO"],
  ])("formatFormatValue(%j) === %j", (format, expected) => {
    expect(formatFormatValue(format)).toBe(expected);
  });
});

describe("formatBitrateValue", () => {
  it.each([
    [{ bitrate: 1500 }, "1500 kbps"],
    [{ tbr: 2500.6 }, "2501 kbps"],
    [{ bitrate: 0 }, "Unknown"],
    [{ bitrate: -5 }, "Unknown"],
    [{ bitrate: "abc" }, "Unknown"],
    [{}, "Unknown"],
  ])("formatBitrateValue(%j) === %j", (format, expected) => {
    expect(formatBitrateValue(format)).toBe(expected);
  });
});

describe("formatSourceValue", () => {
  it.each([
    [{ source: "yt-dlp" }, "yt-dlp"],
    [{ source: "detected" }, "detected"],
    [{ optionType: "native-format" }, "yt-dlp"],
    [{}, "detected"],
    [{ optionType: "detected" }, "detected"],
  ])("formatSourceValue(%j) === %j", (format, expected) => {
    expect(formatSourceValue(format)).toBe(expected);
  });
});
