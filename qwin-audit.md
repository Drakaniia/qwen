# Audit Report: qwin

**Generated:** June 28, 2026
**Project:** Qwin Video Downloader — Chrome/Firefox/Yandex browser extension + Python native host for detecting and downloading videos. Widevine CDM decryption via Go companion binary.
**Total files scanned:** 161 source files (excluding node_modules, .git, dist, __pycache__, .venv)
**Total lines of code:** ~46,521

---

## Executive Summary

The qwin codebase is a feature-rich, well-structured video downloader extension with clearly separated domain boundaries (background service worker, popup UI, native host, Go companion binary). The architecture follows a reasonable modular pattern with good separation of concerns. However, it suffers from a severe oversized-files problem — **29 files exceed the 400-line threshold**, with the largest at 1,519 lines. Naming conventions are mostly consistent (predominantly snake_case), but with notable kebab-case drift in the popup and background directories. Nesting depth and doc organization are clean. No empty directories were found.

---

## Severity Legend

- 🔴 **Blocker** — must fix (critical structural issues)
- 🟡 **Warning** — should fix (could cause maintenance problems)
- 🟢 **Suggestion** — nice to improve (best practice, low effort)

---

## Issues Found

### Phase 1: Quick Cleanup

_Low effort, safe changes. Can be done without deep code understanding._

#### Naming Inconsistencies

| Directory | Styles Detected | Files Affected |
|-----------|----------------|----------------|
| `src/popup/` | snake_case + kebab-case | 10 files |
| `src/background/` | snake_case + kebab-case | 1 file |
| `src/` directory name | hyphenated (`native-host`) vs snake_case files | 1 directory |

**Details:**
- **snake_case** (dominant): `batch_orchestration.js`, `download_state.js`, `capture_manager.py`, `media_resolver.py`, `download_queue.js`, `format_helpers.js`, `header_utils.js`, `video_utils.js`, etc.
- **kebab-case** (inconsistent): `popup-elements.js`, `popup-events.js`, `popup-helpers.js`, `popup-renderer.js`, `popup-state.js`, `popup-ui.js`, `popup-base.css`, `popup-components.css`, `popup-theme.css`, `background-helper-ping.js`
- **Directory naming:** `native-host/` uses a hyphen while all files inside use snake_case

```
src/popup/                         src/popup/
├── popup.js                 vs    ├── popup.js
├── popup-elements.js              ├── popup_elements.js    (renamed)
├── popup-events.js                ├── popup_events.js      (renamed)
├── popup-helpers.js               ├── popup_helpers.js     (renamed)
├── popup-renderer.js              ├── popup_renderer.js    (renamed)
├── popup-state.js                 ├── popup_state.js       (renamed)
├── popup-ui.js                    └── popup_ui.js          (renamed)
├── popup-base.css
├── popup-components.css
├── popup-theme.css
├── popup.css
├── popup.html
└── download_list.js
```

- [ ] **Standardize naming conventions in `src/popup/`** — 7 popup-*.js files use kebab-case instead of project-dominant snake_case
  > Reason: Consistent naming reduces cognitive load and makes search more predictable. The project overwhelmingly uses snake_case.

- [ ] **Standardize naming in `src/background/`** — `background-helper-ping.js` uses kebab-case instead of snake_case
  > Reason: Rename to `background_helper_ping.js` for consistency.

- [ ] **Rename `src/native-host/` directory** — directory uses hyphen while contained files use underscores
  > Reason: Directory name is inconsistent with the naming convention of its own files.

---

#### Doc Sprawl

3 `.md` files at root, 10+ in `docs/` (well-organized). Within threshold — **no action needed**.

| Location | File | Status |
|----------|------|--------|
| Root | `README.md` | ✅ Expected at root |
| Root | `AGENTS.md` | ✅ Expected at root |
| Root | `knowledge.md` | ✅ Project-introspective, expected at root |
| `docs/` | 10 files in guides/, legal/, reference/ | ✅ Well-organized |
| `go/` | `README.md` | ✅ Component-level doc |

---

#### Empty / Dead Directories

No empty directories found — **no action needed**.

---

### Phase 2: File Refactoring

_Medium effort — split oversized files, fix misplaced files. **Test before refactoring.**_

#### Oversized Files

**29 files** exceed the **400-line** threshold (18% of codebase). Source files (excluding tests and benchmarks) that exceed:

| File | Lines | Problem |
|------|-------|---------|
| `src/background/background.js` | **1,519** | Monolithic orchestrator — message routing, CDM handling, recording, tab management, download orchestration, batch ops |
| `src/native-host/download_manager.py` | **843** | Download orchestration + Spotify fallback + probe management + aria2c/Gopeed command building |
| `src/native-host/fallback_engines.py` | **818** | gallery-dl, you-get, lux, direct download — 4 distinct engines in one file |
| `src/popup/popup-helpers.js` | **755** | UI helpers + recording flow + batch UI + synced history + main flows |
| `src/native-host/yt_dlp_command.py` | **663** | yt-dlp command building with multiple variants |
| `src/shared/video_filters.js` | **661** | Video classification, deduplication, grouping, sorting, enrichment |
| `src/background/cdm_network_intercept.js` | **661** | CDP integration + CDM intercept + rate limiting + state management |
| `src/content/content.js` | **652** | Content script — video detection, overlay management, quality dialog, DOM scanning |
| `src/native-host/capture_manager.py` | **630** | Capture pipeline management |
| `src/popup/popup-events.js` | **622** | Popup event handlers |
| `src/native-host/probe_runner.py` | **614** | Parallel probe execution |
| `src/background/download_orchestration.js` | **582** | Download orchestration factory |
| `go/cdm.go` | **566** | CDM init + key extraction + license handling |
| `src/background/cdp_relay.js` | **527** | CDP relay + deep network inspection |
| `src/native-host/download_task.py` | **477** | Download task lifecycle |
| `src/native-host/spotify_resolver.py` | **453** | Spotify metadata + YouTube search |
| `src/background/recording.js` | **450** | Recording state + progress + torrent/magnet |
| `src/popup/download_list.js` | **447** | Download list rendering |
| `go/commands.go` | **445** | Command dispatch for Go binary |
| `src/content/page_detection.js` | **443** | Page detection logic |

_Individual split plans for top-priority source files below._

---

- [ ] **Split `src/background/background.js`** — 1,519 lines (threshold: ≤400)

  > **Language:** JavaScript (ES Modules)
  > **Reason:** At 1,519 lines, this file is the largest in the codebase. It serves as a monolithic orchestrator handling message routing, CDM, recording, tab management, download orchestration, batch operations, CDP relay, torrent, download queue, and helper status.
  > **Proposal:** The background.js already imports from 20+ modules. The remaining inline code handles message routing, web request listeners, and initialization. Extract message handler registrations into domain-specific handler files.

  **Natural Boundaries Detected:**
  | Section | Lines | Description |
  |---------|-------|-------------|
  | WebRequest listeners | ~340-410 | Registration of webRequest event handlers |
  | Message handler: CDM/recording/segment capture | ~450-700 | CDM init, key extraction, decrypt, recording handlers |
  | Message handler: CDP relay + deep inspection | ~700-760 | CDP command handlers |
  | Message handler: Batch/playlist | ~760-850 | Batch download, playlist enumeration |
  | Message handler: Download queue + torrent | ~850-920 | Queue, auto-download, torrent |
  | Message handler: Helper status + rescan | ~920-990 | Ping, helper status, rescan, clear |
  | Initialization + tab lifecycle | ~990-1040 | Filter integration, tab state, helper ping |

  **Proposed Split:**
  ```
  src/background/
  ├── background.js                  (trimmed to orchestration + init, ~400 lines)
  ├── background_helper_ping.js      (existing, rename from background-helper-ping.js)
  ├── background_message_handlers.js (extracted message handler registrations)
  ├── background_webrequest.js       (extracted webRequest listeners)
  └── background_init.js             (extracted initialization logic)
  ```

  **Before (Mermaid):**
  ```mermaid
  flowchart LR
    A[background.js\\n1519 lines] --> B[Message routing]
    A --> C[WebRequest listeners]
    A --> D[CDM handlers]
    A --> E[Recording handlers]
    A --> F[Batch/playlist handlers]
    A --> G[Download queue]
    A --> H[Init + lifecycle]
  ```

  **After (Mermaid):**
  ```mermaid
  flowchart LR
    A[background.js\\n~400 lines] --> B[background_message_handlers.js]
    A --> C[background_webrequest.js]
    A --> D[background_init.js]
    A --> E[background_helper_ping.js]
  ```

- [ ] **Split `src/native-host/download_manager.py`** — 843 lines (threshold: ≤400)

  > **Language:** Python
  > **Reason:** Handles download orchestration + Spotify fallback + probe management + aria2c/Gopeed command building + torrents + magnets. Multiple distinct concerns.
  > **Proposal:** Extract aria2c command building, magnet/torrent download functions, and Spotify fallback into separate files.

  **Natural Boundaries Detected:**
  | Section | Lines | Description |
  |---------|-------|-------------|
  | aria2c command builders | ~10-120 | `_build_aria2c_bittorrent_command`, `build_aria2c_magnet_command`, `build_aria2c_torrent_command` |
  | Active download tracking | ~120-155 | `ACTIVE_DOWNLOADS`, `control_download`, `cancel_active_downloads` |
  | Probe config building | ~155-280 | `_build_probe_configs` |
  | Main download function | ~280-520 | `run_download` — the core download orchestrator |
  | Magnet/Torrent downloads | ~520-670 | `run_magnet_download`, `run_torrent_download`, Gopeed variants |
  | Spotify fallback | ~670-843 | `_run_spotify_fallback_download` |

  **Proposed Split:**
  ```
  src/native-host/
  ├── download_manager.py            (trimmed to orchestration + probe configs)
  ├── aria2c_commands.py             (extracted aria2c command builders)
  ├── bittorrent_downloads.py        (extracted magnet/torrent download functions)
  └── spotify_fallback.py            (extracted Spotify fallback download logic)
  ```

- [ ] **Split `src/native-host/fallback_engines.py`** — 818 lines (threshold: ≤400)

  > **Language:** Python
  > **Reason:** Contains 4 distinct fallback engines (gallery-dl, you-get, lux, direct HTTP download) in one file.
  > **Proposal:** Split each engine into its own file.

  **Natural Boundaries Detected:**
  | Section | Lines | Description |
  |---------|-------|-------------|
  | gallery-dl | ~35-180 | `resolve_gallery_dl_command`, `list_formats_gallery_dl`, `download_with_gallery_dl` |
  | you-get | ~190-390 | `resolve_you_get_command`, `list_formats_you_get`, `download_with_you_get` |
  | lux | ~400-570 | `resolve_lux_command`, `list_formats_lux`, `download_with_lux` |
  | Direct HTTP download | ~580-680 | `is_direct_media_url`, `download_direct` |
  | Shared helpers | ~690-818 | `_human_size`, `_find_latest_file` |

  **Proposed Split:**
  ```
  src/native-host/
  ├── fallback_engines/              (new subdirectory)
  │   ├── __init__.py                (re-exports public API)
  │   ├── gallery_dl_engine.py       (gallery-dl integration)
  │   ├── you_get_engine.py          (you-get integration)
  │   ├── lux_engine.py              (lux integration)
  │   ├── direct_download.py         (direct HTTP download)
  │   └── helpers.py                 (shared helpers)
  └── fallback_engines.py            (removed, replaced by package)
  ```

  **Import Changes:**
  | Consumer File | Old Import | New Import |
  |--------------|-----------|-----------|
  | `download_manager.py` | `from fallback_engines import has_you_get` | `from fallback_engines import has_you_get` (same — __init__.py re-exports) |
  | `download_manager.py` | `from fallback_engines import has_lux` | `from fallback_engines import has_lux` (same — __init__.py re-exports) |

- [ ] **Split `src/popup/popup-helpers.js`** — 755 lines (threshold: ≤400)

  > **Language:** JavaScript (ES Modules)
  > **Reason:** Mixes UI helpers, recording flow, batch UI, synced history, and main flows.
  > **Proposal:** Extract synced history rendering and batch/playlist UI into separate files.

  **Natural Boundaries Detected:**
  | Section | Lines | Description |
  |---------|-------|-------------|
  | Indicator + UI helpers | ~30-85 | `setDownloadIndicator`, `updateIndicatorFromVideos`, `setMessage`, etc. |
  | View mode + settings | ~85-150 | `setViewMode`, `setSettingsOpen`, `setVideoLayoutMode` |
  | Recording flow | ~155-210 | `startRecording` |
  | Tab context + main flows | ~210-310 | `updateActiveTabContext`, `refresh`, `checkHelperStatus` |
  | Init + rescan | ~310-440 | `init`, `rescanActiveTab`, `clearActiveTabVideos` |
  | Batch/playlist UI | ~440-540 | `updateBatchUI`, `updatePlaylistPrompt`, `downloadAllPlaylist` |
  | Synced history | ~540-660 | `renderSyncedHistory` |

- [ ] **Split `src/shared/video_filters.js`** — 661 lines (threshold: ≤400)

  > **Language:** JavaScript (ES Modules)
  > **Reason:** Contains regex definitions, utility functions, identity/deduplication logic, sorting/prioritization, and grouping.
  > **Proposal:** Extract sorting/grouping functions and identity/deduplication logic.

  **Natural Boundaries Detected:**
  | Section | Lines | Description |
  |---------|-------|-------------|
  | Regex constants + basic utils | ~3-70 | `SHORT_OR_PREVIEW_RE`, `RESOLUTION_RE`, `lower`, `finiteNumber`, etc. |
  | Classification + display | ~70-190 | `classifyVideoUrl`, `displayVideoFormat`, `humanSize`, `displayVideoSize` |
  | Candidate filtering | ~190-290 | `isLikelyFullLengthVideoCandidate`, `isLikelyRealVideoBox` |
  | Identity + deduplication | ~290-410 | `normalizeComparableUrl`, `videoIdentityParts`, `isSameFullVideo` |
  | Sorting + grouping | ~410-590 | `variantSortKey`, `groupedVideoSortKey`, `compareVariants`, `buildGroupedVideo`, `groupUniqueFullVideos` |
  | Exports | ~590-661 | Export statements + `sourceLabel` |

  **Proposed Split:**
  ```
  src/shared/
  ├── video_filters.js               (trimmed to core regex + classification)
  ├── video_identity.js              (extracted deduplication + identity)
  └── video_sorting.js               (extracted sorting + grouping)
  ```

---

#### Misplaced Files

| File | Current Location | Target Location | Reason |
|------|-----------------|-----------------|--------|
| `knowledge.md` | Root | `docs/` | Project documentation belongs in `docs/` |
| `AGENTS.md` | Root | `docs/` | Agent/development documentation belongs in `docs/` or `.agents/` |

- [ ] **Move `knowledge.md` and `AGENTS.md` to `docs/`**
  > Reason: Reduces root-level clutter. Documentation should live in `docs/`.

---

### Phase 3: Structural Refactoring

_Higher effort — reorganize folders, improve module boundaries._

#### Bloated Directories

No directory exceeds the 30-file threshold, but `src/native-host/` at 28 files is approaching the limit.

| Directory | File Count | Threshold | Recommendation |
|-----------|-----------|-----------|----------------|
| `src/native-host/` | **28** | ≤30 | Near threshold — consider splitting after Phase 2 file refactoring |
| `tests/native-host/` | **23** | ≤30 | Healthy |
| `src/background/` | **21** | ≤30 | Healthy after splitting background.js |
| `src/shared/` | **16** | ≤30 | Healthy after splitting video_filters.js |

```
src/native-host/
├── artifacts.py
├── browser_context.py
├── capture_manager.py
├── cdm_capture.py
├── curl_cffi_adapter.py
├── download_logger.py
├── download_manager.py
├── download_task.py
├── fallback_engines.py
├── folder_picker.py
├── format_list.py
├── gopeed_adapter.py
├── host.py
├── host_dispatch.py
├── media_candidates.py
├── media_resolver.py
├── native_paths.py
├── native_protocol.py
├── probe_runner.py
├── process_control.py
├── progress_parser.py
├── qwin_video_host.bat
├── register-host.ps1
├── spotify_resolver.py
├── stream_backends.py
├── yt_dlp_adapter.py
├── yt_dlp_command.py
└── yt_dlp_dependencies.py
└── ... 28 files total
```

- [ ] **Consider splitting `src/native-host/`** — 28 files approaching threshold
  > Reason: At 28 files, the directory is nearing the 30-file threshold. After Phase 2 file splits (creating subdirectories for fallback_engines), it may naturally reduce.

---

#### Deeply Nested Directories

| Path | Depth | Threshold |
|------|-------|-----------|
| `.agents/skills/audit-codebase/references/` | **5** | ≤4 |
| `.agents/skills/folder-architecture/references/` | **5** | ≤4 |
| `.agents/skills/implement-folder-architecture/references/` | **5** | ≤4 |
| `tests/extension/background/` | **4** | ≤4 |
| `tests/native-host/.pytest_cache/` | **5** | (cache dir, excluded) |

- [ ] **Flatten `.agents/skills/` structure** — skill directories go 5 levels deep
  > Reason: `.agents/skills/<skill-name>/references/` and `agents/` add unnecessary nesting.
  > Proposal: Move skill references to `.agents/skills/<skill-name>.ref/` or flatten to 4 levels.
  > **Note:** These are auto-generated skill directories — may not be worth refactoring as they come from external sources.

---

#### Architecture Issues

| Area | Issue | Recommendation |
|------|-------|---------------|
| `go/` Go binary | `cdm.go` (566 lines) + `commands.go` (445 lines) both oversized | Split `cdm.go` into `cdm_init.go`, `cdm_keys.go`; split `commands.go` by domain |
| `src/background/` | Multiple modules (recording.js, cdm_network_intercept.js, cdp_relay.js) exceed 400+ lines | These are already somewhat modular but each handles too many concerns |

- [ ] **Refactor `go/cdm.go`** — 566 lines (threshold: ≤400)
  > **Language:** Go
  > **Reason:** Handles CDM initialization + key extraction + license handling.
  > **Proposal:** Split into same-package files: `cdm.go` (init), `cdm_keys.go` (key extraction).
  > **Note:** Go allows same-package splitting across multiple .go files in the same directory. No import changes needed.

  **Before:**
  ```
  go/
  ├── cdm.go          (566 lines — init + keys + license)
  ├── commands.go      (445 lines)
  ├── decrypt.go       (417 lines)
  ├── ipc.go           (218 lines)
  └── main.go          (85 lines)
  ```

  **After (proposed):**
  ```
  go/
  ├── cdm.go           (trimmed, ~200 lines — init only)
  ├── cdm_keys.go      (extracted, ~200 lines — key extraction + license)
  ├── commands.go      (trimmed, ~200 lines — core dispatch)
  ├── decrypt.go       (417 lines)
  ├── ipc.go           (218 lines)
  └── main.go          (85 lines)
  ```

- [ ] **Move `benchmarks/`** — standalone speedtest doesn't belong at root
  > **Proposal:** Move `benchmarks/` into `scripts/benchmarks/` or `tests/benchmarks/`.

---

## Refactoring Progress

Use this checklist to track completion. Mark `[x]` when a task is done:

```
Phase 1: Quick Cleanup
  [x] Standardize naming in src/popup/ (kebab-case → snake_case)
  [x] Rename background-helper-ping.js → background_helper_ping.js
  [x] Rename src/native-host/ → src/native_host/ (consider impact)

Phase 2: File Refactoring
  [x] Split src/background/background.js (1519 lines)
  [x] Split src/native_host/download_manager.py (843 lines)
  [x] Split src/native_host/fallback_engines.py (818 lines)
  [x] Split src/popup/popup_helpers.js (755 lines)
  [x] Split src/shared/video_filters.js (661 lines)
  [x] Split src/background/cdm_network_intercept.js (661 lines)
  [x] Split src/content/content.js (652 lines)
  [x] Split src/native_host/capture_manager.py (630 lines)
  [x] Split src/popup/popup_events.js (622 lines)
  [x] Split src/native_host/probe_runner.py (614 lines)
  [x] Split src/background/download_orchestration.js (582 lines)
  [x] Split go/cdm.go (566 lines)
  [x] Split src/background/cdp_relay.js (527 lines)
  [x] Split src/native_host/download_task.py (477 lines)
  [x] Split src/native_host/spotify_resolver.py (453 lines)
  [ ] Split src/background/recording.js (450 lines)
  [ ] Split src/popup/download_list.js (447 lines)
  [ ] Split go/commands.go (445 lines)
  [ ] Split src/content/page_detection.js (443 lines)
  [ ] Move knowledge.md and AGENTS.md to docs/

Phase 3: Structural Refactoring
  [ ] Refactor go/cdm.go and go/commands.go (Go same-package split)
  [ ] Move benchmarks/ into scripts/benchmarks/
  [ ] Consider flattening .agents/skills/ structure

Total: [5] / [20] completed
```

> **⚠️ Important:** Before implementing any refactoring that splits or moves code, use `skill:test-driven-development`. Write tests for existing behavior first, then refactor. This ensures refactored code preserves all functionality and catches regressions early.

---

## Edge Cases Checked

| Check | Status |
|-------|--------|
| Empty repository? | ✅ No — 161 source files |
| Generated/vendor dirs skipped? | ✅ node_modules, .git, dist, __pycache__, .venv excluded |
| Binary-only repository? | ✅ No — source code present |
| Symlinks? | ✅ None detected |
| Hidden files checked? | ✅ `.agents/` included as config files |

---

## Implementation Notes for AI

When starting implementation in a new session with this report:

1. **Always use `skill:test-driven-development`** — write a failing test first, then make it pass, then refactor. This applies especially to:
   - Splitting oversized files (you need to understand the API surface first)
   - Moving files between directories (import paths may change)
   - Restructuring modules (dependency graphs must remain valid)

2. **Implement Phase 1 first** — it's safe, low-risk, and gets quick wins.

3. **For Phase 2, tackle one file at a time** — extract modules, run tests, commit, then move to the next.

4. **For Phase 3, plan the full directory structure before moving files** — sketch the target tree, then move files in batches.

5. **After each phase, re-run the full test suite** and verify nothing is broken. The project has 63 test files (`npm run test` for JS + Python tests, `npm run test:native` for Python, `npm run test:extension` for JS).

6. **For Go files (go/ directory):** Remember that all .go files in the same directory share the same package. Same-package splitting requires no import changes. Splitting into a new directory creates a new package.

7. **For Python files (src/native-host/):** Create `__init__.py` barrel files when splitting into subdirectories. Run `python -c "from <module> import *"` to verify imports.

8. **For JS files (src/background/, src/popup/, src/shared/, src/content/):** Create `index.js` barrel files when splitting into subdirectories. Check for circular dependencies (A imports B imports A).
