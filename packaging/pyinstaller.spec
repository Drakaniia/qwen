# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Qwin Video Downloader — Native Messaging Host.

Builds a single-file Windows executable from src/native_host/host.py
that includes all Python dependencies (yt-dlp, curl-cffi, imageio-ffmpeg,
streamlink, you-get, certifi, brotli).

Usage:
    pyinstaller packaging/pyinstaller.spec
"""

import sys
from pathlib import Path

# SPECPATH is automatically defined by PyInstaller as the directory containing
# this spec file (e.g., /path/to/project/packaging/).
# Project root is one level up: /path/to/project/
ROOT_DIR = Path(SPECPATH).resolve().parent if not Path(SPECPATH).is_dir() else Path(SPECPATH).resolve().parent
SRC_NATIVE_HOST = ROOT_DIR / "src" / "native_host"

# ── Collect all source files from native_host ─────────────────────────────
# PyInstaller needs all .py files from the native_host directory tree
# because some modules are dynamically imported (e.g., fallback_engines).
native_host_files = []
for f in sorted(SRC_NATIVE_HOST.rglob("*")):
    if f.suffix in {".py"} and "__pycache__" not in f.parts:
        # Preserve relative path from 'src/native_host/'
        relative = f.relative_to(SRC_NATIVE_HOST.parent)
        native_host_files.append((str(f), str(relative.parent)))

# ── Hidden imports ─────────────────────────────────────────────────────────
# These are dynamically imported (e.g., via importlib, __import__, or
# string-based imports) and PyInstaller won't detect them automatically.

hidden_imports = [
    # yt-dlp and its sub-packages
    "yt_dlp",
    "yt_dlp.extractor",
    "yt_dlp.downloader",
    "yt_dlp.postprocessor",
    "yt_dlp.extractor._extractors",
    # curl-cffi (TLS impersonation)
    "curl_cffi",
    "curl_cffi.requests",
    "curl_cffi.curl",
    # Stream backends
    "streamlink",
    "streamlink_cli",
    # Other pip packages
    "you_get",
    "certifi",
    "brotli",
    "imageio_ffmpeg",
    # Fallback engines (imported by name at runtime)
    "fallback_engines",
    "fallback_engines.direct_download",
    "fallback_engines.gallery_dl_engine",
    "fallback_engines.helpers",
    "fallback_engines.lux_engine",
    "fallback_engines.you_get_engine",
]

# ── Exclusions ──────────────────────────────────────────────────────────────
# Exclude large unnecessary modules. Keep excludes minimal to avoid conflicts
# with dependency imports (e.g., distutils is needed by some packages).
excludes = [
    "tkinter",
    "test",
    "unittest",
    "idlelib",
    "turtle",
    "pydoc",
    "lib2to3",
    "http.server",
    "asyncio",
]

block_cipher = None

a = Analysis(
    [str(SRC_NATIVE_HOST / "host.py")],
    pathex=[str(ROOT_DIR), str(SRC_NATIVE_HOST)],
    binaries=[],
    datas=native_host_files,  # All .py files from native_host/ tree
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="qwin-host",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # Set to True and install UPX to reduce size; may cause AV flags
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # No visible window (native messaging uses stdin/stdout)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,  # Optional: path to .ico file
)
