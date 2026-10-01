# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-10
**Branch:** main

> ⚡ **PRIMARY BROWSER: Yandex** — All development, debugging, and testing targets Yandex Browser first.
> Chrome/Chromium are secondary; only test there after Yandex is confirmed working.
> Extension ID for Yandex: `dbjddokdmkodnkiaccmbjagfalmmmkmi`

## OVERVIEW

Qwin Video Downloader — multi-browser extension (Chrome/Firefox/Yandex) + Python native host for detecting and downloading videos using `yt-dlp`, `aria2c`, and `ffmpeg`.

## STRUCTURE

```
qwin/
├── AGENTS.md              # This file
├── package.json            # npm scripts + dev dependencies
├── eslint.config.js        # ESLint flat config
├── ruff.toml               # Ruff Python linter config
├── .prettierrc             # Prettier config
├── src/background/         # Service worker: download orchestration, network interception
├── src/content/            # Content scripts: video/page detection, overlay
├── src/native_host/        # Python native messaging host (yt-dlp, aria2, ffmpeg)
├── src/popup/              # Popup UI (HTML + CSS + JS modules)
├── src/shared/             # Shared JS contracts across extension components
├── config/                 # Extension manifests per browser + native host configs
├── docs/                   # Guides and reference docs
├── scripts/                # Build, install scripts
└── .agents/                # AI agent skills and configurations
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| **Download orchestration** | `src/background/download/` | Coordinates native host, fallbacks, browser download |
| **Network interception** | `src/background/background_webrequest.js` | Detects video URLs via webRequest |
| **Content detection** | `src/content/content.js`, `page_detection.js` | Scans DOM for video elements |
| **Native host dispatch** | `src/native_host/host.py` | Entry point + command routing |
| **yt-dlp integration** | `src/native_host/backends/yt_dlp/` | Command building + binary resolution |
| **Popup UI** | `src/popup/popup.html` + `src/popup/popup.js` | Single-file HTML entry, modular JS |
| **Shared contracts** | `src/shared/media_candidates.js`, `video_filters.js` | Both sides must stay in sync |
| **Filter lists** | `src/shared/filter_list_*.js` | Video source block/allow patterns |
| **Build/packaging** | `scripts/build-extension.ps1` | Creates dist/ targets |

## CONVENTIONS (DEVIATIONS FROM STANDARD)

- **No package manager lockfile**: no `package-lock.json` or `yarn.lock`. npm used only for dev tooling.
- **Manifest V3 templates** in `config/extension/` — edit templates, not `dist/` output.
- **Rebuild after src changes**: browser loads `dist/<target>/src/`, not `src/` directly.
- **Windows-only infra**: all scripts are PowerShell (`.ps1`) or batch (`.bat`). No bash assumptions.
- **Python native host** registered via Windows Registry under `HKCU\\Software\\{Browser}\\NativeMessagingHosts\\com.qwin.video_downloader`.

## ANTI-PATTERNS (THIS PROJECT)

- **No global npm packages** — use `npm run setup` instead.
- **No editing dist/ directly** — edit src/ and rebuild.
- **No yarn/pnpm** — the project uses npm.
- **No cross-tab pollution** — download list scoped to active tab.
- **No bundling content scripts** — loaded as raw `.js` files.

## UNIQUE STYLES

- **JS**: 2-space indent, trailing commas, double quotes, ES modules, esbuild bundling.
- **Python**: 4-space indent, ruff (E/F/W/I), 120 chars.
- **Conventional commits** with scopes: `feat(popup):`, `fix(background):`, `refactor(native):`, `test(extension):`, `build:`.

## COMMANDS

```powershell
npm run setup          # Install deps, native host, build
npm run build          # Build chromium, firefox, yandex targets under dist/
npm run lint           # ESLint (JS) + Ruff check (Python)
npm run format         # Prettier (JS/CSS/JSON) + Ruff format (Python)
```

## NOTES

- Extension ID (Yandex/Chrome): `dbjddokdmkodnkiaccmbjagfalmmmkmi` — must match native host manifest `allowed_origins`
