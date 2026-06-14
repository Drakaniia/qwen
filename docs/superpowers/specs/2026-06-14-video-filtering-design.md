# Design Doc: Surgical Video Filtering Improvements

**Date:** 2026-06-14
**Topic:** Fixing missing video downloads for sites using blob URLs and range-based streaming (e.g., anime sites).

## 1. Problem Statement
The extension correctly identifies a video player and displays the "Download" overlay, but the video does not appear in the download list or the popup. This is caused by overly aggressive filtering in the shared logic:
1.  **Protocol Filtering:** `isHttpUrl` rejects `blob:` URLs, which are commonly used by modern video players.
2.  **Range Filtering:** `isBlockedMediaUrl` rejects any URL with a `range=` parameter, which blocks many legitimate chunked streams.
3.  **Strict Candidate Filtering:** `isLikelyFullLengthVideoCandidate` aggressively filters out videos based on keywords (like "clip") even when they are the main content in a `<video>` tag.
4.  **Fallback Gaps:** The "page-fallback" mechanism is sometimes bypassed or filtered when a "broken" (from the extension's perspective) source is detected.

## 2. Proposed Changes

### 2.1 Core Logic (`src/shared/media_candidates.js`)
-   **Update `isHttpUrl`**: Allow `blob:` protocol.
-   **Update `isBlockedMediaUrl`**: Remove the regex check for `range=`. Rely on existing segment extension checks (`.ts`, `.m4s`) to filter fragments.

### 2.2 Filtering Logic (`src/shared/video_filters.js`)
-   **Update `isLikelyFullLengthVideoCandidate`**:
    -   If `source` is `dom-video` or `dom-source`, skip the `hasShortOrIncompleteSignal` check (which uses keywords like "clip", "preview", etc.).
    -   Allow `duration: 0` if the source is from the DOM, as duration might not be available immediately.

### 2.3 Detection Reliability (`src/content/content.js` & `src/content/page_detection.js`)
-   Ensure that if `isLikelyRealPlayer(video)` is true, at least a `page-fallback` candidate is generated and published, even if the direct `src` is filtered.

## 3. Architecture & Data Flow
No changes to the overall architecture. The data flow remains:
`content.js` (Scan) -> `video_filters.js` (Filter) -> `background.js` (Collect/Store) -> `popup.js` (Display).

## 4. Testing Strategy (TDD)
1.  **Reproduction Test**: Create a test case in `tests/extension/test_video_filters.js` (or a new file) that fails with the current logic when provided with a blob URL or a range URL.
2.  **Fix Verification**: After implementing changes, verify that the new tests pass and no regressions are introduced in existing tests.
3.  **Integration Test**: Manually verify on target sites (like `khanime.co`) using a developer build.

## 5. Scope & Constraints
-   The fix is focused on the filtering logic.
-   Does not modify the native host or download orchestration.
-   Maintains existing ad-blocking and segment-filtering capabilities for other URL types.
