"use strict";

import assert from "node:assert/strict";

// ─── These imports will fail — the modules don't exist yet (RED phase) ──────
import * as PopupStateHelpers from "../../../src/popup/popup-state.js";

// ─── activeDownloadJobs ─────────────────────────────────────────────────────

{
  const jobs = [
    { id: "1", status: "running" },
    { id: "2", status: "done" },
    { id: "3", status: "queued" },
    { id: "4", status: "paused" },
    { id: "5", status: "error" },
  ];
  const active = PopupStateHelpers.activeDownloadJobs(jobs);
  assert.equal(active.length, 3, "activeDownloadJobs must return running, queued, and paused jobs");
  assert.equal(active[0].id, "1", "first active job must be running");
  assert.equal(active[1].id, "3", "second active job must be queued");
  assert.equal(active[2].id, "4", "third active job must be paused");
}

{
  const jobs = [
    { id: "1", status: "connecting" },
    { id: "2", status: "pausing" },
    { id: "3", status: "canceling" },
  ];
  const active = PopupStateHelpers.activeDownloadJobs(jobs);
  assert.equal(active.length, 3, "activeDownloadJobs must include connecting, pausing, canceling");
}

{
  const active = PopupStateHelpers.activeDownloadJobs([]);
  assert.equal(active.length, 0, "activeDownloadJobs must return empty array for empty input");
}

{
  const active = PopupStateHelpers.activeDownloadJobs(null);
  assert.ok(Array.isArray(active), "activeDownloadJobs must return array even for null input");
  assert.equal(active.length, 0, "activeDownloadJobs must return empty array for null input");
}

{
  // Jobs without explicit status should default to "queued"
  const jobs = [{ id: "1" }, { id: "2", status: "done" }];
  const active = PopupStateHelpers.activeDownloadJobs(jobs);
  assert.equal(active.length, 1, "activeDownloadJobs must treat undefined status as queued");
  assert.equal(active[0].id, "1", "job without status must be considered active");
}

// ─── isUnknownMessageTypeError ──────────────────────────────────────────────

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError({ error: "Unknown message type" }),
    true,
    "must detect 'Unknown message type' error",
  );
}

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError({ error: "unknown message type" }),
    true,
    "must be case-insensitive",
  );
}

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError({ error: "Something else" }),
    false,
    "must return false for other errors",
  );
}

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError(null),
    false,
    "must return false for null input",
  );
}

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError({}),
    false,
    "must return false for object without error property",
  );
}

{
  assert.equal(
    PopupStateHelpers.isUnknownMessageTypeError(undefined),
    false,
    "must return false for undefined input",
  );
}

console.log("popup-state helpers tests passed");
