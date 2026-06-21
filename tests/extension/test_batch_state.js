import assert from "node:assert/strict";

import * as BatchState from "../../src/shared/batch_state.js";

// ─── Initial state ──────────────────────────────────────────────────────────

assert.equal(
  BatchState.isBatchActive(),
  false,
  "Initially no batch should be active",
);

assert.equal(
  BatchState.getBatchProgress(),
  0,
  "Initial batch progress should be 0",
);

const batch = BatchState.getBatchInfo();
assert.equal(batch.totalItems, 0, "Initial batch should have 0 items");
assert.equal(batch.completedItems, 0, "Initial batch should have 0 completed items");
assert.equal(batch.currentIndex, -1, "Initial batch currentIndex should be -1");
assert.equal(batch.isActive, false, "Initial batch isActive should be false");
assert.equal(batch.status, "idle", "Initial batch status should be 'idle'");

// ─── Creating a batch ───────────────────────────────────────────────────────

const videos = [
  {
    id: "v1",
    url: "https://example.com/video1.mp4",
    title: "Video 1",
    format: "MP4",
    sizeBytes: 50_000_000,
  },
  {
    id: "v2",
    url: "https://example.com/video2.mp4",
    title: "Video 2",
    format: "MP4",
    sizeBytes: 100_000_000,
  },
  {
    id: "v3",
    url: "https://example.com/video3.mp4",
    title: "Video 3",
    format: "MP4",
    sizeBytes: 75_000_000,
  },
];

BatchState.createBatch(videos);

assert.equal(BatchState.isBatchActive(), true, "After createBatch, batch should be active");
assert.equal(BatchState.getBatchProgress(), 0, "After createBatch, progress should be 0");

const batchInfo = BatchState.getBatchInfo();
assert.equal(batchInfo.totalItems, 3, "Batch should have 3 items");
assert.equal(batchInfo.completedItems, 0, "Batch should have 0 completed items");
assert.equal(batchInfo.currentIndex, 0, "Batch currentIndex should be 0 (first item)");
assert.equal(batchInfo.status, "idle", "Batch status should be 'idle'");
assert.equal(batchInfo.currentItem.id, "v1", "Current item should be the first video");
assert.equal(batchInfo.currentItem.title, "Video 1", "Current item title should be 'Video 1'");
assert.equal(batchInfo.label, "1/3", "Batch label should be '1/3'");

// ─── Progress tracking ──────────────────────────────────────────────────────

BatchState.markItemComplete("v1");

assert.equal(BatchState.getBatchProgress(), 33, "After 1/3 complete, progress should be ~33");

const afterFirst = BatchState.getBatchInfo();
assert.equal(afterFirst.completedItems, 1, "1 item should be completed");
assert.equal(afterFirst.currentIndex, 1, "Current index should move to 1");
assert.equal(afterFirst.currentItem.id, "v2", "Current item should be the second video");
assert.equal(afterFirst.label, "2/3", "Batch label should be '2/3'");

BatchState.markItemComplete("v2");

assert.equal(BatchState.getBatchProgress(), 67, "After 2/3 complete, progress should be ~67");

const afterSecond = BatchState.getBatchInfo();
assert.equal(afterSecond.completedItems, 2, "2 items should be completed");
assert.equal(afterSecond.currentIndex, 2, "Current index should move to 2");
assert.equal(afterSecond.currentItem.id, "v3", "Current item should be the third video");

BatchState.markItemComplete("v3");

assert.equal(BatchState.getBatchProgress(), 100, "After all complete, progress should be 100");

const afterAll = BatchState.getBatchInfo();
assert.equal(afterAll.completedItems, 3, "All items should be completed");
assert.equal(afterAll.currentIndex, -1, "After all done, currentIndex should be -1");
assert.equal(afterAll.currentItem, null, "After all done, currentItem should be null");
assert.equal(afterAll.status, "completed", "Batch status should be 'completed'");
assert.equal(afterAll.isActive, false, "Batch should no longer be active");

// ─── Resetting ──────────────────────────────────────────────────────────────

BatchState.resetBatch();

assert.equal(BatchState.isBatchActive(), false, "After reset, batch should not be active");
assert.equal(BatchState.getBatchProgress(), 0, "After reset, progress should be 0");

const resetInfo = BatchState.getBatchInfo();
assert.equal(resetInfo.totalItems, 0, "After reset, totalItems should be 0");
assert.equal(resetInfo.status, "idle", "After reset, status should be 'idle'");

// ─── Status transitions ─────────────────────────────────────────────────────

BatchState.createBatch(videos);

assert.equal(
  BatchState.getBatchInfo().status,
  "idle",
  "After create, status should be 'idle'",
);

BatchState.startBatch();
assert.equal(
  BatchState.getBatchInfo().status,
  "running",
  "After startBatch, status should be 'running'",
);

BatchState.pauseBatch();
assert.equal(
  BatchState.getBatchInfo().status,
  "paused",
  "After pauseBatch, status should be 'paused'",
);

BatchState.resumeBatch();
assert.equal(
  BatchState.getBatchInfo().status,
  "running",
  "After resumeBatch, status should be 'running'",
);

BatchState.cancelBatch();
assert.equal(
  BatchState.getBatchInfo().status,
  "canceled",
  "After cancelBatch, status should be 'canceled'",
);
assert.equal(
  BatchState.getBatchProgress(),
  0,
  "After cancel, progress should reset to 0",
);

// ─── Error tracking ─────────────────────────────────────────────────────────

BatchState.createBatch(videos);
BatchState.startBatch();
BatchState.markItemError("v1", "Network error");

const withError = BatchState.getBatchInfo();
assert.equal(withError.completedItems, 0, "Failed item should NOT count as completed");
assert.equal(withError.currentIndex, 0, "Current index should NOT advance on error");
assert.equal(withError.status, "running", "Batch should continue running after one error");
assert.equal(withError.currentItem.id, "v1", "Current item should remain the failed item for retry");

// Check the failedItems list
assert.equal(withError.failedItems.length, 1, "There should be 1 failed item");
assert.equal(withError.failedItems[0].id, "v1", "Failed item should have id 'v1'");
assert.equal(withError.failedItems[0].error, "Network error", "Failed item should have error message");

// Mark as skipped (to move past it)
BatchState.skipItem("v1");
assert.equal(
  BatchState.getBatchInfo().currentIndex,
  1,
  "After skip, currentIndex should advance",
);

// ─── Item IDs list ──────────────────────────────────────────────────────────

BatchState.resetBatch();
BatchState.createBatch(videos);

const itemIds = BatchState.getItemIds();
assert.deepEqual(itemIds, ["v1", "v2", "v3"], "getItemIds should return all video IDs in order");

// ─── Progress callback ──────────────────────────────────────────────────────

BatchState.resetBatch();
BatchState.createBatch(videos);

let lastProgress = -1;
let lastInfo = null;

const unsubscribe = BatchState.onProgress((info) => {
  lastProgress = info.percent;
  lastInfo = info;
});

BatchState.markItemComplete("v1");
assert.equal(lastProgress, 33, "Progress callback should fire with 33%");
assert.equal(lastInfo.label, "2/3", "Progress callback should provide updated label");

BatchState.markItemComplete("v2");
assert.equal(lastProgress, 67, "Progress callback should fire with 67%");

// Unsubscribe should stop callbacks
unsubscribe();
BatchState.markItemComplete("v3");
assert.equal(lastProgress, 67, "After unsubscribe, callback should NOT fire (still 67)");

// ─── Multiple batches (reset and recreate) ──────────────────────────────────

BatchState.resetBatch();
const newVideos = [
  { id: "n1", url: "https://example.com/new1.mp4", title: "New 1" },
  { id: "n2", url: "https://example.com/new2.mp4", title: "New 2" },
];

BatchState.createBatch(newVideos);
const newInfo = BatchState.getBatchInfo();
assert.equal(newInfo.totalItems, 2, "New batch should have 2 items");
assert.equal(newInfo.currentItem.id, "n1", "New batch should start at first item");

console.log("batch state tests passed");
