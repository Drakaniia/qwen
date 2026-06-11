# Project Structure And Tests

## Files

- `manifest.json` - Chromium/Yandex Manifest V3 development manifest.
- `config/extension/` - Browser-specific extension manifest templates.
- `dist/` - Generated browser-specific extension folders; ignored by git.
- `src/shared/media_candidates.js` - Shared extension-side media URL classification and downloadability contract.
- `src/shared/video_filters.js` - Shared video filtering, grouping, display, and full-length candidate rules.
- `src/background/background.js` - Background service worker/event page that wires browser events, state, and message routing.
- `src/background/download_orchestration.js` - Download lifecycle module for native download start, retry, pause, resume, cancel, remove, and clear flows.
- `src/content/page_detection.js` - Content-side candidate construction, URL normalization, YouTube/page fallback detection, and text scanning.
- `src/content/content.js` - Content-script entry point for page scanning schedules, video overlays, and quality/download interaction.
- `src/popup/` - Toolbar popup HTML, CSS, and JavaScript.
- `src/native-host/` - Python native messaging host, runtime dispatch, helper modules, and Windows launcher.
- `src/native-host/media_candidates.py` - Native-host media URL classification and resolver reuse contract.
- `src/native-host/host_dispatch.py` - Native-host message dispatch and main-loop module.
- `config/native-host/` - Generated Chrome, Yandex Browser, and Firefox native messaging manifest files.
- `scripts/install.bat` - Installs dependencies and registers the native host for Chrome, Yandex Browser, and Firefox.
- `scripts/install-aria2.ps1` - Installs or verifies the portable `aria2c` fast downloader.
- `scripts/install-stream-fallbacks.ps1` - Installs or verifies Streamlink and the portable N_m3u8DL-RE stream fallback downloader.
- `scripts/build-extension.ps1` - Builds loadable Chromium, Yandex Browser, and Firefox extension folders under `dist`.
- `scripts/test.ps1` - Runs native-host tests, extension checks, and extension build checks.
- `tests/extension/` - Node-based extension structure and behavior checks.
- `tests/native-host/` - Python unit tests for the native host helpers.

## Native Host Tests

Run every test and build generated extension folders:

```powershell
scripts\test.ps1
```

Run:

```bat
python -m unittest discover -s tests\native-host -p test_*.py
```

The native launcher prefers `py -3`, so this is also useful when available:

```bat
py -3 -m unittest discover -s tests\native-host -p test_*.py
```

## Extension Checks

Run:

```bat
node tests\extension\test_video_filters.js
node tests\extension\test_background_download_controls.js
node tests\extension\test_yandex_browser_support.js
node tests\extension\test_popup_css.js
node tests\extension\test_popup_download_view.js
node tests\extension\test_content_quality_dialog.js
node tests\extension\test_background_download_state.js
node tests\extension\test_manifest_build_targets.js
node tests\extension\test_project_automation.js
node tests\extension\test_quality_format.js
```

To run every extension check file:

```powershell
Get-ChildItem tests\extension -Filter test_*.js | ForEach-Object { node $_.FullName }
```
