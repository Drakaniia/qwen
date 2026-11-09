#!/usr/bin/env python3
import os
import sys
from pathlib import Path

_host_dir = Path(__file__).resolve().parent
# os.walk, not Path.walk: Path.walk is 3.12+, and the project targets 3.11 (ruff.toml).
for _root, _dirs, _files in os.walk(_host_dir):
    _dirs[:] = [d for d in _dirs if d != "__pycache__" and not d.startswith("_")]
    _path = str(_root)
    if _path not in sys.path:
        sys.path.insert(0, _path)

# These imports are load-bearing: importing a module runs its @register_handler
# decorators. They must stay below the sys.path walk above.
import artifacts  # noqa: I001,F401
import download_manager as _download_manager  # noqa: F401
import download_task as _download_task  # noqa: F401
import format_list as _format_list  # noqa: F401
import folder_picker  # noqa: F401
import media_probe as _media_probe  # noqa: F401
import media_resolver as _media_resolver  # noqa: F401
import process_control as _process_control
import thumbnail_frame as _thumbnail_frame  # noqa: F401
from native_protocol import (
    HostError,
    configure_binary_stdio,
    error_response,
    pong_response,
    read_native_message,
    request_id,
    request_type,
    send_native_message,
    unexpected_error_response,
)
from registry import (
    HANDLERS,
    register_handler,
)
from yt_dlp_dependencies import (
    has_aria2c,
    has_ffmpeg,
    has_n_m3u8dl_re,
    has_streamlink,
    has_yt_dlp,
)

DownloadTask = _download_task.DownloadTask
creation_flags = _process_control.creation_flags
extract_media_candidates_from_text = _media_resolver.extract_media_candidates_from_text

HOST_VERSION = "1.0.0"


# --- Registered handlers -----------------------------------------------------
# @register_handler runs at import time, so HANDLERS is only as complete as the
# imports above. Each of those modules owns the message types it dispatches:
#   download_manager -> download, pause, resume, cancel
#   format_list      -> formats, enumeratePlaylist
#   media_probe      -> probeMediaUrls
#   media_resolver   -> resolveMediaCandidates
#   thumbnail_frame  -> thumbnailFrame
#   artifacts        -> openFile, showFile, deleteArtifacts
#   folder_picker    -> chooseFolder
#   host (below)     -> ping
# Adding a message type = writing one decorated function in any module under
# src/native_host/ and making sure host.py imports it. Never edit handle_message.
# tests/native/test_host_imports.py enforces both halves of that sentence.


@register_handler("ping")
def handle_ping(message):
    send_native_message(pong_response(message, HOST_VERSION, dependency_status()))


def dependency_status():
    return {
        "ytDlp": has_yt_dlp(),
        "ffmpeg": has_ffmpeg(),
        "aria2c": has_aria2c(),
        "nM3u8DlRe": has_n_m3u8dl_re(),
        "streamlink": has_streamlink(),
    }


def handle_message(message):
    message_type = request_type(message)
    handler = HANDLERS.get(message_type)
    if handler is None:
        raise HostError(f"Unknown native host request type: {message_type}")
    return handler(message)


def main():
    configure_binary_stdio()
    while True:
        try:
            message = read_native_message()
        except EOFError:
            # The browser closed the port. Nothing can read our progress any more, and
            # a downloader left running would race the resumed job the extension offers
            # for this interruption, so stop every task -- partial files are kept.
            _download_manager.shutdown_all_downloads()
            return 0
        except Exception as exc:
            print(f"Native messaging protocol error: {exc}", file=sys.stderr)
            return 1

        request_id_value = request_id(message)

        try:
            handle_message(message)
        except HostError as exc:
            send_native_message(error_response(request_id_value, exc))
        except Exception as exc:
            print(f"Unhandled host error: {exc}", file=sys.stderr)
            send_native_message(unexpected_error_response(request_id_value, exc))


if __name__ == "__main__":
    raise SystemExit(main())
