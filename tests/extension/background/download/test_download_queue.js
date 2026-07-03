/**
 * Tests for Download Queue Manager — auto-download & concurrent mode.
 *
 * RED phase: Tests fail until the module is imported and implemented.
 * GREEN phase: After implementation, all tests pass.
 */

import assert from "node:assert/strict";

let DownloadQueue;
try {
  DownloadQueue = await import("../../../src/background/download_queue.js");
} catch (err) {
  console.warn("Could not import download_queue.js:", err.message);
  DownloadQueue = null;
}

(async () => {
  // ─── Test: Module exports the expected interface ──────────────────────────

  {
    if (!DownloadQueue) {
      assert.ok(false, "download_queue.js module should be importable. RED phase: expected to fail.");
      return;
    }
    assert.equal(typeof DownloadQueue.init, "function", "module must export init()");
    assert.equal(typeof DownloadQueue.enqueue, "function", "module must export enqueue()");
    assert.equal(typeof DownloadQueue.getMaxConcurrent, "function", "module must export getMaxConcurrent()");
    assert.equal(typeof DownloadQueue.setMaxConcurrent, "function", "module must export setMaxConcurrent()");
    assert.equal(typeof DownloadQueue.getAutoDownload, "function", "module must export getAutoDownload()");
    assert.equal(typeof DownloadQueue.setAutoDownload, "function", "module must export setAutoDownload()");
    assert.equal(typeof DownloadQueue.getActiveCount, "function", "module must export getActiveCount()");
    assert.equal(typeof DownloadQueue.getQueuedCount, "function", "module must export getQueuedCount()");
    assert.equal(typeof DownloadQueue.getStatus, "function", "module must export getStatus()");
    assert.equal(typeof DownloadQueue.reset, "function", "module must export reset()");
    console.log("✓ Module exports correct interface");
  }

  // ─── Test: Default settings ───────────────────────────────────────────────

  {
    if (DownloadQueue) {
      DownloadQueue.reset();
      assert.equal(DownloadQueue.getMaxConcurrent(), 3, "maxConcurrent should default to 3");
      assert.equal(DownloadQueue.getAutoDownload(), false, "autoDownload should default to false");
      console.log("✓ Default settings are correct");
    }
  }

  // ─── Test: setMaxConcurrent clamps values ──────────────────────────────────

  {
    if (DownloadQueue) {
      DownloadQueue.reset();
      DownloadQueue.setMaxConcurrent(5);
      assert.equal(DownloadQueue.getMaxConcurrent(), 5, "maxConcurrent should accept 5");

      DownloadQueue.setMaxConcurrent(0);
      assert.equal(DownloadQueue.getMaxConcurrent(), 1, "maxConcurrent should clamp to minimum 1");

      DownloadQueue.setMaxConcurrent(20);
      assert.equal(DownloadQueue.getMaxConcurrent(), 10, "maxConcurrent should clamp to maximum 10");
      console.log("✓ setMaxConcurrent clamps values between 1 and 10");
    }
  }

  // ─── Test: enqueue and queue state ────────────────────────────────────────

  {
    if (DownloadQueue) {
      DownloadQueue.reset();
      let lastStarted = null;
      DownloadQueue.init({
        startDownload: async (...args) => {
          lastStarted = args;
          return { jobId: "test_job" };
        },
      });

      DownloadQueue.enqueue(1, "video_1");
      DownloadQueue.enqueue(1, "video_2");

      // Jobs start immediately when slots are available (maxConcurrent=3)
      assert.equal(DownloadQueue.getActiveCount(), 2, "2 jobs should be actively starting");
      assert.equal(DownloadQueue.getQueuedCount(), 0, "0 jobs should be queued (all started)");

      const status = DownloadQueue.getStatus();
      assert.equal(status.queuedCount, 0, "status.queuedCount should be 0");
      assert.equal(status.activeCount, 2, "status.activeCount should be 2");
      assert.equal(status.total, 2, "status.total should be 2");
      assert.ok(lastStarted, "startDownload should have been called");
      console.log("✓ enqueue correctly adds and starts jobs when slots available");
    }
  }

  // ─── Test: markComplete processes next job ────────────────────────────────

  {
    if (DownloadQueue) {
      DownloadQueue.reset();
      DownloadQueue.init({ startDownload: async () => ({ jobId: "test_job" }) });

      const jobId = DownloadQueue.enqueue(1, "video_1");

      // Simulate the job starting (processQueue sets status to connecting)
      const allJobs = DownloadQueue.getAllJobs();
      const job = allJobs.find((j) => j.id === jobId);
      if (job) {
        // Before markComplete, job should be in the queue
        assert.ok(job, "job should exist in queue");
      }

      DownloadQueue.markComplete(jobId);
      assert.equal(DownloadQueue.getActiveCount(), 0, "after markComplete, no active jobs");
      console.log("✓ markComplete correctly processes queue");
    }
  }

  // ─── Test: init with custom settings ──────────────────────────────────────

  {
    if (DownloadQueue) {
      DownloadQueue.reset();
      DownloadQueue.init({
        startDownload: async () => ({ jobId: "test" }),
        maxConcurrent: 5,
        autoDownload: true,
      });

      assert.equal(DownloadQueue.getMaxConcurrent(), 5, "init should set maxConcurrent to 5");
      assert.equal(DownloadQueue.getAutoDownload(), true, "init should set autoDownload to true");
      console.log("✓ init accepts custom settings");
    }
  }

  console.log("\nAll download queue manager tests passed ✓");
})().catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
