# Surgical Video Filtering Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix missing video downloads for sites using blob URLs and range-based streaming by relaxing overly restrictive filters in the shared logic and ensuring reliable fallbacks.

**Architecture:** We will surgically update `media_candidates.js` and `video_filters.js` to allow `blob:` protocols and remove generic `range=` parameter blocking. We will also update `video_filters.js` to trust videos coming directly from the DOM and ensure `page_detection.js` always generates a fallback candidate for real video players.

**Tech Stack:** JavaScript (Chrome/Firefox Extension API)

---

### Task 1: Setup Bug Reproduction Tests

**Files:**

- Create: `tests/extension/reproduce_filtering_bug.js`

- [ ] **Step 1: Write failing tests for blob and range URLs**

```javascript
const path = require("path");
const assert = require("assert");

globalThis.QwinMediaCandidates = require(path.resolve(__dirname, "../../src/shared/media_candidates.js"));
const videoFilters = require(path.resolve(__dirname, "../../src/shared/video_filters.js"));

console.log("Running Video Filtering Bug Reproduction Tests...");

try {
  // 1. Blob URL should be accepted as downloadable
  const blobUrl = "blob:https://example.com/uuid";
  assert.strictEqual(videoFilters.isDownloadableUrl(blobUrl, ""), true, "Blob URL should be downloadable");

  // 2. URL with range parameter should NOT be blocked
  const rangeUrl = "https://cdn.example.com/video.mp4?range=0-1000";
  assert.strictEqual(videoFilters.isBlockedVideoUrl(rangeUrl, ""), false, "Range URL should NOT be blocked");

  // 3. DOM-sourced video with "clip" in title should be accepted
  const domVideo = {
    url: "https://example.com/video.mp4",
    source: "dom-video",
    title: "Episode 1 Clip",
    duration: 1200,
    width: 1920,
    height: 1080,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(domVideo),
    true,
    "DOM video should bypass keyword filters",
  );

  // 4. DOM-sourced video with duration 0 should be accepted
  const domVideoNoDuration = {
    url: "https://example.com/video.mp4",
    source: "dom-video",
    duration: 0,
    width: 1920,
    height: 1080,
  };
  assert.strictEqual(
    videoFilters.isLikelyFullLengthVideoCandidate(domVideoNoDuration),
    true,
    "DOM video with duration 0 should be accepted",
  );

  console.log("Reproduction tests finished.");
} catch (error) {
  console.error("Test failed!");
  console.error(error);
  process.exit(1);
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node tests/extension/reproduce_filtering_bug.js`
Expected: FAIL on the first assertion (Blob URL).

- [ ] **Step 3: Commit initial test**

```bash
git add tests/extension/reproduce_filtering_bug.js
git commit -m "test: add reproduction case for video filtering bugs"
```

### Task 2: Update Media Candidates Logic

**Files:**

- Modify: `src/shared/media_candidates.js`

- [ ] **Step 1: Allow blob protocol in `isHttpUrl`**

```javascript
// Around line 34
function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "blob:";
  } catch (_error) {
    return false;
  }
}
```

- [ ] **Step 2: Remove range blocking in `isBlockedMediaUrl`**

```javascript
// Around line 147
if (
  SEGMENT_EXTENSION_RE.test(text) ||
  SEGMENT_NAME_RE.test(text) ||
  (FRAGMENTED_STREAM_CONTEXT_RE.test(text) && NUMBERED_MEDIA_FRAGMENT_RE.test(text))
  // REMOVE: || /[?&]range=\d+-\d+/i.test(text)
) {
  return true;
}
```

- [ ] **Step 3: Run reproduction tests**

Run: `node tests/extension/reproduce_filtering_bug.js`
Expected: FAIL on the third assertion (DOM video bypass).

- [ ] **Step 4: Commit changes**

```bash
git add src/shared/media_candidates.js
git commit -m "fix: allow blob protocol and remove generic range filtering"
```

### Task 3: Refine Video Filtering Candidate Logic

**Files:**

- Modify: `src/shared/video_filters.js`

- [ ] **Step 1: Trust DOM sources in `isLikelyFullLengthVideoCandidate`**

```javascript
// Around line 155
function isLikelyFullLengthVideoCandidate(details) {
  if (!details || typeof details !== "object") {
    return false;
  }

  if (!isDownloadableUrl(details.url || "", details.contentType || "")) {
    return false;
  }

  if (details.downloadable === false) {
    return false;
  }

  if (details.source === "manual-url") {
    return true;
  }

  const youtubePage = isYouTubeVideoPageUrl(details.url || "");
  const isDomSource = details.source === "dom-video" || details.source === "dom-source";

  if (!youtubePage && !isDomSource && hasShortOrIncompleteSignal(details)) {
    return false;
  }

  const duration = finiteNumber(details.duration);
  if (!youtubePage && !isDomSource && duration > 0 && duration < MIN_FULL_LENGTH_SECONDS) {
    return false;
  }

  if (details.source === "performance" && duration === 0) {
    return false;
  }

  const directSize = numericVideoSize(details);
  if (directSize > 0 && directSize < MIN_DIRECT_MEDIA_BYTES) {
    return false;
  }

  if (details.complete === false || details.partial === true) {
    return false;
  }

  return true;
}
```

- [ ] **Step 2: Run reproduction tests**

Run: `node tests/extension/reproduce_filtering_bug.js`
Expected: PASS

- [ ] **Step 3: Run all existing tests**

Run: `node tests/extension/test_video_filters.js` (or existing test runner)
Expected: PASS

- [ ] **Step 4: Commit changes**

```bash
git add src/shared/video_filters.js
git commit -m "fix: trust DOM-sourced videos and allow duration 0 for them"
```

### Task 4: Ensure Fallback Candidates in Page Detection

**Files:**

- Modify: `src/content/page_detection.js` (Verify existing behavior)

- [ ] **Step 1: Verify fallback reliability**

Confirm that `page_detection.js` and `content.js` correctly handle the case where a real player is detected. The logic should naturally follow from the improvements in Task 3.

- [ ] **Step 2: Commit (if any changes were needed)**

```bash
git add src/content/page_detection.js
git commit -m "refactor: ensure page fallback reliability"
```

### Task 5: Final Verification

- [ ] **Step 1: Run all tests one last time**

Run: `node tests/extension/reproduce_filtering_bug.js; node tests/extension/test_video_filters.js`
Expected: ALL PASS

- [ ] **Step 2: Manual Check (Simulated)**
      Verify that `blob:` URLs now pass `isDownloadableUrl` and range-based URLs are not blocked.

- [ ] **Step 3: Cleanup reproduction test file**

```bash
rm tests/extension/reproduce_filtering_bug.js
git add tests/extension/reproduce_filtering_bug.js
git commit -m "cleanup: remove reproduction test file"
```
