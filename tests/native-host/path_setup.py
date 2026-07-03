"""path_setup — Add src/native_host subdirectories to sys.path for tests.

Exports
-------
ROOT_DIR : Path
    Absolute path to the project root (qwin/).  Tests that need to locate
    fixture files under tests/fixtures/ can import this directly::

        from path_setup import ROOT_DIR

Import this module (``import path_setup``) at the top of every native-host
test file so that modules spread across the native_host subdirectory tree
can be imported by their bare name (e.g. ``from download_logger import …``).

Layout of src/native_host/:
    backends/       curl_cffi_adapter, gopeed_adapter, stream_backends …
    backends/yt_dlp/  yt_dlp_command, yt_dlp_adapter …
    codec/          fix_mp4_codec; also exposes codec.fmp4 package
    download/       download_logger, download_manager, download_task, progress_parser
    fallback_engines/  gallery-dl, lux, you-get, download_direct
    media/          capture_manager, cdm_capture, media_candidates, media_resolver
    probe/          probe_runner, probe_backends, probe_types
    system/         native_paths, native_protocol
    host.py / host_dispatch.py (root of native_host)
"""

import sys
from pathlib import Path

# ── Public exports ─────────────────────────────────────────────────────────
ROOT_DIR: Path = Path(__file__).resolve().parents[2]  # …/qwin/
_NATIVE_HOST = ROOT_DIR / "src" / "native_host"

_PATHS = [
    _NATIVE_HOST,                          # host.py, host_dispatch.py
    _NATIVE_HOST / "backends",             # curl_cffi_adapter, gopeed_adapter, stream_backends
    _NATIVE_HOST / "backends" / "yt_dlp", # yt_dlp_command, yt_dlp_adapter
    _NATIVE_HOST / "codec",               # fix_mp4_codec; codec package via parent
    _NATIVE_HOST / "download",            # download_logger, download_manager, download_task, progress_parser
    _NATIVE_HOST / "fallback_engines",    # gallery-dl, lux, you-get, download_direct helpers
    _NATIVE_HOST / "media",               # capture_manager, cdm_capture, media_candidates, media_resolver
    _NATIVE_HOST / "probe",               # probe_runner, probe_backends, probe_types
    _NATIVE_HOST / "system",              # native_paths, native_protocol
]

for _p in _PATHS:
    _s = str(_p)
    if _s not in sys.path:
        sys.path.insert(0, _s)
