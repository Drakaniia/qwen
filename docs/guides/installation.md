# Installation And Browser Setup

## Install The Native Helper

1. Open Command Prompt.
2. Go to this folder:

   ```bat
   cd /d C:\Users\Qwenzy\Desktop\qwin
   ```

3. Run:

```bash
scripts/install.sh
```

4. Restart Chrome, Firefox, and Yandex Browser after the installer finishes.

## What The Installer Does

The installer:

- Finds Python 3 through `py -3` or `python`.
- Installs or updates `yt-dlp[default,curl-cffi]` with `curl-cffi` TLS impersonation support and `imageio-ffmpeg` with `pip`.
- Verifies `curl_cffi` imports correctly — if missing, shows a warning (the standalone download fallback will use standard HTTP without browser impersonation).
- Uses `winget` to install system `ffmpeg` when available.
- Falls back to the `imageio-ffmpeg` binary when system `ffmpeg` is not available.
- Installs a portable `aria2c` fast downloader under `tools\aria2` when possible.
- Installs `streamlink` with `pip` and a portable N_m3u8DL-RE fallback under `tools\n_m3u8dl-re` when possible.
- Builds browser-specific extension folders under `dist\chromium`, `dist\yandex`, and `dist\firefox`.
- Writes Chrome, Yandex Browser, and Firefox native messaging manifests under `config\native-host`.
- Registers the native host in the current user's registry keys:
  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Chromium\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Mozilla\NativeMessagingHosts\com.qwin.video_downloader`

## Load In Chrome

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select `C:\Users\Qwenzy\Desktop\qwin\dist\chromium`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

The fixed Chrome ID comes from the `key` in `manifest.json`. The native host registration depends on that exact ID.

## Load In Yandex Browser

1. Open `browser://extensions`.
2. Turn on Developer mode.
3. Click Upload unpacked extension.
4. Select `C:\Users\Qwenzy\Desktop\qwin\dist\yandex`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

Yandex Browser uses Chromium extension IDs for unpacked extensions. The installer registers the native host under the Chromium native messaging registry key and allows the same fixed extension ID as Chrome.

## Load In Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on.
3. Select `C:\Users\Qwenzy\Desktop\qwin\dist\firefox\manifest.json`.

The Firefox add-on ID is fixed in the manifest as `qwin-video-downloader@example.com`, which is what the native host allows. Temporary Firefox add-ons are removed when Firefox closes. Permanent Firefox installation requires packaging and signing the extension.

## Verify The Helper

After loading the extension, open the Qwin popup. The helper status should show one of these:

- `Helper ready (..., fast mode, stream fallbacks).` - `yt-dlp`, `ffmpeg`, `aria2c`, and at least one stream fallback are available.
- `Helper ready (..., fast mode, yt-dlp only).` - `yt-dlp`, `ffmpeg`, and `aria2c` are available, but stream fallbacks are not.
- `Helper not connected.` - run `scripts/install.sh` again and restart the browser.
