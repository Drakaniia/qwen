# Project Structure And Tests

## Files

- `manifest.json` - Manifest V3 extension manifest for Chrome and Firefox.
- `src/shared/video_filters.js` - Shared media classification and ad/GIF filtering rules.
- `src/background/background.js` - Background service worker/event page that stores detected videos and manages native downloads.
- `src/content/content.js` - All-frame page scanner for video elements and performance resource entries.
- `src/popup/` - Toolbar popup HTML, CSS, and JavaScript.
- `src/native-host/` - Python native messaging host and Windows launcher.
- `config/native-host/` - Generated Chrome and Firefox native messaging manifest files.
- `scripts/install.bat` - Installs dependencies and registers the native host for Chrome and Firefox.
- `scripts/install-aria2.ps1` - Installs or verifies the portable `aria2c` fast downloader.
- `tests/extension/` - Node-based extension structure and behavior checks.
- `tests/native-host/` - Python unit tests for the native host helpers.

## Native Host Tests

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
node tests\extension\test_popup_css.js
node tests\extension\test_popup_download_view.js
node tests\extension\test_content_quality_dialog.js
```

To run every extension check file:

```powershell
Get-ChildItem tests\extension -Filter test_*.js | ForEach-Object { node $_.FullName }
```
