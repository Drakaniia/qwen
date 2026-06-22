import assert from "node:assert/strict";

import * as DownloadSync from "../../../src/shared/download_sync.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCompletedJob(overrides = {}) {
  return {
    id: overrides.id || `job_${Date.now()}_abc123`,
    url: overrides.url || "https://example.com/video.mp4",
    title: overrides.title || "Test Video",
    format: overrides.format || "MP4",
    status: overrides.status || "done",
    filepath: overrides.filepath || "C:\\Downloads\\video.mp4",
    totalSize: overrides.totalSize || "150.2 MB",
    createdAt: overrides.createdAt || Date.now() - 60000,
    updatedAt: overrides.updatedAt || Date.now(),
    ...overrides,
  };
}

// ─── Initial state ──────────────────────────────────────────────────────────

{
  const history = DownloadSync.getSyncedHistory();
  assert.ok(Array.isArray(history), "Initial history should be an empty array");
  assert.equal(history.length, 0, "Initial history should be empty");
}

{
  const info = DownloadSync.getSyncInfo();
  assert.equal(info.totalCount, 0, "Initial sync info count should be 0");
  assert.equal(info.isSyncing, false, "Initial sync info should not be syncing");
}

console.log("download sync initial state: passed");

// ─── Adding completed downloads ─────────────────────────────────────────────

{
  const job = makeCompletedJob({ id: "test_1", title: "My Video", url: "https://example.com/video1.mp4", status: "done" });
  const added = DownloadSync.addSyncedDownload(job);
  assert.equal(added, true, "addSyncedDownload should return true for a completed job");

  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 1, "History should contain 1 entry after adding");
  assert.equal(history[0].id, "test_1", "Entry should have correct id");
  assert.equal(history[0].title, "My Video", "Entry should have correct title");
  assert.equal(history[0].sourceHost, "example.com", "Entry should have extracted sourceHost");
  assert.equal(history[0].status, "done", "Entry should preserve status");
  assert.ok(typeof history[0].completedAt === "number", "Entry should have completedAt timestamp");
}

{
  // Error status should also be synced
  const errorJob = makeCompletedJob({ id: "test_2", title: "Failed Video", status: "error", error: "Network error" });
  const added = DownloadSync.addSyncedDownload(errorJob);
  assert.equal(added, true, "addSyncedDownload should return true for error-status job");

  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 2, "History should contain 2 entries");
  const errorEntry = history.find((e) => e.id === "test_2");
  assert.ok(errorEntry, "Error entry should exist");
  assert.equal(errorEntry.status, "error", "Error entry should preserve error status");
}

{
  // Canceled status should also be synced
  const canceledJob = makeCompletedJob({ id: "test_3", status: "canceled" });
  DownloadSync.addSyncedDownload(canceledJob);

  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 3, "History should contain 3 entries");
  const canceledEntry = history.find((e) => e.id === "test_3");
  assert.ok(canceledEntry, "Canceled entry should exist");
  assert.equal(canceledEntry.status, "canceled", "Canceled entry should preserve status");
}

console.log("download sync add completed: passed");

// ─── Filtering in-progress downloads (should NOT sync) ──────────────────────

{
  // Active downloads should NOT be synced
  const activeJob = makeCompletedJob({ id: "active_1", status: "running" });
  const added = DownloadSync.addSyncedDownload(activeJob);
  assert.equal(added, false, "addSyncedDownload should return false for active job");

  const history = DownloadSync.getSyncedHistory();
  const activeEntry = history.find((e) => e.id === "active_1");
  assert.equal(activeEntry, undefined, "Active job should NOT appear in synced history");
}

{
  const queuedJob = makeCompletedJob({ id: "active_2", status: "queued" });
  const added = DownloadSync.addSyncedDownload(queuedJob);
  assert.equal(added, false, "addSyncedDownload should return false for queued job");
}

{
  const pausedJob = makeCompletedJob({ id: "active_3", status: "paused" });
  const added = DownloadSync.addSyncedDownload(pausedJob);
  assert.equal(added, false, "addSyncedDownload should return false for paused job");
}

console.log("download sync filters active: passed");

// ─── Deduplication ──────────────────────────────────────────────────────────

{
  // Adding the same job id again should update the existing entry
  const first = makeCompletedJob({
    id: "dedup_1",
    title: "Original Title",
    url: "https://example.com/dup.mp4",
    status: "done",
    filepath: "C:\\old\\path.mp4",
  });
  DownloadSync.addSyncedDownload(first);

  const updated = makeCompletedJob({
    id: "dedup_1",
    title: "Updated Title",
    url: "https://example.com/dup.mp4",
    status: "done",
    filepath: "C:\\new\\path.mp4",
    totalSize: "200 MB",
  });
  DownloadSync.addSyncedDownload(updated);

  const history = DownloadSync.getSyncedHistory();
  const dupEntries = history.filter((e) => e.id === "dedup_1");
  assert.equal(dupEntries.length, 1, "Deduplicated id should produce only 1 entry");
  assert.equal(dupEntries[0].title, "Updated Title", "Deduplicated entry should have updated title");
  assert.equal(dupEntries[0].filepath, "C:\\new\\path.mp4", "Deduplicated entry should have updated filepath");
  assert.equal(dupEntries[0].totalSize, "200 MB", "Deduplicated entry should have updated totalSize");
}

console.log("download sync deduplication: passed");

// ─── Max entries limit ──────────────────────────────────────────────────────

{
  // Add many entries to test the limit
  for (let i = 0; i < 250; i++) {
    DownloadSync.addSyncedDownload(
      makeCompletedJob({
        id: `limit_test_${i}`,
        url: `https://example.com/video_${i}.mp4`,
        title: `Video ${i}`,
        status: "done",
      }),
    );
  }

  const history = DownloadSync.getSyncedHistory();
  assert.ok(history.length <= 200, `History should be limited to 200 entries (got ${history.length})`);

  // The most recent entries should be kept
  const lastEntry = history[history.length - 1];
  assert.ok(
    lastEntry.id.startsWith("limit_test_"),
    "Last entry should be from the batch (newest entries preferred)",
  );
}

console.log("download sync max entries: passed");

// ─── Entry shape validation ─────────────────────────────────────────────────

{
  // Add a minimal valid entry
  DownloadSync.addSyncedDownload(
    makeCompletedJob({ id: "shape_test_1", url: "https://example.com/shape.mp4", title: "Shape Test", status: "done" }),
  );

  const history = DownloadSync.getSyncedHistory();
  const entry = history.find((e) => e.id === "shape_test_1");
  assert.ok(entry, "Shape test entry should exist");

  // Required fields
  assert.equal(typeof entry.id, "string", "Entry should have string id");
  assert.equal(typeof entry.url, "string", "Entry should have string url");
  assert.equal(typeof entry.title, "string", "Entry should have string title");
  assert.equal(typeof entry.sourceHost, "string", "Entry should have string sourceHost");
  assert.equal(typeof entry.status, "string", "Entry should have string status");
  assert.equal(typeof entry.createdAt, "number", "Entry should have number createdAt");
  assert.equal(typeof entry.completedAt, "number", "Entry should have number completedAt");

  // Optional fields may be present
  if (entry.format) assert.equal(typeof entry.format, "string");
  if (entry.filepath) assert.equal(typeof entry.filepath, "string");
  if (entry.totalSize) assert.equal(typeof entry.totalSize, "string");
}

console.log("download sync entry shape: passed");

// ─── sourceHost extraction ──────────────────────────────────────────────────

{
  const withUrl = makeCompletedJob({
    id: "host_test_1",
    url: "https://www.youtube.com/watch?v=abc123",
    title: "YouTube Video",
    status: "done",
  });
  DownloadSync.addSyncedDownload(withUrl);

  const history = DownloadSync.getSyncedHistory();
  const entry = history.find((e) => e.id === "host_test_1");
  assert.equal(entry.sourceHost, "www.youtube.com", "sourceHost should be extracted from URL");
}

{
  const noUrlJob = makeCompletedJob({ id: "host_test_2", url: "", title: "No URL", status: "done" });
  DownloadSync.addSyncedDownload(noUrlJob);

  const history = DownloadSync.getSyncedHistory();
  const entry = history.find((e) => e.id === "host_test_2");
  assert.equal(entry.sourceHost, "", "sourceHost should be empty for empty URL");
}

console.log("download sync sourceHost extraction: passed");

// ─── Clear history ──────────────────────────────────────────────────────────

{
  DownloadSync.clearSyncedHistory();
  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 0, "After clear, history should be empty");

  const info = DownloadSync.getSyncInfo();
  assert.equal(info.totalCount, 0, "After clear, sync info count should be 0");
}

console.log("download sync clear: passed");

// ─── Persistence (in-memory state between calls) ────────────────────────────

{
  // State should be maintained across calls within the same session
  const job1 = makeCompletedJob({ id: "persist_1", title: "Persist 1", status: "done" });
  const job2 = makeCompletedJob({ id: "persist_2", title: "Persist 2", status: "done" });

  DownloadSync.addSyncedDownload(job1);
  DownloadSync.addSyncedDownload(job2);

  const info = DownloadSync.getSyncInfo();
  assert.equal(info.totalCount, 2, "Sync info should reflect the correct count");

  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 2, "History should have 2 entries");
}

console.log("download sync in-memory persistence: passed");

// ─── loadSyncHistory and persistSyncHistory round-trip ──────────────────────

{
  // Simulate loading stored data (as would happen from storage.sync)
  const storedData = JSON.stringify([
    { id: "roundtrip_1", url: "https://a.com/1.mp4", title: "A", sourceHost: "a.com", status: "done", createdAt: 1000, completedAt: 1001 },
    { id: "roundtrip_2", url: "https://b.com/2.mp4", title: "B", sourceHost: "b.com", status: "error", createdAt: 2000, completedAt: 2001 },
  ]);

  DownloadSync.loadSyncHistory(storedData);
  const history = DownloadSync.getSyncedHistory();
  assert.equal(history.length, 2, "After loadSyncHistory, should have 2 entries");
  // Entries are sorted by completedAt descending (newest first)
  assert.equal(history[0].id, "roundtrip_2", "First entry should be newest (roundtrip_2, completedAt 2001)");
  assert.equal(history[1].id, "roundtrip_1", "Second entry should be older (roundtrip_1, completedAt 1001)");

  // persistSyncHistory should return valid JSON
  const json = DownloadSync.persistSyncHistory();
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed), "persistSyncHistory should return valid JSON array");
  assert.equal(parsed.length, 2, "Persisted JSON should have 2 entries");
  // Order should be preserved (newest first)
  assert.equal(parsed[0].id, "roundtrip_2", "Persisted JSON first entry should be newest");
}

console.log("download sync round-trip: passed");

// ─── Merge external data (simulating another browser instance) ──────────────

{
  // Local state already has entries from the previous test
  // Now simulate syncing from another instance with different entries
  const externalData = JSON.stringify([
    { id: "external_1", url: "https://c.com/1.mp4", title: "External C", sourceHost: "c.com", status: "done", createdAt: 1500, completedAt: 1501 },
    { id: "external_2", url: "https://d.com/2.mp4", title: "External D", sourceHost: "d.com", status: "done", createdAt: 2500, completedAt: 2501 },
  ]);

  DownloadSync.mergeSyncedHistory(externalData);

  const history = DownloadSync.getSyncedHistory();
  // Should have merged entries: 2 original + 2 new = 4
  assert.equal(history.length, 4, "After merge, history should have 4 entries");

  // Dedup by id: if external has same id as local, external wins
  const externalData2 = JSON.stringify([
    { id: "roundtrip_1", url: "https://a.com/OVERWRITTEN.mp4", title: "Overwritten", sourceHost: "a.com", status: "done", createdAt: 1000, completedAt: 9999 },
  ]);

  DownloadSync.mergeSyncedHistory(externalData2);
  const afterMerge = DownloadSync.getSyncedHistory();
  const overwritten = afterMerge.find((e) => e.id === "roundtrip_1");
  assert.equal(overwritten.title, "Overwritten", "External merge should overwrite local entries with same id");
  assert.equal(overwritten.completedAt, 9999, "External merge should overwrite fields");
}

console.log("download sync merge: passed");

// ─── Enable/disable sync ────────────────────────────────────────────────────

{
  // Default should be enabled
  assert.equal(DownloadSync.isSyncEnabled(), true, "Sync should be enabled by default");

  DownloadSync.setSyncEnabled(false);
  assert.equal(DownloadSync.isSyncEnabled(), false, "setSyncEnabled(false) should disable sync");

  // Adding downloads while disabled should not sync
  const disabledJob = makeCompletedJob({ id: "disabled_1", title: "Disabled", status: "done" });
  const added = DownloadSync.addSyncedDownload(disabledJob);
  assert.equal(added, false, "addSyncedDownload should return false when sync is disabled");
  const afterDisabled = DownloadSync.getSyncedHistory().find((e) => e.id === "disabled_1");
  assert.equal(afterDisabled, undefined, "Entry should NOT be added when sync is disabled");

  // Re-enable
  DownloadSync.setSyncEnabled(true);
  assert.equal(DownloadSync.isSyncEnabled(), true, "After re-enable, sync should be enabled");

  const reEnabledJob = makeCompletedJob({ id: "reenabled_1", title: "Re-enabled", status: "done" });
  DownloadSync.addSyncedDownload(reEnabledJob);
  const afterReEnable = DownloadSync.getSyncedHistory().find((e) => e.id === "reenabled_1");
  assert.ok(afterReEnable, "Entry should be added after re-enabling sync");
}

console.log("download sync enable/disable: passed");

console.log("ALL DOWNLOAD SYNC TESTS PASSED");
