import sys
from types import SimpleNamespace


def dependency_status(deps):
    return {
        "ytDlp": deps.has_yt_dlp(),
        "ffmpeg": deps.has_ffmpeg(),
        "aria2c": deps.has_aria2c(),
        "nM3u8DlRe": deps.has_n_m3u8dl_re(),
        "streamlink": deps.has_streamlink(),
    }


def handle_message(message, deps):
    message_type = deps.request_type(message)

    match message_type:
        case "ping":
            deps.send_native_message(deps.pong_response(message, deps.host_version, deps.dependency_status()))
        case "download":
            deps.run_download(message)
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
