# Qwin Video Downloader — Packaging

This directory contains the build pipeline for creating a self-contained Windows installer
for Qwin Video Downloader that does not require Python, Go, or Node.js to be pre-installed
on the target machine.

## Directory Structure

```
packaging/
├── README.md                           ← This file
├── qwin-installer.iss                  ← Inno Setup installer script
├── pyinstaller.spec                    ← PyInstaller spec for qwin-host.exe
├── build-installer.ps1                 ← PowerShell build automation (Windows)
├── build-installer.sh                  ← Shell build automation (Git Bash / CI)
├── install-cdm.ps1                     ← Widevine CDM detection script (run at install time)
└── installer-source/                   ← Staging area for installer contents (gitignored)
    ├── extension/
    │   ├── chromium/                   ← Unpacked Chrome/Edge/Brave/Yandex extension
    │   └── firefox/                    ← Unpacked Firefox extension
    ├── native-host/
    │   └── qwin-host.exe               ← PyInstaller-bundled native host
    ├── tools/
    │   ├── aria2/aria2c.exe
    │   ├── n_m3u8dl-re/N_m3u8DL-RE.exe
    │   ├── capture/qwin-capture.exe
    │   ├── cdm/                        ← Widevine CDM (sourced from Chrome at install time)
    │   └── lux/lux.exe
    └── native-manifests/               ← Chrome/Firefox/Yandex JSON manifests
        ├── com.qwin.video_downloader.chrome.json
        ├── com.qwin.video_downloader.firefox.json
        └── com.qwin.video_downloader.yandex.json
```

## Build Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Windows 10/11 | ✅ | Build machine |
| Node.js 20+ | ✅ | For esbuild bundling |
| Go 1.23+ | ✅ | For qwin-capture compilation |
| Python 3.12+ | ✅ | For PyInstaller; tested with 3.14 |
| PyInstaller | `pip install pyinstaller` | Tested with 6.20.0 |
| Inno Setup 6+ | `choco install innosetup` or [jrsoftware.org](https://jrsoftware.org/isdl.php) | ISCC.exe required for installer compilation |
| curl | ✅ | For downloading tool binaries |

## Build Commands

### Full pipeline (all steps)

```powershell
# From project root:
.\packaging\build-installer.ps1
```

### Quick pipeline (skip already-built artifacts)

```powershell
# Skips PyInstaller, Go build, and tool downloads.
# Use when you've already staged the files once.
.\packaging\build-installer.ps1 -SkipPyInstaller -SkipGo -SkipTools
```

### Via npm

```bash
npm run build:installer          # full
npm run build:installer:quick    # skip PyInstaller, Go, tools
```

### With custom paths

```powershell
# If Python or Inno Setup are in non-standard locations:
.\packaging\build-installer.ps1 `
  -PythonCmd "C:\Python314\python.exe" `
  -InnoSetupPath "$env:LOCALAPPDATA\Inno Setup 6\ISCC.exe" `
  -SkipPyInstaller -SkipGo -SkipTools
```

### Individual steps

```bash
npm run build:pyinstaller        # build qwin-host.exe only
npm run build:qwin-capture       # build qwin-capture.exe only
```

### Shell (Git Bash / CI)

```bash
bash packaging/build-installer.sh
```

## Output

```
dist/
├── Qwin-Video-Downloader-v1.0.0-Setup.exe   ← Final installer (~89 MB)
```

## Installation Result

When run on a target machine, the installer places files at `%PROGRAMFILES%\Qwin\` (admin required):

| Component | Size | Description |
|---|---|---|
| `native-host\qwin-host.exe` | ~69 MB | PyInstaller bundle (yt-dlp, curl-cffi, ffmpeg, streamlink, you-get, etc.) |
| `tools\capture\qwin-capture.exe` | ~2.4 MB | Go companion binary (CDM decryption, CDP relay) |
| `tools\aria2\aria2c.exe` | ~5.4 MB | Fast segmented downloader |
| `tools\lux\lux.exe` | ~31 MB | Asian platform fallback downloader |
| `tools\n_m3u8dl-re\N_m3u8DL-RE.exe` | ~13 MB | HLS/DASH stream downloader |
| `tools\cdm\` | varies | Widevine CDM (sourced from Chrome at install time) |
| **Total installed** | **~131 MB** | |

## Notes

- **.crx signing:** Requires a .pem private key. Without it, the unpacked extension is
  staged and the user must "Load Unpacked" in `chrome://extensions` in Developer mode.
  Pass `-PemKey key.pem` to the build script when the key is available.
- **Widevine CDM:** NOT bundled in the installer due to licensing restrictions.
  At install time, `install-cdm.ps1` searches Chrome/Edge/Brave/Yandex user data
  directories and copies the CDM if found. Without it, DRM decryption is unavailable.
- **Python version:** The PyInstaller spec targets Python 3.12+. Tested with Python 3.14.2
  and PyInstaller 6.20.0.
- **Anti-virus:** PyInstaller bundles are sometimes flagged by AV software.
  Digital signing of `qwin-host.exe` and the installer is recommended for distribution.
- **Installer size:** ~89 MB compressed; ~131 MB installed.
