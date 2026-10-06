# PROJECT KNOWLEDGE BASE

**Branch:** main
**Status:** verified against the working tree on 2026-10-04, after the UI/UX redesign
(`ui-ux-redesign-spec.md`, all seven phases landed; this file is Phase 6). When this file and
the tree disagree, the tree wins — fix this file. **Working tree is ahead of `main`:**
the redesign _and_ the `src/**/*.js` → `src/**/*.ts` rename are uncommitted, so a fresh
clone of `main` still has the old layout. The `dist/yandex` size baseline in NOTES is
measured and current.

> ⚡ **PRIMARY BROWSER: Yandex** (Chromium 150). All development, debugging and manual
> testing targets Yandex Browser first. Chrome/Chromium 148+ is secondary; only test there
> after Yandex is confirmed working.
> Extension ID (all Chromium forks, pinned by the manifest `key`): `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

## OVERVIEW

Qwin Video Downloader — a Windows-focused **Manifest V3** Chromium extension plus a Python
native messaging host. The extension detects video on the current page; the host enumerates
formats and downloads with `yt-dlp`, `aria2c` and `ffmpeg`.

- **UI:** Preact + TypeScript + `@preact/signals`, styled with Tailwind CSS v4 and animated by
  `motion`. Three pages — `popup.html`, `downloads.html`, `options.html` — plus the in-page
  content overlay, all four on one design system. Appearance is a 3-way **System / Light /
  Dark** control persisted at `qwinSettings.theme`; System follows `prefers-color-scheme`.
  See DESIGN SYSTEM.
- **Browser floor:** `minimum_chrome_version: "148"`. The code targets the native
  promise-based `browser` namespace via one shim in `src/shared/browser_api.ts`.
- **Firefox is not supported.** Manifest, build target and native-host config are Chromium-only.
  The _code_ stays cross-browser-clean, so re-adding Firefox is one manifest file.

## BROWSER MATRIX

| Browser                          | Status      | Notes                                                      |
| -------------------------------- | ----------- | ---------------------------------------------------------- |
| Yandex Browser                   | **Primary** | Chromium 150 base. Load `dist/yandex`.                     |
| Chrome / Chromium / Edge / Brave | Supported   | Chromium 148+. Load `dist/chromium`.                       |
| Firefox                          | **Removed** | No manifest, no build target, no native-host registration. |

## STRUCTURE

```
qwin/
├── AGENTS.md                    # This file
├── README.md                    # Human-facing README
├── package.json / package-lock.json
├── vite.config.ts               # Preact/Tailwind build: root src/popup, 4 inputs
├── vitest.config.ts             # Test config. Read independently of vite.config.ts.
├── vitest.setup.ts              # vitest-chrome-mv3 globals + reset + the Animation.finished patch
├── tsconfig.json                # strict; includes src/**, tests/js/**, both config .ts
├── eslint.config.js             # ESLint flat config, scoped to src/**/*.{js,ts,tsx}
├── ruff.toml                    # Ruff (E/F/W/I), line-length 120, target py311
├── .prettierrc
├── config/
│   ├── extension/
│   │   ├── manifest.chromium.json   # the ONLY manifest template
│   │   └── icons/icon-{16,32,48,128}.png   # toolbar/management art, static (not a Vite input)
│   └── native-host/com.qwin.video_downloader.{chrome,yandex}.json
├── src/
│   ├── background/              # Service worker (.ts): orchestration, webRequest, tabs, routing
│   │   ├── download/            #   index.ts, native.ts, browser.ts
│   │   └── message-handlers/    #   download.ts, tab.ts, settings.ts
│   ├── content/                 # content.ts + content_overlay.ts + page_detection.ts
│   ├── popup/                   # All three pages
│   │   ├── popup.html           #   a 37-line shell: 3 mount roots, no form controls
│   │   ├── views/               # PopupFrame, MediaView, DownloadsView, VideoRow, JobRow, SelectionBar, PlaylistRow
│   │   ├── components/          #   PasteBox, DependencyBanner, QualityDialogMount
│   │   ├── downloads/           #   DownloadsPage, FacetPopover, HistoryRow, state.ts
│   │   ├── options/             #   OptionsPage, sections, diagnostics, Saved, state.ts
│   │   ├── state/               #   app.ts, videos.ts, downloads.ts, filters.ts, playlists.ts, compat.ts
│   │   └── popup*.ts            #   the imperative half still boots (popup.ts, popup_actions.ts, …)
│   ├── shared/                  # Contracts shared across background/content/popup (.ts)
│   │   ├── contracts.ts         #   Settings, DetectedVideo, ThemeMode — both sides stay in sync
│   │   └── qwin_overlay.css     #   :host-scoped copy of the theme.css tokens
│   ├── ui/                      # THE design system — every shared component, hook and token
│   │   ├── theme.css            #   the single palette / type / radius / material source
│   │   ├── motion.ts            #   spring presets, rubberband(), popup width bounds
│   │   ├── Icon.tsx             #   the only icon set, plus StatusDot
│   │   ├── Logo.tsx  logo.png   #   the brand mark; the PNG is the 128px cut of the master
│   │   ├── format.ts  filter.ts  status.ts
│   │   ├── useResize.ts  useStickySelection.ts  useListKeys.ts
│   │   └── components/          #   Button Toolbar Sheet Segmented EmptyState Skeleton
│   │                           #   Checkbox Meter ProgressBar Toggle Field QualityDialog FilterBar
│   ├── native_host/             # Python native messaging host
│   └── logs/                    # downloads.jsonl (runtime, gitignored — see NOTES)
├── tests/
│   ├── js/                      # vitest — mirrors src/{popup,ui,shared,content,downloads,options}
│   └── native/                  # pytest
├── scripts/                     # build-extension.ps1, build-bundles.js, install.sh, load-extension.ps1
├── docs/                        # docs/README.md + docs/guides/
├── dist/                        # Generated. gitignored.
└── .github/workflows/ci.yml
```

`src/popup/styles/` **does not exist.** The redesign deleted it plus `popup-base.css`,
`popup-theme.css` and `popup.css`. `main.tsx` imports `../ui/theme.css` and
`../shared/qwin_overlay.css` itself, the way `downloads-main.tsx` and `options-main.tsx`
already did. `src/ui/` is the whole design system — if it is not there, it does not exist.

`tools/` and `packaging/` **do not exist**. `tools/` is created by `scripts/install.sh` at
install time to hold `aria2c.exe` and `N_m3u8DL-RE.exe`; it is gitignored and absent from a
fresh clone. There is no installer/packaging pipeline.

## DESIGN SYSTEM

One source: `src/ui/theme.css`. Every other stylesheet in `src/` is either Tailwind
utilities over the tokens declared there or a component-owned class. Nothing else defines
a colour.

**Palette.** Apple system colours, one definition each: accent `#007AFF` / `#0A84FF`,
critical `#FF3B30` / `#FF453A`, caution `#FF9500` / `#FF9F0A`, success `#34C759` /
`#30D158`, purple `#AF52DE` / `#BF5AF2` (audio candidates), separator
`rgba(60,60,67,0.18)` / `rgba(235,235,245,0.16)`. The old
`--surface/--text/--muted/--line/--danger/--warning/--ok` block and the `data-status` hexes
are gone.

**A token goes in THREE places** — the `@theme` light block, `:root[data-theme="dark"]`, and
`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`. Miss one and the
token is light-only. That is the single most likely way to break this file.

**Three material weights**, never stacked translucent-on-translucent (a blurred row behind
another blurred row is unreadable, and rows are the densest thing in the app):

| Material            | Where                                   | Treatment                                             |
| ------------------- | --------------------------------------- | ----------------------------------------------------- |
| `.material-chrome`  | header, view bar, footer, selection bar | blur 20/24px + `saturate(180%)` + inset top highlight |
| `.material-sheet`   | quality dialog, facet popover           | blur 32px + `0 24px 48px` drop shadow                 |
| `.material-content` | rows, list bodies, options sections     | **opaque**                                            |

`@supports not (backdrop-filter: blur(1px))` and `prefers-reduced-transparency: reduce`
both swap every material to its opaque equivalent. `prefers-reduced-motion` and
`prefers-contrast: more` are honoured in the same file.

**Motion.** `motion` is the only sanctioned animation runtime; presets live in
`src/ui/motion.ts`. Popup width resize is **deliberately animation-free** — spec §4.5, "any
spring here is a bug" — so `useResize` writes `document.body.style.width` directly at
400–720px (default 460), rubber-bands past both bounds via `rubberband()`, and persists to
`qwinSettings.popupWidth`.

## WHERE TO LOOK

| Task                        | Location                                                              | Notes                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Download orchestration**  | `src/background/download/`, `download_operations.ts`                  | Native-host path and browser-download path                                                                                           |
| **Download error mapping**  | `src/background/download_fallbacks.ts`                                | Translates raw backend errors into user-facing text                                                                                  |
| **Network interception**    | `src/background/background_webrequest.ts`                             | `webRequest` listeners, header capture                                                                                               |
| **Message routing**         | `src/background/message_router.ts`, `message-handlers/`               | `download` / `tab` / `settings` handlers                                                                                             |
| **Tab state**               | `src/background/tab_state.ts`                                         | Per-tab detected videos, `storage.local`. **Owns `qwinSettings` in memory** — `persistSettings` rewrites the whole key.              |
| **Format enumeration**      | `src/background/format_helpers.ts`                                    | Orchestrates native `formats` request                                                                                                |
| **Content detection**       | `src/content/content.ts`, `page_detection.ts`                         | DOM sweep, `<video>`/`<source>`, SPA rescans                                                                                         |
| **On-page overlay**         | `src/content/content_overlay.ts`                                      | Shadow DOM; reads `:host` tokens, mirrors the theme onto the shadow host                                                             |
| **Popup frame & rows**      | `src/popup/views/`                                                    | `PopupFrame` (header/view switch/footer/resize grip), `MediaView`, `DownloadsView`, `VideoRow`, `JobRow`, `SelectionBar`             |
| **Popup state**             | `src/popup/state/`                                                    | Signals: `app.ts` (view mode, theme, width), `videos.ts`, `downloads.ts`, `filters.ts`                                               |
| **Downloads page**          | `src/popup/downloads/`                                                | Grouped by day, per-row open/reveal, facet popovers, bulk bar                                                                        |
| **Options page**            | `src/popup/options/`                                                  | Five task sections + search; `sections.tsx` holds the section table and terms                                                        |
| **Design system**           | `src/ui/`                                                             | Tokens in `theme.css`, springs in `motion.ts`, everything else beside them                                                           |
| **Icons**                   | `src/ui/Icon.tsx`                                                     | The only icon set, plus `StatusDot`. 24×24, `stroke-width: 1.6`. No emoji anywhere in `src/`.                                        |
| **Popup resize**            | `src/ui/useResize.ts`                                                 | 400–720px, default 460, rubber-banded at both bounds, persisted                                                                      |
| **Selection set**           | `src/ui/useStickySelection.ts`                                        | Module-level signal. **No download dispatch** — the batch executor is Phase 2.                                                       |
| **Playlist folders**        | `src/popup/state/playlists.ts`, `src/popup/views/PlaylistRow.tsx`    | `mediaRows` folds *consecutive* runs of `playlistId` into one collapsed folder. `displayedVideos` is untouched, so search/facets still run on songs. |
| **Keyboard model**          | `src/ui/useListKeys.ts`                                               | Roving tabindex, `/` search, Enter, Space, Esc, Home/End                                                                             |
| **Native host entry**       | `src/native_host/host.py`                                             | stdio loop + `match` dispatch table                                                                                                  |
| **yt-dlp commands**         | `src/native_host/backends/yt_dlp/yt_dlp_command.py`                   | Command building, variant fallbacks                                                                                                  |
| **Dependency probing**      | `src/native_host/backends/yt_dlp/yt_dlp_dependencies.py`              | `yt-dlp`, `ffmpeg`, `aria2c`, `N_m3u8DL-RE`, `streamlink`                                                                            |
| **Stream backends**         | `src/native_host/backends/stream_backends.py`                         | N_m3u8DL-RE / Streamlink / ffmpeg command builders                                                                                   |
| **Shared contracts**        | `src/shared/contracts.ts`                                             | `Settings` (incl. `popupWidth`, `theme`), `DetectedVideo`, `ThemeMode`. Both sides must stay in sync.                                |
| **Media detection helpers** | `src/shared/media_candidates.ts`, `video_filters.ts`                  | Filtering the detector's output, both sides share them                                                                               |
| **Helper dependency table** | `src/shared/helper_dependencies.ts`, `host.py:dependency_status()`    | One entry per external tool. Both UIs render it; the Python side reports it.                                                         |
| **Filter lists**            | `src/shared/filter_list_*.ts`, `src/background/filter_integration.ts` | uBO + EasyList patterns, 5-day / 1-day refresh                                                                                       |
| **Overlay tokens**          | `src/shared/qwin_overlay.css`                                         | `:host`-scoped copy of `theme.css`'s palette. `tests/js/content/overlay_tokens.test.ts` diffs the two hex sets so they cannot drift. |
| **Build**                   | `scripts/build-extension.ps1`, `scripts/build-bundles.js`             | Owns `dist/`                                                                                                                         |
| **Tests**                   | `tests/js/**`, `tests/native/**`                                      | 1118 vitest tests / 31 files; 9 pytest tests / 2 files                                                                               |

## BUILD TOPOLOGY — two bundlers, three artifacts

This is the load-bearing structural fact. Do not "simplify" it.

```
src/popup/{popup,downloads,options}.html + main.tsx
        ──Vite (ESM)──────────────────▶ dist/bundled/src/popup/**

src/content/content.ts       ──esbuild (IIFE)──▶ content.bundle.js
src/background/background.ts ──esbuild (IIFE)──▶ background.bundle.js

              ┌──────── scripts/build-extension.ps1 ────────┐
              │ vite build → node build-bundles.js → wipe   │
              │ dist/<target> → copy the built popup pages,  │
              │ the two esbuild bundles, the native-host    │
              │ installers and the manifest. No Python, no   │
              │ __pycache__, no unbundled .js.               │
              └──────────────────────────────────────────────┘
                              ▼
              dist/chromium/   dist/yandex/
```

**The content script and service worker MUST stay IIFE.** This is a hard platform
constraint, not a stylistic choice:

- The manifest `content_scripts` object has no `type` field, so a declared content script
  **cannot** be an ES module.
- `config/extension/manifest.chromium.json` declares `background.service_worker` with no
  `"type": "module"`, so the service worker is IIFE too.
- esbuild's own maintainer: _"iife is the only compatible format as content script cannot be
  an es module"_ (esbuild#2277).
- Dynamic `import()` also fails in content scripts (Firefox bug 1803950, Chromium issue
  444772033).

**Do not migrate them to Vite. Do not add a Vite extension plugin.** Every candidate
(`vite-plugin-web-extension`, `@crxjs/vite-plugin`, `wxt`) wants to own the manifest and
rebuild every manifest-listed input — which is exactly the two files esbuild owns. crxjs also
rewrites content-script filenames to hashed names, breaking the manifest outright. Plain Vite
(`root: src/popup`, `base: './'`, four inputs — the three HTML pages plus `main.tsx`) keeps
`dist/` owned by `scripts/build-extension.ps1` and loses nothing real: content-script HMR
was never available.

**The overlay is compiled by esbuild, not Vite.** `content_overlay.ts` imports
`../shared/qwin_overlay.css?inline`; `scripts/build-bundles.js` has a `cssTextPlugin()` that
resolves that specifier by hand and emits the file as a string. The string is installed on a
`<style>` element **inside the overlay's shadow root**. Do not register it in
`content_scripts[].css` — the overlay is Shadow DOM precisely so Tailwind's global preflight
cannot reset the host page, and it ships via the bundle, not the manifest.

## CONVENTIONS (deviations from standard)

- **`src/**`is TypeScript.** The`.js`→`.ts`rename is uncommitted (see Status), so a
fresh clone still shows the old`.js` files.
- **Lockfile is committed.** `package-lock.json` exists; npm is the only package manager.
- **`motion` is a runtime dependency, and it is the only one.** `^14.0.0`, used _vanilla_:
  `animate()` imported from `"motion"` and called in Preact effects. There are deliberately
  **no** `motion/react` bindings — this is Preact, not React. Spec D9.
- **Never write `qwinSettings` to `storage.local` directly.** `Settings.popupWidth` and
  `Settings.theme` go through the background's `saveSettings` message.
  `background/tab_state.ts` owns `qwinSettings` in memory and `persistSettings` rewrites the
  whole key from that object, so a direct write is silently erased by the next settings save
  from _any_ surface.
- **Manifest template** is `config/extension/manifest.chromium.json` — edit that, never `dist/`.
  Its `icons/` sibling is copied verbatim by `build-extension.ps1`; the manifest can only point
  at a file that exists at load time, so icon art is static, never a Vite input.
- **The browser loads `dist/<target>/`, not `src/`.** Rebuild after every source change.
- **Windows-only infra.** Build is PowerShell (`scripts/build-extension.ps1`); install is
  `scripts/install.sh` invoked through Git bash (`npm run setup` shells out to
  `C:\Program Files\Git\bin\bash.exe`). No bash assumptions elsewhere.
- **Python native host registration** is via Windows Registry under
  `HKCU\Software\{Browser}\NativeMessagingHosts\com.qwin.video_downloader`, plus
  `config/native-host/*.json` manifests.
- **Python imports are flat.** `host.py` walks `src/native_host/**` onto `sys.path`, so every
  module imports siblings by bare name (`from native_protocol import HostError`), not
  `backends.x.y`. Getting this wrong breaks the host.
- **No `webextension-polyfill`.** It is frozen — its own README says it will not receive
  further updates. The 200-byte shim in `src/shared/browser_api.ts`
  (`globalThis.browser ??= globalThis.chrome`) replaces it. Do not re-add the polyfill.

## ANTI-PATTERNS (this project)

- **No global npm packages** — use `npm run setup`.
- **No editing `dist/`** — edit `src/` and rebuild.
- **No yarn/pnpm** — the project uses npm.
- **Videos are tab-scoped; downloads are global.** A download belongs to the machine, not to
  the tab that started it — the popup tray, its header badge and the background's duplicate
  blocking all read every job, in every tab and window. The _Media_ video list stays
  deliberately tab-scoped: detected videos belong to the page, and one page's candidates must
  not pollute another's. Do not "fix" the video half to match, and do not re-add a `tabId`
  filter to the download half.
- **Do not move the content script or service worker to Vite.** See BUILD TOPOLOGY.
- **Do not restore** magnet links, `.torrent`, screen recording, CDM/DRM capture, or the
  lux / you-get / gallery-dl / gopeed backends. All were deleted deliberately in
  `dad38be` / `f38e6de` / `8c5c698`; there is no engine behind any of them.
- **The theme toggle exists — but never encode `system` as `data-theme="system"`.** There
  _is_ a 3-way System/Light/Dark `Segmented` control, in the popup header and in Options →
  Appearance, persisted at `qwinSettings.theme`, defaulting to System. `theme.css`
  documents `data-theme` as `"light"`, `"dark"`, or **absent**, so System is represented by
  _removing_ `document.documentElement.dataset.theme`. A `"system"` string has no selector
  of its own; it only _appears_ to work because the system-dark rule is written
  `:root:not([data-theme="light"])`, which matches any non-`light` value — so a typo or a
  fourth state silently inherits "follow the OS". Three call sites do delete-or-set:
  `popup/state/app.ts:setTheme`, `popup/options/state.ts:applyTheme`,
  `popup/popup_helpers.ts`. The overlay mirrors the same value onto its shadow host.
- **Do not add a `dark:` Tailwind variant to bypass the three-block rule.** Unlayered
  `:root[data-theme="dark"] { --color-… }` is what actually recolours the utilities; that
  reasoning is written out in `theme.css`'s header comment. Read it before "simplifying".
- **Do not hand `motion` a spring's `damping`/`response`.** Spec §4.5's `{damping, response}`
  table is _not_ motion v14's API. v14 takes `{bounce, duration}` for a spring — `bounce` is
  `1 - damping`. **`duration` is SECONDS, for a spring and a tween alike** — a millisecond literal is read as *seconds* and clamped (which made every `motion.ts` preset a ten-second spring). A
  bare `damping` with no `stiffness`/`mass` silently switches motion to a physics spring and
  ignores `duration`: `{damping: 1.0, response: 0.3}` measured **10.7 seconds** to settle,
  and the runtime prints `Spring duration must be 10 seconds or less`. Take numbers from
  `src/ui/motion.ts`, which already transcribes the spec table — do not retype it.
- **Do not put a token in `theme.css` in only one of its three blocks.** See DESIGN SYSTEM.
- **Do not restyle the overlay's `QualityDialog` onto `ui/components/Sheet`.** `Sheet`
  imports `motion` _and_ `preact/compat`, and adopting it would pull both into the content
  script's IIFE bundle, which must stay dependency-lean (see BUILD TOPOLOGY). The overlay
  mounts its dialog instantly instead of on a spring — a deliberate, documented deviation
  from spec §9. Do not "fix" it.
- **Do not "fix" the list `cssCodeSplit: false` in `vite.config.ts`** by splitting CSS per
  entry. `popup.html`'s single `<script src="./main.tsx">` is what pulls in the merged
  stylesheet, and Vite injects the `<link>` into the _built_ page; a per-entry split file
  would never be referenced.
- **Do not add dead exports.** Every exported helper should have a caller or a test.

## UNIQUE STYLES

- **JS/TS**: 2-space indent, trailing commas, double quotes, ES modules. Prettier owns
  `src/**/*.{css,json,ts,tsx}` and root `*.{json,js}` via `npm run format`; CI's `--check`
  additionally covers `.js` files and `tests/**`.
- **Python**: 4-space indent, Ruff (`E`/`F`/`W`/`I`, `E402` ignored), 120 chars.
- **Type, spacing and radius are codified scales, not suggestions.** Type roles are tokens
  in `theme.css`'s `@theme` — `text-title` 13/600/−0.01em, `text-section` 11/600/+0.06em,
  `text-row` 13/590/−0.005em, `text-body` 12, `text-caption` 11, `text-numeric` 12 tabular.
  Spacing is **4 / 8 / 12 / 16 / 20 / 24 px**. Radius is **6** (badges, chips) / **10**
  (rows, inputs) / **14** (cards, sheets) / **20** (dialog) / **`full`** (pills). An
  arbitrary value (`p-[7px]`, `rounded-[3px]`, `delay-350`) is a **defect**, not a style
  choice — take the nearest step or extend the token.
- **Comments are load-bearing.** The spec-migration code carries `spec §…` / `(spec D…)`
  references explaining _why_ a non-obvious choice exists. Match that when editing near one.
- **Conventional commits** with scopes: `feat(popup):`, `fix(background):`, `refactor(native):`,
  `test(extension):`, `docs:`, `build:`.

## COMMANDS

Every one of these exists in `package.json`. Verified 2026-10-04.

```powershell
npm run setup          # scripts/install.sh via Git bash: Python deps, tools, build, registry
npm run build          # vite build + esbuild bundles -> dist/chromium, dist/yandex
npm run build:chromium # single target
npm run build:yandex   # single target
npm run dev            # vite build --watch (popup pages rebuild on save)
npm test               # vitest run — 1118 tests, 31 files, happy-dom + vitest-chrome-mv3
npm run test:watch     # vitest, watch mode
npm run test:native    # python -m pytest tests/native/ — 9 tests
npm run typecheck      # tsc --noEmit — src/**, tests/js/**, vite.config.ts, vitest.config.ts
npm run lint           # eslint src/ + ruff check src/native_host/
npm run lint:js / :py  # split halves
npm run format         # prettier --write + ruff format
```

## GATES

All four must pass before a change is done:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:native
```

`npm run build` on Windows is the fifth. CI (`.github/workflows/ci.yml`, `windows-latest`,
Node 24, Python 3.x) runs lint + Prettier check + Ruff check, typecheck + build, and both
test suites.

## MANUAL VERIFICATION (Yandex first)

`browser://extensions` → reload. Per the AGENTS.md Yandex-first rule, confirm in Yandex before
Chrome:

- Extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.
- Popup header shows a connected helper (Options → Native helper lists each dependency).
- Format enumeration returns a non-empty list on YouTube, a direct MP4 page, and an HLS/M3U8 page.
- A download runs, progress ticks live in the popup, and the file opens.
- Pause / resume / cancel / retry work.
- The overlay appears on a real `<video>` and survives a hostile host page.
- `downloads.html` and `options.html` render; an Options change persists across a reload.
- The theme control switches System / Light / Dark, the choice survives a browser restart,
  and System tracks the OS setting.
- The popup resizes by dragging the right edge at 400, 460 and 720px; it rubber-bands past
  both ends and the width survives a reopen.
- `/` focuses search, arrows move the active row, `Enter` downloads, `Space` selects,
  `Esc` closes.
- The overlay's colours change with the theme after a page reload (it reads settings once;
  it is not wired to `storage.onChanged`).

## NOTES

- **`playlistId` is not `groupId`.** A pasted playlist collapses into a folder keyed on
  `DetectedVideo.playlistId` (the playlist URL, un-hashed — nothing displays it, it is
  only compared for equality by `state/playlists.ts`). `groupId` is the tempting reuse
  and it is **wrong**: `download/native.ts` reads it as the primary candidate of a
  variant (`videoId: video.groupId || video.id`, `variantId: video.id`), so a playlist id
  stamped there sends bad ids to the helper for every row of the playlist. The comment
  above `addDetectedVideo`'s `groupId` line used to claim playlist enumeration already
  stamped it; that was stale and is now corrected.
- **Playlist rows must not collapse into each other in `groupUniqueFullVideos`.** Every
  entry of one enumeration shares a `playlistId` *and* a `pageUrl` (the playlist URL), so
  `isSameFullVideo` read a whole YouTube playlist as one video: each entry is
  `youtube.com/watch?v=<id>`, whose `normalizeVideoStem` is the same `watch` for all of
  them. A 61-track paste became **one** row with 61 variants — a folder captioned
  "1 track" next to a bar counting 61 selected ids that no row could toggle. The guard is
  `areDistinctPlaylistEntries` in `shared/video_sorting.ts`; identical URLs still fold, so
  a re-detection of one track keeps its row. Do not delete it as redundant with
  `pageUrl` — the shared `pageUrl` is exactly what made the rows look like one video.
- A Spotify collection embed page carries **one** image, so it cannot be the source of
  per-track art — `spotify_metadata.apply_track_covers` upgrades each row through
  `open.spotify.com/oembed` (8 threads, no retry, no memo) and leaves the collection art
  in place whenever a lookup fails. yt-dlp's flat enumeration has no such gap: each
  entry already carries its own `thumbnails`, read by `format_list._entry_artwork`. The
  *playlist's own* cover is a separate value (`playlistThumbnailUrl`) because a
  `--flat-playlist` dump describes entries and carries nothing for the collection — for
  yt-dlp that costs one best-effort `_playlist_cover` probe, `ponytail:`-marked, whose
  deletion path is documented on the function.
- `DownloadJob.tabId` is **provenance, not a filter** (`global-downloads-spec.md` §4). It rides
  on the record and on every `downloadUpdated` broadcast so the tray row's site chip and the
  background's resume/retry can read it. **Do not delete the field and do not stop stamping
  it** — and do not reintroduce a tab filter on either read path (the boot read was
  `getAllDownloadsSorted` in `background.ts`, the live read was a guard in
  `popup_background_events.ts`; both are gone).
- The tray shows **at most `FINISHED_TRAY_LIMIT` (20) finished jobs**, with an
  "N more in All downloads" line when it truncates. Active jobs are never capped. It is a
  module-local constant in `views/DownloadsView.tsx`, **not** a `Settings` field — a number
  nobody has asked to change does not need an Options row, persistence and a test.
- `qwinDownloadsById` is pruned to the newest **200 terminal** jobs by
  `tab_state.pruneTerminalJobs()`, on a terminal transition inside `updateDownload` and once at
  service-worker startup (`load()`, which writes the map back when it actually pruned). It
  mirrors `MAX_SYNCED_ENTRIES` in `shared/download_sync.ts`. **Records only — per-row _Remove_
  is the only thing that deletes a file.** Active jobs are never candidates.
- "Source" means the **`pageUrl` host**, not the media URL's. `ui/filter.ts`'s `sourceHostOf`
  tries `pageUrl` → `sourceHost` → `url`, and `download_sync.createSyncedEntry` writes
  `sourceHost` from the same pair. The media URL is a CDN (`googlevideo.com`, a different host
  per video), which made the facet useless and contradicted the tray's chip one click away.
  Entries synced before this carry a CDN `sourceHost` and no `pageUrl`; they self-heal as jobs
  are re-synced.
- The footer's **"Clear page" clears this tab's detected videos only**. The tray's
  **"Clear finished"** in `DownloadsView` is what forgets finished job records (keeping the
  files). Both call the same background `clearDownloads` handler.
- Extension ID is pinned by the `key` field in `config/extension/manifest.chromium.json`. It
  must match `allowed_origins` in `config/native-host/com.qwin.video_downloader.chrome.json`
  and `….yandex.json`. Changing `key` breaks native messaging.
- `VideoCandidate` in `popup/state/videos.ts` carries `width`, `height`, `duration`,
  `bitrate` and `tbr`. They **were being dropped on the floor** even though `DetectedVideo`
  sent them and `VideoRow` renders them. If a future edit sees a field that looks unused,
  that is why it exists.
- `VIEW_MODES` is `["media", "downloads"]` — the "Music" _view_ is gone (D7); audio
  candidates render in Media with a purple badge. `musicMode` as a _setting_ (audio output)
  survives in `contracts.ts`. Do not confuse the two.
- `vitest.setup.ts` patches `Animation.prototype.play` to re-attach a no-op catch to
  `finished`. happy-dom **reassigns** that field where the WAAPI spec says one `Animation`
  has one, which produced unhandled `AbortError`s from `motion`'s interruption path. The
  code is correct in a real browser; the patch is a test-env workaround. Do not delete it.
- The native host was once fully broken: a deleted module left a stale import in `host.py`, so
  it crashed on the first line of work and _every_ feature was dead. `tests/native/test_host_imports.py`
  is the regression guard — it AST-scans for imports of local modules that no longer exist,
  and asserts the `handle_message` dispatch routes to real callables. **Do not delete it.**
- `src/logs/downloads.jsonl` is gitignored runtime output (see `.gitignore` — it may
  contain URLs, so it must never be committed). It is not shipped to `dist/`, and it is
  rotated to its newest 2000 lines at ~1 MB by `log_utils.maybe_rotate`. `debug.log` is
  dead — its writer was deleted in `f38e6de` — do not document it as a live log.
- The video list is **not virtualized** — and the ceiling is no longer unmeasured. `bench/`
  (a second Vite config, invisible to `npm run build` and to vitest) mounts the real
  `MediaView` inside the popup's own frame and times a playlist expansion:

  | tracks | expand: DOM build (median, spread) | then forced layout | pre-select re-render | DOM nodes | `<img>` |
  | ------ | --------------------------------- | ------------------ | -------------------- | --------- | ------- |
  | 50     | 24 ms (18–31)                     | 9 ms               | 14 ms                | 1,051     | 51      |
  | 100    | 58 ms (49–66)                     | 30 ms              | 25 ms                | 2,051     | 101     |
  | 250    | 114 ms (96–150)                   | 84 ms              | 64 ms                | 5,051     | 251     |
  | 500    | 202 ms (178–271)                  | 184 ms             | 76–107 ms            | 10,051    | 501     |

  The two time columns are sequential halves of one blocking commit — build the nodes,
  then lay them out — so the cost the user waits on is their sum: **~380 ms for a 500-track
  folder**, ~200 ms for 250, ~90 ms for 100. Every measurement is the median of 3–5 samples
  on a fresh page, because a single sample swings by 2×.

  Re-measure with `npx vite build --config bench/vite.config.ts && npx vite preview --config
  bench/vite.config.ts`, then `await qwinBench.samples(500)` in the page. Two things must
  not be lost: **measure the build, never the dev server** — the unminified dev graph
  reported 1657 ms where the built one reported 202 ms, an 8× overstatement — and **take
  several samples on a fresh page**, because a session's later reps drift upward as the
  previous trees become garbage. Both caveats are written into `bench/main.tsx`.

  **Decision: the list needs virtualization for large playlists, and it does not have it
  yet.** One frame is 16.7 ms, so ~50 rows is already at the limit, ~100 is a dropped frame
  and ~250 is a visible hitch — and the sum above is all layout-bound work, which is
  precisely what windowing removes. Do not reach for a fixed-height `translateY` window: a
  media row is 16:9-plus-text and a playlist header is a 48px tile, so the window has to
  measure rows. That work belongs in `MediaView`'s listbox rather than in the rows — see
  the `ponytail:` note in `src/popup/views/VideoRow.tsx`.
- The numbers above were taken in the Preview panel's Chromium (Electron 33 / Chrome 130,
  12 cores, headed, dpr 1) — **not** in Yandex. The extension's floor is 148, so treat them
  as an order of magnitude, not as the target browser's p99.
- `curl_cffi` TLS impersonation is still live _inside_ yt-dlp
  (`--extractor-args generic:impersonate`, `yt_dlp_command.py`), as the
  `yt-dlp[default,curl-cffi]` extra. It is not a download backend, has no probe, and is not a
  backend id anywhere. The standalone `curl_cffi_adapter.py` download backend was removed in
  `dad38be` and must not be documented.
- **The `dist/yandex` baseline is now measured: 23 files / 610 KB** (2026-10-04, after the
  redesign, the build gate and the logo). It was 18 files / 544 KB before the brand art: the
  mark ships **twice** on purpose — `assets/logo-*.png` (Vite, one copy shared by the pages
  that render it) and `icons/icon-*.png` (static, because the manifest can only point at a
  file that exists at load time). The in-app copy is the 128px cut; the 646px master is not
  committed, so regenerate it rather than shipping 390 KB for a 28px glyph. Otherwise it is
  _down_ from the old 26 files / ~610 KB despite the
  `motion` runtime dependency — the redesign deleted the popup's static chrome and collapsed
  `vite.config.ts`'s per-entry stylesheets from **six `assets/style-*.css` copies to one**
  shared `style-*.css`. Biggest items: `background.bundle.js` 188 KB, `content.bundle.js`
  136 KB, and one **85.6 KB shared chunk** (`Toolbar-*.js`) that carries Preact + the whole
  `motion` runtime and is imported by all three pages — so `motion` is paid for **once**, not
  three times. Do not "fix" the chunk's name by moving `motion` into a per-page import; that
  would triple it. One inefficiency remains: `src/shared/qwin_overlay.css` is copied into
  `dist/` although nothing references it there (the real copy is inlined into
  `content.bundle.js`).
