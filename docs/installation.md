# Installation And Browser Setup

## Install The Native Helper

1. Open Command Prompt.
2. Go to this folder:

   ```bat
   cd /d C:\Users\Qwenzy\Desktop\qwin
   ```

3. Run:

   ```bat
   scripts\install.bat
   ```

4. Restart Chrome, Firefox, and Yandex Browser after the installer finishes.

## What The Installer Does

The installer:

- Finds Python 3 through `py -3` or `python`.
- Installs or updates `yt-dlp` and `imageio-ffmpeg` with `pip`.
- Uses `winget` to install system `ffmpeg` when available.
- Falls back to the `imageio-ffmpeg` binary when system `ffmpeg` is not available.
- Installs a portable `aria2c` fast downloader under `tools\aria2` when possible.
- Writes Chrome, Yandex Browser, and Firefox native messaging manifests under `config\native-host`.
- Registers the native host in the current user's registry keys:
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Chromium\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Mozilla\NativeMessagingHosts\com.qwin.video_downloader`

## Load In Chrome

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select `C:\Users\Qwenzy\Desktop\qwin`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

The fixed Chrome ID comes from the `key` in `manifest.json`. The native host registration depends on that exact ID.

## Load In Yandex Browser

1. Open `browser://extensions`.
2. Turn on Developer mode.
3. Click Upload unpacked extension.
4. Select `C:\Users\Qwenzy\Desktop\qwin`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

Yandex Browser uses Chromium extension IDs for unpacked extensions. The installer registers the native host under the Chromium native messaging registry key and allows the same fixed extension ID as Chrome.

## Load In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on.
3. Select `C:\Users\Qwenzy\Desktop\qwin\manifest.json`.

The Firefox add-on ID is fixed in the manifest as `qwin-video-downloader@example.com`, which is what the native host allows. Temporary Firefox add-ons are removed when Firefox closes. Permanent Firefox installation requires packaging and signing the extension.

## Verify The Helper

After loading the extension, open the Qwin popup. The helper status should show one of these:

- `Helper ready (..., fast mode).` - `yt-dlp`, `ffmpeg`, and `aria2c` are available.
- `Helper ready (..., standard mode).` - `yt-dlp` and `ffmpeg` are available, but `aria2c` is not.
- `Helper not connected.` - run `scripts\install.bat` again and restart the browser.

Fast mode is optional. Standard mode can still download supported videos.
