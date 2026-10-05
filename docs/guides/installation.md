# Installation And Browser Setup

## Install The Native Helper

1. Open **Git Bash** (ships with Git for Windows) and go to the project root:

   ```bash
   cd /c/Users/Qwenzy/Desktop/qwin
   ```

   Or, from Command Prompt:

   ```bat
   cd /d C:\Users\Qwenzy\Desktop\qwin
   npm run setup
   ```

2. Run the installer:

   ```bash
   npm run setup
   ```

3. Restart your browser when it finishes.

`npm run setup` is a thin wrapper: it calls `scripts/install.sh` through
`C:\Program Files\Git\bin\bash.exe`. Running the script directly (`bash scripts/install.sh`)
does the same thing.

## What The Installer Does

The installer:

- Finds Python 3 through `py -3`, `python3` or `python`, and warns if `pip` is missing.
- Installs or updates `yt-dlp[default,curl-cffi]`, `imageio-ffmpeg` and `certifi` with `pip`.
  The `curl-cffi` extra is what lets yt-dlp impersonate a browser TLS fingerprint
  (`--extractor-args generic:impersonate`) when extracting from generic sites.
- Installs `streamlink` with `pip`.
- Uses `winget` to install system `ffmpeg` (`Gyan.FFmpeg`) when available, and otherwise
  relies on the `imageio-ffmpeg` binary that `pip` installed.
- Downloads `aria2c.exe` into `tools\aria2` from the aria2 GitHub release. Downloads can run
  without it, but fast segmented mode does not.
- Downloads `N_m3u8DL-RE.exe` into `tools\n_m3u8dl-re` from its GitHub release.
- Runs `scripts\build-extension.ps1 -Target all`, producing `dist\chromium` and `dist\yandex`.
- Writes two native messaging manifests to `config\native-host\`:
  `com.qwin.video_downloader.chrome.json` and `com.qwin.video_downloader.yandex.json`.
- Registers the native host under these registry keys, pointing at the Chrome manifest for
  the Google forks and the Yandex manifest for Chromium and Yandex:

  - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Chromium\NativeMessagingHosts\com.qwin.video_downloader`
  - `HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\com.qwin.video_downloader`

Both manifests allow exactly one origin: `chrome-extension://dbjddokdmkodnkiaccmbjagfalmmmkmi/`.

> **Firefox is not supported.** There is no Firefox manifest, no `dist/firefox` build target
> and no Firefox registry registration. The extension is Chromium-only.

## Load In Yandex Browser (primary)

1. Open `browser://extensions`.
2. Turn on Developer mode.
3. Click Upload unpacked extension.
4. Select `C:\Users\Qwenzy\Desktop\qwin\dist\yandex`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

Yandex Browser is Chromium-based and uses Chromium extension IDs for unpacked extensions, so
the same fixed ID applies as in Chrome. Yandex 26.x is Chromium 150, comfortably above the
extension's `minimum_chrome_version: "148"`.

## Load In Chrome / Chromium / Edge / Brave

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select `C:\Users\Qwenzy\Desktop\qwin\dist\chromium`.
5. Confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

The fixed ID comes from the `key` field in `config\extension\manifest.chromium.json`, which
the build copies to `dist\<target>\manifest.json`. Native messaging registration depends on
that exact ID, so changing `key` breaks the helper.

`scripts\load-extension.ps1` restarts Yandex with `dist\yandex` pre-loaded, if that is quicker
than clicking through the UI.

## Verify The Helper

Open the Qwin popup. The line under the title should show one of:

- `Helper ready (<version>, fast mode, stream fallbacks).` — `yt-dlp`, `ffmpeg`, `aria2c` and
  at least one stream fallback are available.
- `Helper ready (<version>, fast mode, yt-dlp only).` — `yt-dlp`, `ffmpeg` and `aria2c` are
  available but the stream fallbacks are not.
- `Helper ready, some tools missing.` — something the helper needs is absent; the popup shows
  a banner listing what.
- `Helper not connected.` — the native host did not answer. Run `scripts/install.sh` again and
  restart the browser.

The **Options** page (opened from the popup's header gear) lists each dependency individually,
so you can see exactly which tool is missing.
