# Audit Report: Qwin Video Downloader

Generated: June 23, 2026

## Executive Summary

Qwin is a cross-browser video downloader extension (Chrome/Firefox/Yandex) with a Python native host and Go CDM companion. At **255 files** across **15 top-level directories**, it is a medium-sized project with healthy structure overall. However, **29 files exceed the 400-line threshold** (some massively), **naming conventions are mixed in the popup layer**, and **33 test files in one directory** are nearing the bloat threshold. The docs are well-organized, nesting depth is shallow (max 3), and there are no deep structural rot issues — the audit focuses on **splitting oversized files** and **naming consistency**.

| Metric | Threshold | Result | Severity |
|--------|-----------|--------|----------|
| Folder file count | >30 files/dir | `tests/extension/` — **33 files** | 🔴 Warning |
| File line count | >400 lines/file | **29 files** exceed threshold (top: 1,837) | 🔴 Warning |
| Nesting depth | >4 levels | Max **3 levels** | ✅ OK |
| Naming conventions | Mixed styles at same level | `src/popup/` mixes kebab-case & snake_case | 🟡 Warning |
| Orphaned/misplaced files | Mismatched purpose | `logs/Readme.md`, `.claude/` empty, `media_candidates.py` duplication | 🟢 Suggestion |
| Doc sprawl | >5 scattered `.md` files | **21 `.md` files** across 7 locations (well-organized though) | 🟢 Suggestion |
| Empty/dead directories | Empty dirs | `.claude/` — empty | 🟢 Suggestion |

---

## Severity Legend

- 🔴 **Blocker** — must fix
- 🟡 **Warning** — should fix
- 🟢 **Suggestion** — nice to improve

---

## Issues Found

### Phase 1: Quick Cleanup
_Low effort, safe changes._

- [x] **Remove empty `.claude/` directory** — empty directory at project root, removed.

- [x] **Relocate `logs/Readme.md` → `docs/guides/troubleshooting-log.md`** — troubleshooting guide moved to `docs/guides/` with proper naming.

- [x] **`__pycache__` already in `.gitignore`** — both `src/native-host/__pycache__` and `tests/native-host/__pycache__` are already ignored. Verified with `git check-ignore`.

---

### Phase 2: File Refactoring (Split Oversized Files)
_Medium effort — split the worst offenders. The threshold is **400 lines per file**._

**Before (oversized files flagged):**

```
29 files exceed 400 lines.
Top offenders:
  src/popup/popup.js             1,837 lines  — UI logic, DOM, event handlers, helpers
  src/popup/popup.css            1,702 lines  — all popup styles in one file
  src/background/background.js   1,405 lines  — service worker entry, orchestration
  go/main_test.go                1,301 lines  — comprehensive Go integration tests
  tests/native-host/test_host.py 1,208 lines  — exhaustive Python host tests
  benchmarks/speedtest.py        1,050 lines  — standalone speed test script
  ... and 23 more files >400 lines
```

#### Recommended splits:

- [x] **Split `src/popup/popup.js`** (1,837→~70 lines) — Extracted into:
  - `src/popup/popup-elements.js` — DOM element references, constants, qualityChooser
  - `src/popup/popup-helpers.js` — utility/helper functions (indicator, UI, transitions, batch)
  - `src/popup/popup-renderer.js` — DOM rendering (video list creation)
  - `src/popup/popup-events.js` — event listeners, message handler, PopupState subscription
  - `src/popup/popup.js` — thin bootstrap (imports modules, calls `init()`)
  - Also fixed: missing `playlistDetection` import in `updatePlaylistPrompt()`

- [x] **Split `src/popup/popup.css`** (1,702→~20 lines) — Extracted into:
  - `src/popup/popup-base.css` — CSS variables, reset, body, typography, layout containers
  - `src/popup/popup-components.css` — all component-specific styles (down from 1,702 lines)
  - `src/popup/popup-theme.css` — all `@keyframes` animations and `prefers-reduced-motion` media queries
  - `src/popup/popup.css` — entry point with `@import` directives (no HTML changes needed)

- [x] **Split `src/background/background.js`** (1,405→~1,300 lines) — Extracted helper-ping logic:
  - `src/background/background-helper-ping.js` — `cachedHelperStatus`, `refreshCachedHelperStatus`, `startHelperPing`, `pingNativeHost`
  - background.js imports from this module; init calls updated to pass `hostName` and `notifyPopup`

- [x] **Split `go/main_test.go`** (1,301 lines) — Split into 4 feature-grouped files:
  - `go/main_test.go` — IPC protocol tests (echo, status, version, unknown command, stop) + helpers
  - `go/cdp_relay_test.go` — CDP relay flow tests (success, missing tabId, error result)
  - `go/cdm_test.go` — CDM init, extract keys, license parsing tests
  - `go/decrypt_test.go` — decrypt segments, AES-128 CTR, MP4 box parser, assemble segments tests

- [x] **Split `tests/native-host/test_host.py`** (1,208 lines) — Split into 5 domain-grouped files:
  - `tests/native-host/test_host.py` — core host utility tests (imports, sanitize, validate, protocol, artifacts, folder, open path)
  - `tests/native-host/test_host_commands.py` — command building tests (yt-dlp, formats, n_m3u8dl_re, streamlink, tool resolution)
  - `tests/native-host/test_host_download.py` — DownloadTask tests (pause, resume, cancel, fallbacks, creation flags)
  - `tests/native-host/test_host_format_parsing.py` — format/media parsing tests (summarize_formats, extract_media_candidates)
  - `tests/native-host/test_host_progress.py` — progress line parsing tests (yt-dlp, aria2, carriage returns, destination)

- [ ] **Other files >400 lines (lower priority):**
  - `benchmarks/speedtest.py` (1,050) — standalone, can remain as-is
  - `tests/extension/test_background_hard_access_fallback.js` (980) — test file, lower priority
  - `src/shared/filter_list_loader.js` (808) — consider splitting if maintainability suffers
  - `src/native-host/capture_manager.py` (774) — consider splitting CDM capture vs. general capture
  - `src/shared/video_filters.js` (661) — contains URL classification + filtering, could split
  - `src/native-host/yt_dlp_command.py` (630) — build commands vs. parsing output
  - `src/content/content.js` (639) — content script; already importing from shared modules
  - `src/native-host/download_manager.py` (588) — large, consider splitting by backend type
  - `src/background/download_orchestration.js` (582)
  - `go/cdm.go` (566), `go/commands.go` (432), `go/decrypt.go` (417) — Go files just below threshold
  - `src/background/cdm_network_intercept.js` (536)
  - `src/background/recording.js` (450)
  - `src/popup/download_list.js` (447)
  - `src/content/page_detection.js` (443)

---

### Phase 3: Naming Convention Standardization
_Low effort, aesthetic consistency._

- [ ] **Standardize `src/popup/` naming** — Currently mixes kebab-case and snake_case:

  **Before:**
  ```
  src/popup/
  ├── download_list.js        (snake_case)
  ├── popup.js                (lowercase)
  ├── popup.css               (lowercase)
  ├── popup.html              (lowercase)
  ├── popup-state.js          (kebab-case)
  └── popup-ui.js             (kebab-case)
  ```

  **After (proposed — pick one convention):**
  If the project prefers **snake_case** (dominant in `src/background`, `src/shared`, `src/native-host`):
  ```
  src/popup/
  ├── download_list.js
  ├── popup.js
  ├── popup.css
  ├── popup.html
  ├── popup_state.js           ← from popup-state.js
  └── popup_ui.js              ← from popup-ui.js
  ```

  > **Note:** This requires updating imports in `popup.js` and any files referencing `popup-state` and `popup-ui`. Also note that `config/extension/manifest.*.json` manifest files reference these filenames.

---

### Phase 4: Structural Improvements
_Medium effort — address duplicated logic and slot issues._

- [x] **Reviewed `src/native-host/media_candidates.py` vs `src/shared/media_candidates.js`** — Findings:
  - Python is missing: `AUDIO_EXTENSION_RE`, `MUSIC_CDN_RE`, `AUDIO_ONLY_HOST_RE`, `ANTIBLOCK_RE`, `AD_STATIC_ASSET_RE`, `GIF_VIDEO_RE`, `EMBED_PLAYER_HOST_RE`, `STREAMING_PAGE_HOST_RE`, `CDN_HINT_RE`, `YOUTUBE_PAGE_PATH_RE`
  - Python uses a combined `SEGMENT_RE` while JS has separate `SEGMENT_EXTENSION_RE`, `SEGMENT_NAME_RE`, `FRAGMENTED_STREAM_CONTEXT_RE`, `NUMBERED_MEDIA_FRAGMENT_RE`
  - Python uses `is_reusable_media_url()` (combines block + classify) while JS uses separate `isBlockedMediaUrl()` and `isDownloadableMediaUrl()`
  - Regex escaping differs (JS uses `/\/` for literal /, Python uses `\\/`)
  - **Recommendation:** Keep as-is (intentional duplication for browser ↔ native host), but add a regression test that verifies the Python regex set produces results consistent with the JS set for a shared test fixture.

- [x] **Reorganized `tests/extension/`** (33 files → 4 subdirectories + 3 root files):
  - `tests/extension/background/` — 13 test files for background modules
  - `tests/extension/content/` — 3 test files for content scripts
  - `tests/extension/popup/` — 8 test files for popup UI
  - `tests/extension/shared/` — 6 test files for shared modules
  - 3 root files left in `tests/extension/` (manifest, project_automation, yandex_browser_support)
  - All import paths updated from `../../src/` to `../../../src/`
  - All resource paths (`../../dist/`, `../../manifest.json`, `../../scripts/`) updated to `../../../`
  - Fixture path in `test_video_filters.js` updated to `../../fixtures/`
  ```
  tests/extension/
  ├── background/          ← tests for background modules
  ├── content/             ← tests for content scripts
  ├── popup/               ← tests for popup UI
  └── shared/              ← tests for shared modules
  ```

  ```mermaid
  flowchart LR
    A[33 files in tests/extension/]
    B[background/ ~10 tests]
    C[content/ ~3 tests]
    D[popup/ ~9 tests]
    E[shared/ ~8 tests]
    F[fixtures/]
    A --> B
    A --> C
    A --> D
    A --> E
    A --> F
    classDef warning fill:#fef3c7,stroke:#f59e0b
    classDef added fill:#d1fae5,stroke:#10b981
    class A warning
    class B,C,D,E,F added
  ```

---

## Refactoring Progress

Use this checklist to track completion. Mark `[x]` when a task is done:

**Phase 1 (Quick Cleanup):** `[3] / 3 completed`
**Phase 2 (File Splitting):** `[5] / 6 completed` (popup.js, popup.css, background.js, go/main_test.go, test_host.py done)
**Phase 3 (Naming Convention):** `[ ] / 1 completed`
**Phase 4 (Structural):** `[2] / 2 completed`

> Update this checklist as you implement fixes. When all items are ticked, the codebase is clean.

> **⚠️ Before implementing any refactoring that splits or moves code, use `skill:test-driven-development`.** Write tests for existing behavior first, then refactor. This ensures refactored code preserves all functionality and catches regressions early.

---

## Appendix: Full Metrics

### A. File Count Per Directory

| Directory | File Count | Status |
|-----------|-----------|--------|
| `tests/extension/` | 33 | 🔴 >30 |
| `src/native-host/` | 24 | 🟢 <30 |
| `docs/` | 13 | 🟢 <30 |
| `src/shared/` | 13 | 🟢 <30 |
| `go/` | 10 | 🟢 <30 |
| `src/background/` | 9 | 🟢 <30 |
| `tests/native-host/` | 9 | 🟢 <30 |
| `config/extension/` | 8 | 🟢 <30 |
| `scripts/` | 7 | 🟢 <30 |
| `src/popup/` | 6 | 🟢 <30 |
| `.agents/types/` | 3 | 🟢 <30 |
| `.agents/skills/` | 2 | 🟢 <30 |
| `.github/` | 2 | 🟢 <30 |
| `tools/` | 2 | 🟢 <30 |

### B. Files Exceeding 400 Lines

| Lines | File |
|-------|------|
| 1,837 | `src/popup/popup.js` |
| 1,702 | `src/popup/popup.css` |
| 1,405 | `src/background/background.js` |
| 1,301 | `go/main_test.go` |
| 1,208 | `tests/native-host/test_host.py` |
| 1,050 | `benchmarks/speedtest.py` |
| 980 | `tests/extension/test_background_hard_access_fallback.js` |
| 808 | `src/shared/filter_list_loader.js` |
| 774 | `src/native-host/capture_manager.py` |
| 661 | `src/shared/video_filters.js` |
| 656 | `tests/extension/test_filter_integration.js` |
| 639 | `src/content/content.js` |
| 630 | `src/native-host/yt_dlp_command.py` |
| 588 | `src/native-host/download_manager.py` |
| 582 | `src/background/download_orchestration.js` |
| 566 | `go/cdm.go` |
| 542 | `tests/extension/test_recording_ui.js` |
| 536 | `src/background/cdm_network_intercept.js` |
| 495 | `tests/extension/test_video_filters.js` |
| 477 | `src/native-host/download_task.py` |
| 470 | `tests/extension/test_cdm_network_intercept.js` |
| 462 | `.agents/types/agent-definition.ts` |
| 453 | `src/native-host/spotify_resolver.py` |
| 450 | `src/background/recording.js` |
| 447 | `src/popup/download_list.js` |
| 443 | `src/content/page_detection.js` |
| 436 | `.agents/types/tools.ts` |
| 432 | `go/commands.go` |
| 428 | `tests/extension/test_popup_refresh_clear_actions.js` |
| 417 | `go/decrypt.go` |

### C. Directory Nesting Depth

All source directories are at depth 2-3. Max depth: 3 levels. ✅

### D. Naming Conventions Per Directory

| Directory | Convention | Consistent? |
|-----------|-----------|-------------|
| `src/background/` | `snake_case.js` | ✅ Yes |
| `src/content/` | `snake_case.js` | ✅ Yes |
| `src/native-host/` | `snake_case.py` | ✅ Yes |
| `src/popup/` | Mixed `kebab-case.js` + `snake_case.js` | ❌ No |
| `src/shared/` | `snake_case.js` | ✅ Yes |
| `tests/extension/` | `test_*.js` | ✅ Yes |
| `tests/native-host/` | `test_*.py` | ✅ Yes |
| `scripts/` | `kebab-case.js/ps1` | ✅ Yes |
| `.agents/types/` | `kebab-case.ts` | ✅ Yes |

### E. Doc File Distribution

| Location | Count | Notes |
|----------|-------|-------|
| `docs/` | 13 | Well-organized into guides/, legal/, reference/ |
| Root | 3 | `AGENTS.md`, `knowledge.md`, `README.md` (expected) |
| `.agents/skills/` | 2 | Skill documentation (expected) |
| `benchmarks/` | 1 | `README.md` (expected) |
| `go/` | 1 | `README.md` (expected) |
| `logs/` | 1 | `Readme.md` — logs troubleshooting guide |

### F. Empty / Dead Directories

| Directory | Status |
|-----------|--------|
| `.claude/` | Empty — no files |

---

## Final Verification Checklist

- [x] Each issue has a clear metric, threshold, and recommended action
- [x] Folder-level issues use ASCII tree diagrams for before/after
- [x] File-level issues use Mermaid diagrams where helpful
- [x] Recommendations account for the project's language/stack (JS + Python + Go)
- [x] The report is saved to `qwin-audit.md`
- [x] The report contains enough context for a new AI session to implement fixes independently
