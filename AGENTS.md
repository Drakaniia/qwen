# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Build and Test

Always rebuild before running extension tests — they depend on `dist/`:

```powershell
npm run build          # builds chromium, firefox, yandex targets under dist/
npm test               # runs native-host unittest, extension checks, and build checks
npm run test:native    # Python unittest only (no build required)
npm run test:extension # JS extension checks only (requires prior build)
npm run test:build     # runs build script as a validation check
```

Single extension test file:

```bat
node tests\extension\test_video_filters.js
```

Single native-host test file:

```bat
python -m unittest tests.native-host.test_host
```

## Code Style

- Use 2-space indentation in JavaScript and CSS.
- Use 4-space indentation in Python.
- Prefer plain JS (no build step, no transpiler, no bundler). The extension loads raw `.js` files.
- Shared JS contracts between the extension and content scripts live in `src/shared/`. The Python native host mirrors some of these in `src/native-host/` — keep both sides in sync.

## Lint and Format

```powershell
npm run lint           # ESLint (JS) + Ruff check (Python)
npm run lint:fix       # auto-fix lint issues
npm run format         # Prettier (JS/CSS/JSON) + Ruff format (Python)
npm run format:js      # Prettier only
npm run format:py      # Ruff format only
```

Git pre-commit hook (`.githooks/pre-commit`) runs Prettier check, Ruff lint, Ruff format check, and ESLint on staged files before each commit.

## Commit and Branch Conventions

Use conventional commits with a scope:

```
feat(popup): add download availability indicator
fix(background): handle retry timeout correctly
refactor(native): extract host dispatch module
test(extension): add video picker test
build: register shared components in extension manifests
```

Branch naming: `type/description` (e.g., `feat/download-retry`, `fix/popup-refresh`).

## Non-Obvious Rules

- **Rebuild dist after src changes**: the browser loads `dist/<target>/src/`, not `src/` directly. After editing any file under `src/`, run `npm run build` (or `npm run build:chromium` for just one target) before testing or loading the extension.
- **Windows-only**: all scripts are PowerShell (`.ps1`) or batch (`.bat`). Do not assume bash/unix tools are available.
- **Linting and formatting**: `npm run lint` checks JS (ESLint) and Python (Ruff). `npm run format` formats JS/CSS/JSON (Prettier) and Python (Ruff). A git pre-commit hook in `.githooks/` runs these checks automatically on staged files. The hooks path is set via `git config core.hooksPath .githooks`.
- **No package manager lock file**: there is no `package-lock.json` or `yarn.lock`. Node is used only to run test scripts — dev dependencies (eslint, prettier, globals) are installed via `npm install`.
- **Manifest templates** are in `config/extension/` and copied into `dist/<target>/manifest.json` by the build script. Edit the templates, not the dist output.
