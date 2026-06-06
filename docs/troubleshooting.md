# Troubleshooting

## Helper Not Connected

Run the installer again, then restart the browser:

```bat
cd /d C:\Users\Qwenzy\Desktop\qwin
scripts\install.bat
```

If Chrome is used, confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

If Yandex Browser is used, confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

If Firefox is used, confirm the manifest add-on ID is `qwin-video-downloader@example.com`.

## Missing yt-dlp Or ffmpeg

Run `scripts\install.bat` again and make sure Python and `pip` are available.

The installer tries to install:

- `yt-dlp` with `curl-cffi` impersonation support
- `imageio-ffmpeg`
- `streamlink`
- system `ffmpeg` through `winget`, when available
- portable `N_m3u8DL-RE.exe`

If `winget` is unavailable, the helper should still use the `imageio-ffmpeg` binary installed by `pip`.

## Missing Stream Fallbacks

If the popup says `yt-dlp only`, run `scripts\install.bat` again. Check:

- `tools\n_m3u8dl-re\N_m3u8DL-RE.exe` exists, or set `QWIN_N_M3U8DL_RE` to a valid executable path.
- `streamlink` is installed for the Python used by the native host.

Downloads can still work without these tools. They only add best-effort fallbacks for accessible HLS, DASH, and Smooth Streaming manifests.

## Standard Mode Instead Of Fast Mode

`standard mode` means `aria2c` was not found. Downloads can still work, but fast segmented mode is unavailable.

To fix it:

1. Run `scripts\install.bat` again.
2. Check that `tools\aria2\aria2c.exe` exists.
3. Or set `QWIN_ARIA2C` to a valid `aria2c.exe` path before starting the browser.

## Access To Native Host Is Forbidden

Reload the extension and re-run `scripts\install.bat`.

The native host only allows:

- Chrome extension ID `dbjddokdmkodnkiaccmbjagfalmmmkmi`
- Yandex Browser extension ID `dbjddokdmkodnkiaccmbjagfalmmmkmi`
- Firefox extension ID `qwin-video-downloader@example.com`

If the loaded browser extension has a different ID, native messaging will be blocked.

## Browser-Only Or Blob URLs

If the popup only shows `blob:`, `data:`, or local URLs, start playback and wait a few seconds so the extension can see the underlying media requests or a supported extractor page. On YouTube watch/embed/shorts pages, Qwin should list the YouTube page itself instead of the temporary `googlevideo.com` playback URL.

Some pages never expose a reusable media URL. In that case the helper cannot download it.

## Manual Link Fails

The settings-panel link box sends the pasted URL to `yt-dlp` first, then may use stream fallbacks for supported manifest URLs. If all tools fail, the most common causes are:

- The installed `yt-dlp` version does not support that site or URL shape.
- The video needs login, age, region, app-only, or bot-check access that the helper cannot reproduce.
- The video is DRM-protected or otherwise encrypted.
- The site blocked the request from the helper even though browser playback still works.

For YouTube, Qwin enables yt-dlp's EJS challenge helper with `--remote-components ejs:github`. The first YouTube extraction may download yt-dlp's solver script from GitHub. If GitHub or the JavaScript runtime is blocked on the machine, YouTube may still return only storyboard/image formats.

## Cloudflare Anti-Bot Challenge

If yt-dlp reports `Got HTTP Error 403 caused by Cloudflare anti-bot challenge`, run `scripts\install.bat` again. Qwin passes yt-dlp `--extractor-args generic:impersonate`, and the installer adds yt-dlp's `curl-cffi` dependency so those impersonation targets are available.

This is still best-effort. It can help with some generic Cloudflare challenges, but it cannot bypass DRM, private login access, region blocking, or challenges that require an interactive browser session.

## Helper Download Errors

`yt-dlp`, N_m3u8DL-RE, or Streamlink may fail when the site requires:

- DRM decryption.
- A login session the helper cannot reproduce.
- Short-lived private tokens.
- Site-specific extraction that is not available from the detected URL alone.
- Headers or cookies that were not captured by the extension.

## Slow Downloads

Slow downloads usually mean one of these is the bottleneck:

- The video host or CDN is throttling.
- The server does not allow multiple connections.
- The stream format cannot resume or segment efficiently.
- VPN, Wi-Fi, or routing is slowing the connection.
- Disk writes are slow or the destination drive is nearly full.

Fast mode can help only when the source server allows it.

## Many Short Clips In The Popup

Reload the extension and reload the webpage. The current build cleans old stored fragment detections on startup and filters new HLS/DASH segment URLs.
