import { describe, expect, it } from "vitest";

import {
  ACTIVE_DOWNLOAD_STATUSES,
  clampDownloadPercent,
  isActiveDownload,
} from "../../../src/shared/download_statuses.js";

describe("ACTIVE_DOWNLOAD_STATUSES", () => {
  it("covers exactly the six non-terminal statuses", () => {
    expect([...ACTIVE_DOWNLOAD_STATUSES].sort()).toEqual([
      "canceling",
      "connecting",
      "paused",
      "pausing",
      "queued",
      "running",
    ]);
  });
});

describe("isActiveDownload", () => {
  it.each(["queued", "connecting", "running", "paused", "pausing", "canceling"])("treats %j as active", (status) => {
    expect(isActiveDownload({ status })).toBe(true);
  });

  it.each(["done", "error", "canceled", "cancelled", ""])("treats %j as terminal", (status) => {
    expect(isActiveDownload({ status })).toBe(false);
  });

  it("defaults a missing status to queued, matching every previous call site", () => {
    expect(isActiveDownload({})).toBe(true);
    expect(isActiveDownload({ status: undefined })).toBe(true);
  });

  it.each([null, undefined])("tolerates a missing job (%j)", (job) => {
    expect(isActiveDownload(job)).toBe(true);
  });
});

describe("clampDownloadPercent", () => {
  it.each([
    [0, 0],
    [42.5, 42.5],
    [100, 100],
    [-20, 0],
    [140, 100],
    ["55", 55],
  ])("clampDownloadPercent(%j) === %j", (value, expected) => {
    expect(clampDownloadPercent(value)).toBe(expected);
  });

  it("propagates NaN for non-numeric input, as both previous copies did", () => {
    expect(clampDownloadPercent("abc")).toBeNaN();
    expect(clampDownloadPercent(undefined)).toBeNaN();
  });
});
