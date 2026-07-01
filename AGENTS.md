# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-01
**Commit:** 56f6942
**Branch:** main

## OVERVIEW

Qwin Video Downloader — multi-browser extension (Chrome/Firefox/Yandex) + Python native host + Go CDM binary for detecting and downloading videos with Widevine DRM decryption.

## STRUCTURE

```
qwin/
├── AGENTS.md              # This file
├── knowledge.md            # Project knowledge (architecture, conventions)
├── manifest.json           # Root manifest (npm project)
├── package.json            # npm scripts + dev dependencies
├── eslint.config.js        # ESLint flat config
├── ruff.toml               # Ruff Python linter config
├── .prettierrc             # Prettier config
├── src/background/         # Service worker: download orchestration, CDM, CDP
├── src/content/            # Content scripts: video/page detection, MSE intercept
├── src/native_host/        # Python native messaging host (yt-dlp, aria2, ffmpeg)
│   └── fallback_engines/   # Gallery-dl, lux, you-get wrappers
├── src/popup/              # Popup UI (HTML + CSS + JS modules)
├── src/shared/             # Shared JS contracts across extension components
├── go/                     # Go companion binary (qwin-capture)
├── config/                 # Extension manifests per browser + native host configs
├── docs/                   # Guides, legal docs, reference specs
├── tests/                  # Extension JS tests + native-host Python tests
├── scripts/                # Build, install, packaging scripts
├── .agents/                # AI agent skills and configurations
└── packaging/              # Installer source (NSIS, PyInstaller, bundle scripts)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| **Download orchestration** | `src/background/download_orchestration.js` | Coordinates native host, fallbacks, queue |
| **CDM / Widevine** | `go/cdm.go`, `go/decrypt.go` | Go binary; also `src/background/cdm_*` |
| **CDP relay** | `go/cdp_relay_test.go`, `src/background/cdp_relay.js` | Chrome DevTools Protocol bridge |
| **Native host dispatch** | `src/native_host/host.py` + `host_dispatch.py` | Entry point + command routing |
| **yt-dlp integration** | `src/native_host/yt_dlp_adapter.py` | yt-dlp wrapper with large file handling |
| **Popup UI** | `src/popup/popup.html` + `src/popup/popup.js` | Single-file HTML entry, modular JS |
| **Shared contracts** | `src/shared/media_candidates.js`, `video_filters.js` | Both sides must stay in sync |
| **Filter lists** | `src/shared/filter_list_*.js` | Video source block/allow patterns |
| **Build/packaging** | `scripts/build-extension.ps1` | Creates dist/ targets |
| **Extension tests** | `tests/extension/background/` | Run after build |
| **Native host tests** | `tests/native-host/` | Python unittest, no build needed |

## CONVENTIONS (DEVIATIONS FROM STANDARD)

- **No package manager lockfile**: no `package-lock.json` or `yarn.lock`. npm used only for dev tooling.
- **Manifest V3 templates** in `config/extension/` — edit templates, not `dist/` output.
- **Rebuild after src changes**: browser loads `dist/<target>/src/`, not `src/` directly.
- **Windows-only infra**: all scripts are PowerShell (`.ps1`) or batch (`.bat`/`.bat`). No bash assumptions.
- **Go binary** communicates via native messaging framing (4-byte LE length prefix + UTF-8 JSON).
- **Python native host** registered via Windows Registry under `HKCU\Software\{Browser}\NativeMessagingHosts\com.qwin.video_downloader`.

## ANTI-PATTERNS (THIS PROJECT)

- **No global npm packages** — use `npm run setup` instead.
- **No editing dist/ directly** — edit src/ and rebuild.
- **No yarn/pnpm** — the project uses npm.
- **No cross-tab pollution** — download list scoped to active tab.
- **No generic YouTube downloaders** — uses yt-dlp with specific flags for quality selection.
- **No bundling content scripts** — loaded as raw `.js` files.

## UNIQUE STYLES

- **JS**: 2-space indent, trailing commas, double quotes, ES modules, esbuild bundling.
- **Python**: 4-space indent, ruff (E/F/W/I), 120 chars. First-party imports listed in `ruff.toml`.
- **Go**: Standard gofmt. Companion binary with IPC loop.
- **Conventional commits** with scopes: `feat(popup):`, `fix(background):`, `refactor(native):`, `test(extension):`, `build:`.

## COMMANDS

```powershell
npm run setup          # Install deps, native host, aria2, gopeed, CDM
npm run build          # Build chromium, firefox, yandex targets under dist/
npm test               # native-host unittest + extension checks + build checks
npm run test:native    # Python unittest only (no build required)
npm run test:extension # JS extension checks only (requires prior build)
npm run lint           # ESLint (JS) + Ruff check (Python)
npm run format         # Prettier (JS/CSS/JSON) + Ruff format (Python)
```

## NOTES

- Extension ID (Chrome): `dbjddokdmkodnkiaccmbjagfalmmmkmi` — must match native host manifest `allowed_origins`.
- Pre-commit hook in `.githooks/` runs lints/format on staged files.
- Troubleshooting skills available: `@failed-download-troubleshooting`, `@chrome-extension-development`.
