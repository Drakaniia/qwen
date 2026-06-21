import sys
from types import SimpleNamespace


def dependency_status(deps):
    status = {
        "ytDlp": deps.has_yt_dlp(),
        "ffmpeg": deps.has_ffmpeg(),
        "aria2c": deps.has_aria2c(),
        "gopeed": deps.has_gopeed(),
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
        case "gopeedMagnet":
            deps.run_gopeed_magnet_download(message)
        case "gopeedTorrent":
            deps.run_gopeed_torrent_download(message)
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
        case "enumeratePlaylist":
            deps.run_playlist_enumeration(message)
        case "resolveMediaCandidates":
            deps.run_resolve_media_candidates(message)
        case "chooseFolder":
            deps.run_choose_folder(message)
        case "chooseTorrentFile":
            deps.run_choose_torrent_file(message)
        case "startCdmCapture":
            # Forward CDM capture start to the extension (CDP work happens there)
            deps.send_native_message(
                {
                    "type": "cdmCaptureStarted",
                    "id": deps.request_id(message),
                    "tabId": message.get("tabId", 0),
                    "ok": True,
                    "message": "CDM capture request forwarded to extension.",
                }
            )
        case "stopCdmCapture":
            deps.send_native_message(
                {
                    "type": "cdmCaptureStopped",
                    "id": deps.request_id(message),
                    "tabId": message.get("tabId", 0),
                    "ok": True,
                    "message": "CDM capture stop forwarded to extension.",
                }
            )
        case "getCdmCaptures":
            deps.send_native_message(
                {
                    "type": "cdmCapturesResult",
                    "id": deps.request_id(message),
                    "ok": True,
                    "message": "CDM captures forwarded to extension. Query extension directly for full results.",
                }
            )
        case "cdmInit":
            # Initialize the Widevine CDM in the Go binary
            result = deps.run_cdm_init(message)
            deps.send_native_message(result)
        case "extractKeys":
            # Extract decryption keys from a captured license response
            result = deps.run_extract_keys(message)
            deps.send_native_message(result)
        case "decryptSegments":
            # Decrypt encrypted media segments with extracted keys
            result = deps.run_decrypt_segments(message)
            deps.send_native_message(result)
        case "assembleSegments":
            # Assemble decrypted segments into a final output file
            result = deps.run_assemble_segments(message)
            deps.send_native_message(result)
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
        case "cdpRelayResult" | "cdpRelayError":
            # Result from extension for a CDP relay command — forward to Go
            if hasattr(deps, "send_cdp_relay_result"):
                error_msg = message.get("error", "")
                print(
                    f"[cdpRelayResult] forwardId={message.get('forwardId', '')} ok={message.get('ok', False)}",
                    file=sys.stderr,
                )
                deps.send_cdp_relay_result(
                    forward_id=message.get("forwardId", ""),
                    result=message.get("result"),
                    error=error_msg,
                )
        case _:
            raise deps.HostError(f"Unknown native host request type: {message_type}")


def process_cdp_relay_forwards(deps):
    """Check for pending CDP relay forwards from Go and forward to extension.

    This is called from the main loop to handle async CDP commands that
    Go has pushed to stdout. The background reader in capture_manager
    puts them in a queue, and we forward them to the extension.
    """
    if not hasattr(deps, "get_pending_cdp_forward"):
        return

    while True:
        forward = deps.get_pending_cdp_forward(block=False)
        if forward is None:
            break

        forward_id = forward.get("id", "")
        forward_data = forward.get("data", {}) or {}
        tab_id = forward_data.get("tabId", 0)
        method = forward_data.get("method", "")
        params = forward_data.get("params", {})

        if hasattr(deps, "send_native_message"):
            deps.send_native_message(
                {
                    "type": "cdpRelayForward",
                    "id": forward.get("id", ""),
                    "tabId": tab_id,
                    "method": method,
                    "params": params,
                    "forwardId": forward_id,
                }
            )


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

        # After handling each message, check for any pending CDP forwards from Go
        try:
            process_cdp_relay_forwards(deps)
        except Exception as exc:
            print(f"Error processing CDP relay forwards: {exc}", file=sys.stderr)


def namespace(**values):
    return SimpleNamespace(**values)
