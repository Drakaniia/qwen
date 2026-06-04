# Troubleshooting

## Helper Not Connected

Run the installer again, then restart the browser:

```bat
cd /d C:\Users\Qwenzy\Desktop\qwin
scripts\install.bat
```

If Chrome is used, confirm the loaded extension ID is `dbjddokdmkodnkiaccmbjagfalmmmkmi`.

If Firefox is used, confirm the manifest add-on ID is `qwin-video-downloader@example.com`.

## Missing yt-dlp Or ffmpeg

Run `scripts\install.bat` again and make sure Python and `pip` are available.

The installer tries to install:

- `yt-dlp`
- `imageio-ffmpeg`
- system `ffmpeg` through `winget`, when available

If `winget` is unavailable, the helper should still use the `imageio-ffmpeg` binary installed by `pip`.

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
- Firefox extension ID `qwin-video-downloader@example.com`

If the loaded browser extension has a different ID, native messaging will be blocked.

## Browser-Only Or Blob URLs

If the popup only shows `blob:`, `data:`, or local URLs, start playback and wait a few seconds so the extension can see the underlying media requests.

Some pages never expose a reusable media URL. In that case the helper cannot download it.

## yt-dlp Errors

`yt-dlp` may fail when the site requires:

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
