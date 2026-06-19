import sys
from types import SimpleNamespace


def dependency_status(deps):
    status = {
        "ytDlp": deps.has_yt_dlp(),
        "ffmpeg": deps.has_ffmpeg(),
        "aria2c": deps.has_aria2c(),
        "nM3u8DlRe": deps.has_n_m3u8dl_re(),
        "streamlink": deps.has_streamlink(),
    }
    # Add capture binary status from the capture manager (may not be available yet)
    try:
        cap_status = deps.capture_status() if hasattr(deps, "capture_status") else {}
        status["cdmCapture"] = cap_status.get("cdmAvailable", False) if cap_status else False
        if cap_status:
            status["recording"] = cap_status.get("captureReady", False)
        elif hasattr(deps, "has_capture_binary"):
            status["recording"] = deps.has_capture_binary()
        else:
            status["recording"] = False
    except Exception:
        status["cdmCapture"] = False
        status["recording"] = False
    return status


def handle_message(message, deps):
    message_type = deps.request_type(message)

    match message_type:
        case "ping":
            deps.send_native_message(deps.pong_response(message, deps.host_version, deps.dependency_status()))
        case "download":
            deps.run_download(message)
        case "magnet":
            deps.run_magnet_download(message)
        case "torrentFile":
            deps.run_torrent_download(message)
        case "pause" | "resume" | "cancel":
            deps.control_download(message, message_type)
        case "openFile":
            deps.open_download_path(message, reveal=False)
        case "showFile":
            deps.open_download_path(message, reveal=True)
        case "deleteArtifacts":
            deps.delete_download_artifacts(message)
        case "formats":
            deps.run_format_list(message)
        case "resolveMediaCandidates":
            deps.run_resolve_media_candidates(message)
        case "chooseFolder":
            deps.run_choose_folder(message)
        case "chooseTorrentFile":
            deps.run_choose_torrent_file(message)
        case "cdpStatus":
            deps.send_native_message(
                {
                    "type": "cdpStatusAck",
                    "id": deps.request_id(message),
                    "status": deps.capture_status() if hasattr(deps, "capture_status") else {},
                }
            )
        case "cdpCommand":
            deps.send_native_message(
                {
                    "type": "cdpCommandAck",
                    "id": deps.request_id(message),
                    "ok": True,
                    "message": "CDP command received and forwarded. Results arrive via the relay chain.",
                }
            )
        case _:
            raise deps.HostError(f"Unknown native host request type: {message_type}")


def main(deps):
    deps.configure_binary_stdio()
    while True:
        try:
            message = deps.read_native_message()
        except EOFError:
            return 0
        except Exception as exc:
            print(f"Native messaging protocol error: {exc}", file=sys.stderr)
            return 1

        request_id_value = deps.request_id(message)

        try:
            deps.handle_message(message)
        except deps.HostError as exc:
            deps.send_native_message(deps.error_response(request_id_value, exc))
        except Exception as exc:
            print(f"Unhandled host error: {exc}", file=sys.stderr)
            deps.send_native_message(deps.unexpected_error_response(request_id_value, exc))


def namespace(**values):
    return SimpleNamespace(**values)
