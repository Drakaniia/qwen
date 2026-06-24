"""CDM (Content Decryption Module) API for Widevine key extraction and segment decryption.

Extracted from capture_manager.py for modularity. These functions wrap the Go
binary's CDM commands (cdmInit, extractKeys, decryptSegments, assembleSegments)
through the CaptureManager singleton.

Uses lazy imports internally to avoid circular imports with capture_manager.py.
"""

from native_protocol import HostError


def cdm_init(cdm_path, timeout=15.0):
    """Initialize the Widevine CDM at the given path.

    Sends a 'cdmInit' command to the Go binary.

    Args:
        cdm_path: Path to the directory containing widevinecdm.dll.
        timeout: Maximum seconds to wait for a response.

    Returns:
        Dict with keys: ok, cdmVersion, l1Only, error (if any).
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    try:
        response = manager.send_command(
            "cdmInit",
            data={"cdmPath": cdm_path},
            timeout=timeout,
        )
        return {
            "ok": response.get("ok", False),
            "cdmVersion": response.get("cdmVersion", ""),
            "l1Only": response.get("l1Only", False),
            "cdmPath": response.get("cdmPath", ""),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "error": str(exc)}


def extract_keys(session_id, response_b64, challenge_b64="", init_data_b64="", timeout=30.0):
    """Extract decryption keys from a Widevine license response.

    Sends an 'extractKeys' command to the Go binary with the captured
    license exchange data from CDP network interception.

    Args:
        session_id: Opaque session identifier from the license exchange.
        response_b64: Base64-encoded license response body.
        challenge_b64: Optional base64-encoded license challenge (POST body).
        init_data_b64: Optional base64-encoded PSSH init data.
        timeout: Maximum seconds to wait for key extraction.

    Returns:
        Dict with keys: ok, sessionId, keys (list of DecryptionKey), l1Only, error.
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "sessionId": session_id,
        "responseB64": response_b64,
    }
    if challenge_b64:
        data["challengeB64"] = challenge_b64
    if init_data_b64:
        data["initDataB64"] = init_data_b64

    try:
        response = manager.send_command("extractKeys", data=data, timeout=timeout)
        return {
            "ok": response.get("ok", False),
            "sessionId": response.get("sessionId", session_id),
            "keys": response.get("keys", []),
            "l1Only": response.get("l1Only", False),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "sessionId": session_id, "keys": [], "error": str(exc)}


def decrypt_segments(job_id, segments, keys, output_dir="", timeout=60.0):
    """Decrypt encrypted media segments using provided keys.

    Sends a 'decryptSegments' command to the Go binary.

    Args:
        job_id: Identifier for this decryption job.
        segments: List of dicts with streamId, index, dataB64, mimeType, isLast.
        keys: List of dicts with keyIdB64, keyB64, type.
        output_dir: Optional directory for decrypted outputs.
        timeout: Maximum seconds to wait for decryption.

    Returns:
        Dict with keys: ok, jobId, decrypted (count), segmentPaths, error.
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "jobId": job_id,
        "segments": segments,
        "keys": keys,
    }
    if output_dir:
        data["outputDir"] = output_dir

    try:
        response = manager.send_command("decryptSegments", data=data, timeout=timeout)
        return {
            "ok": response.get("ok", False),
            "jobId": response.get("jobId", job_id),
            "decrypted": response.get("decrypted", 0),
            "segmentPaths": response.get("segmentPaths", []),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "jobId": job_id, "decrypted": 0, "error": str(exc)}


def assemble_segments(job_id, file_paths, output_path, timeout=60.0):
    """Assemble decrypted segment files into a single output file.

    Sends an 'assembleSegments' command to the Go binary.

    Args:
        job_id: Identifier for this assembly job.
        file_paths: List of file paths to decrypted segments.
        output_path: Path for the assembled output file.
        timeout: Maximum seconds to wait for assembly.

    Returns:
        Dict with keys: ok, jobId, filePath, error.
    """
    # Lazy import to avoid circular dependency
    from capture_manager import get_capture_manager

    manager = get_capture_manager()
    if not manager.is_running:
        manager.start()

    data = {
        "jobId": job_id,
        "filePaths": file_paths,
        "outputPath": output_path,
    }

    try:
        response = manager.send_command("assembleSegments", data=data, timeout=timeout)
        return {
            "ok": response.get("ok", False),
            "jobId": response.get("jobId", job_id),
            "filePath": response.get("filePath", ""),
            "error": response.get("error", ""),
        }
    except HostError as exc:
        return {"ok": False, "jobId": job_id, "error": str(exc)}
