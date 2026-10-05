# Release Notes

> Template for GitHub Releases. Copy the sections you need into the release body and delete
> the rest. The CI badge at the top of the README is the only automation attached to this
> file — there is no release workflow and no installer artifact.

## What's Changed

### Features

- <!-- Add new features here -->

### Bug Fixes

- <!-- Add bug fixes here -->

### Improvements

- <!-- Add improvements and optimizations here -->

### Documentation

- <!-- Add documentation changes here -->

## Before Tagging

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:native` and `npm run build`
  all pass locally (CI runs the same set).
- `config/extension/manifest.chromium.json` has the new `version`.
- The extension has been loaded from `dist/yandex` and exercised manually — detection,
  format enumeration, a download, and the Downloads and Options pages.
- Anything the change removed has also been removed from `README.md`, `docs/` and
  `AGENTS.md`. The docs in this repository are expected to be true.

## Install

There is no packaged installer. To install a release, follow
[Installation Guide](installation.md): run `npm run setup`, then load `dist/yandex` (Yandex) or
`dist/chromium` (Chrome and other Chromium forks) as an unpacked extension.

## Full Changelog

https://github.com/qwin-video-downloader/qwin/compare/v...v
